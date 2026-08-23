/**
 * Connector API handlers.
 *
 * These are plain functions over a store interface rather than Vercel request
 * handlers, so the lifecycle rules they enforce can be tested without a
 * database or a running function.
 *
 * The invariant they exist to hold: the control plane, not the connector, is
 * the authority on work state. The connector reports what happened; the handler
 * decides whether that report is a legal transition, and records the event
 * before applying it so a replay is a duplicate rather than a second effect.
 */

import { WorkLifecycleError, applyWorkEvent } from "../../src/bibi/workLifecycle.js";
import { isExecutionProfileId, toExecutionProfileId } from "../../src/bibi/roster.js";

const REPORT_TYPES = new Set(["start", "succeed", "fail", "release", "block"]);

function failure(status, code, message) {
  return { status, body: { error: code, message } };
}

function success(body) {
  return { status: 200, body };
}

export async function handleHeartbeat({ auth, body, store, now = () => new Date().toISOString() }) {
  const reported = Array.isArray(body?.reportedProfileIds) ? body.reportedProfileIds : [];
  // The connector reports *physical* profiles. Anything that is not one the
  // workspace may execute on is dropped rather than stored: an upstream generic
  // profile, an unknown identifier, or the rollback `profiles/bibi-01`
  // directory, which is not any Bibi's runtime.
  const reportedProfileIds = reported.filter(isExecutionProfileId);

  await store.recordHeartbeat({
    ownerId: auth.ownerId,
    connectorNodeId: auth.connectorNodeId,
    label: String(body?.nodeLabel ?? "local-mac"),
    reportedProfileIds,
    localRuntimeReachable: Boolean(body?.localRuntimeReachable),
    at: now(),
  });

  return success({
    ok: true,
    acceptedProfileIds: reportedProfileIds,
    droppedProfileIds: reported.filter((id) => !isExecutionProfileId(id)),
  });
}

export async function handlePoll({ auth, body, store, now = () => new Date().toISOString(), leaseTtlMs = 300_000, maxBatch = 4 }) {
  const requested = Number(body?.max);
  const max = Number.isInteger(requested) && requested > 0 ? Math.min(requested, maxBatch) : maxBatch;

  // The store grants the lease in the same statement that selects the work, so
  // two connector nodes cannot both receive the same item.
  const leased = await store.claimWork({
    ownerId: auth.ownerId,
    connectorNodeId: auth.connectorNodeId,
    max,
    leaseTtlMs,
    at: now(),
  });

  return success({
    commands: leased.map((item) => ({
      id: `${item.workItemId}:${item.attempt}`,
      workItemId: item.workItemId,
      type: "execute",
      attempt: item.attempt,
      profileId: item.profileId,
      // The connector needs the physical profile, but the role slot is what the
      // work belongs to, so both are sent and neither is derived twice.
      executionProfileId: toExecutionProfileId(item.profileId),
      // A chat turn is prompted differently from a deliberate work item, so the
      // executor has to be able to tell them apart.
      kind: item.kind ?? "work",
      conversationId: item.conversationId ?? null,
      title: item.title,
      brief: item.brief,
      leaseId: item.leaseId,
      leaseExpiresAt: item.leaseExpiresAt,
    })),
  });
}

export async function handleRenewLease({ auth, body, store, now = () => new Date().toISOString(), leaseTtlMs = 300_000 }) {
  const leaseId = String(body?.leaseId ?? "").trim();
  const workItemId = String(body?.workItemId ?? "").trim();
  if (!leaseId || !workItemId) return failure(400, "INVALID_REQUEST", "leaseId and workItemId are required.");

  const renewed = await store.renewLease({
    ownerId: auth.ownerId,
    connectorNodeId: auth.connectorNodeId,
    leaseId,
    workItemId,
    expiresAt: new Date(Date.parse(now()) + leaseTtlMs).toISOString(),
  });

  // A lease that has already expired or been taken over must not be revived;
  // the work has been returned to the queue and may be running elsewhere.
  if (!renewed) return failure(409, "LEASE_LOST", "The lease is no longer held by this connector.");
  return success({ leaseExpiresAt: renewed.expiresAt });
}

export async function handleReport({ auth, body, store, now = () => new Date().toISOString() }) {
  const eventId = String(body?.id ?? "").trim();
  const type = String(body?.type ?? "").trim();
  const workItemId = String(body?.workItemId ?? "").trim();

  if (!eventId || !workItemId) return failure(400, "INVALID_REQUEST", "id and workItemId are required.");
  if (!REPORT_TYPES.has(type)) return failure(400, "UNSUPPORTED_EVENT", `A connector may not report '${type}'.`);

  const work = await store.loadWorkItem({ ownerId: auth.ownerId, workItemId });
  // Scoped by owner, so a valid token for another account yields "not found"
  // rather than someone else's work item.
  if (!work) return failure(404, "WORK_ITEM_NOT_FOUND", "No such work item for this connector.");

  // Record first. The unique (work_item_id, event_id) constraint is what makes
  // a redelivered report a no-op instead of a second transition.
  const { duplicate } = await store.recordEvent({
    ownerId: auth.ownerId,
    workItemId,
    eventId,
    eventType: type,
    payload: body,
    at: now(),
  });
  if (duplicate) return success({ ok: true, duplicate: true, status: work.status });

  let next;
  try {
    next = applyWorkEvent(work, {
      id: eventId,
      type,
      at: now(),
      error: body?.error,
      reason: body?.reason,
      resultId: body?.resultId ?? null,
    });
  } catch (error) {
    if (error instanceof WorkLifecycleError) {
      return failure(409, error.code, error.message);
    }
    throw error;
  }

  if (type === "succeed") {
    const result = await store.insertResult({
      ownerId: auth.ownerId,
      workItemId,
      summary: String(body?.summary ?? ""),
      detail: String(body?.detail ?? ""),
      at: now(),
    });
    next = { ...next, resultId: result.id };
    const evidence = Array.isArray(body?.evidence) ? body.evidence : [];
    if (evidence.length) {
      await store.insertEvidence({
        ownerId: auth.ownerId,
        workItemId,
        // Recorded on the evidence itself so a stored artifact always says which
        // physical profile produced it, not only which role slot owns it.
        executionProfileId: toExecutionProfileId(work.profileId),
        evidence,
        at: now(),
      });
    }
  }

  // A chat turn is only answered once its command succeeds, and the reply goes
  // back into the conversation that asked. The write is keyed on the work item,
  // so a redelivered success cannot post a second answer.
  if (type === "succeed" && work.kind === "chat") {
    await store.insertAssistantMessage({
      ownerId: auth.ownerId,
      workItemId,
      body: String(body?.summary ?? ""),
      at: now(),
    });
  }

  if (["succeed", "fail", "release"].includes(type)) {
    await store.releaseLease({ ownerId: auth.ownerId, workItemId, reason: type, at: now() });
  }

  await store.saveWorkItem({ ownerId: auth.ownerId, work: next });
  return success({ ok: true, duplicate: false, status: next.status });
}

/**
 * Send one chat turn.
 *
 * The user's message and the command that will answer it are created together
 * by `bibi_send_chat_message`, so there is no window in which a question exists
 * with nothing assigned to answer it. `clientMessageId` makes the whole thing
 * idempotent: a resend after a dropped response returns the original pair.
 */
export async function handleChatSend({ auth, body, store }) {
  const conversationId = String(body?.conversationId ?? "").trim();
  const clientMessageId = String(body?.clientMessageId ?? "").trim();
  const message = typeof body?.body === "string" ? body.body.trim() : "";

  if (!conversationId || !clientMessageId) {
    return failure(400, "INVALID_REQUEST", "conversationId and clientMessageId are required.");
  }
  if (!message) {
    return failure(400, "EMPTY_MESSAGE", "A chat message cannot be empty.");
  }

  try {
    const result = await store.sendChatMessage({
      ownerId: auth.ownerId,
      conversationId,
      clientMessageId,
      body: message,
    });
    return success({
      ok: true,
      duplicate: result.duplicate,
      messageId: result.messageId,
      workItemId: result.workItemId,
    });
  } catch (error) {
    if (error.code === "CONVERSATION_NOT_FOUND") {
      return failure(404, "CONVERSATION_NOT_FOUND", "No such conversation for this account.");
    }
    throw error;
  }
}
