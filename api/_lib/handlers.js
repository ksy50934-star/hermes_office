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

import { isBibiProfileId, isExecutionProfileId, toExecutionProfileId } from "../../src/bibi/roster.js";
import { ProjectionError, validateProjectionTarget } from "../../connector/messageProjection.js";

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

function boundedText(value, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function boundedList(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function boundedDocumentDirectories(value) {
  return boundedList(value, 2000).flatMap((entry) => {
    const directory = boundedText(entry, 500).replace(/\\/g, "/");
    const parts = directory.split("/");
    if (!directory || directory.startsWith("/") || parts.length > 12
      || parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return [];
    return [directory];
  });
}

export async function handleRuntimeProjection({ auth, body, store }) {
  const profileId = body?.profileId;
  const executionProfileId = body?.executionProfileId;
  const collectedAt = body?.collectedAt;
  if (!isBibiProfileId(profileId) || !isExecutionProfileId(executionProfileId)
    || toExecutionProfileId(profileId) !== executionProfileId
    || !Number.isFinite(Date.parse(collectedAt ?? ""))) {
    return failure(400, "INVALID_RUNTIME_PROJECTION_IDENTITY", "Runtime projection profile identity is invalid.");
  }

  const inventory = {
    catalog: boundedList(body?.inventory?.catalog, 100).map((item) => ({
      name: boundedText(item?.name, 120), label: boundedText(item?.label, 200),
      description: boundedText(item?.description, 500), category: boundedText(item?.category, 80),
      provider: boundedText(item?.provider, 120), needs_config: Boolean(item?.needs_config), installed: Boolean(item?.installed),
    })).filter((item) => item.name),
    servers: boundedList(body?.inventory?.servers, 100).map((item) => ({
      name: boundedText(item?.name, 120), label: boundedText(item?.label, 200),
      status: boundedText(item?.status, 80), transport: boundedText(item?.transport, 300),
      enabled: Boolean(item?.enabled), tools: boundedList(item?.tools, 200).map((tool) => boundedText(tool, 120)).filter(Boolean),
    })).filter((item) => item.name),
    toolsets: boundedList(body?.inventory?.toolsets, 100).map((item) => ({
      name: boundedText(item?.name, 120), label: boundedText(item?.label, 200),
      description: boundedText(item?.description, 500), enabled: Boolean(item?.enabled),
      available: item?.available !== false, configured: item?.configured !== false,
      tools: boundedList(item?.tools, 200).map((tool) => boundedText(tool, 120)).filter(Boolean),
    })).filter((item) => item.name),
    errors: boundedList(body?.inventory?.errors, 20).map((item) => ({
      source: boundedText(item?.source, 80), message: boundedText(item?.message, 300),
    })),
  };
  const gatewayStatus = new Set(["running", "stopped", "unknown", "error"]).has(body?.health?.gatewayStatus)
    ? body.health.gatewayStatus : "unknown";
  const activeSessions = Number.isInteger(body?.health?.activeSessions) && body.health.activeSessions >= 0
    ? body.health.activeSessions : null;
  const health = {
    hermesVersion: boundedText(body?.health?.hermesVersion, 80) || null,
    model: boundedText(body?.health?.model, 200) || null,
    provider: boundedText(body?.health?.provider, 120) || null,
    gatewayStatus,
    activeSessions,
    enabledToolsets: Math.max(0, Number.parseInt(body?.health?.enabledToolsets ?? 0, 10) || 0),
    disabledToolsets: Math.max(0, Number.parseInt(body?.health?.disabledToolsets ?? 0, 10) || 0),
    error: boundedText(body?.health?.error, 500) || null,
  };

  const documentTree = {
    directories: boundedDocumentDirectories(body?.documentTree?.directories),
    collectionError: boundedText(body?.documentTree?.collectionError, 120) || null,
  };

  await store.upsertRuntimeProjection({
    ownerId: auth.ownerId,
    connectorNodeId: auth.connectorNodeId,
    profileId,
    inventory,
    health,
    documentTree,
    collectedAt,
  });
  return success({ ok: true, profileId, collectedAt });
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
      bindingId: item.bindingId ?? null,
      hermesSessionId: item.hermesSessionId ?? null,
      channelOrigin: item.channelOrigin ?? null,
      continuationStatus: item.continuationStatus ?? "unbound",
      resumeLeaseId: item.resumeLeaseId ?? null,
      turnIdempotencyKey: item.turnIdempotencyKey ?? null,
      title: item.title,
      brief: item.brief,
      leaseId: item.leaseId,
      leaseExpiresAt: item.leaseExpiresAt,
    })),
  });
}

export async function handleProjectionTargets({ auth, store }) {
  const targets = await store.listProjectionTargets({
    ownerId: auth.ownerId,
    connectorNodeId: auth.connectorNodeId,
  });
  return success({ targets });
}

export async function handleProjectionUpload({ auth, body, store }) {
  let target;
  try {
    target = validateProjectionTarget(body?.target);
  } catch (error) {
    if (error instanceof ProjectionError) return failure(400, error.code, error.message);
    throw error;
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length || messages.length > 500) {
    return failure(400, "INVALID_PROJECTION_BATCH", "Projection batch must contain 1 to 500 messages.");
  }
  for (const message of messages) {
    const sameIdentity = message?.bindingId === target.bindingId
      && message?.conversationId === target.conversationId
      && message?.organizationProfileId === target.organizationProfileId
      && message?.executionProfileId === target.executionProfileId
      && message?.hermesSessionId === target.hermesSessionId
      && message?.channel === target.channel;
    const validMessage = sameIdentity
      && (message?.role === "user" || message?.role === "assistant")
      && Number.isSafeInteger(message?.sourceMessageId)
      && Number.isSafeInteger(message?.sourceSequence)
      && typeof message?.body === "string"
      && message.body.length > 0
      && /^[0-9a-f]{64}$/.test(message?.contentSha256 ?? "")
      && Number.isFinite(Date.parse(message?.sourceTimestamp ?? ""));
    if (!validMessage) {
      return failure(400, "PROJECTION_IDENTITY_MISMATCH", "Projection message does not match its verified binding.");
    }
  }

  const result = await store.applyProjection({ ownerId: auth.ownerId, target, messages });
  return success({ ok: true, ...result });
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

  try {
    const result = await store.applyReportAtomically({
      ownerId: auth.ownerId,
      connectorNodeId: auth.connectorNodeId,
      workItemId,
      eventId,
      type,
      attempt: body?.attempt,
      turnIdempotencyKey: body?.turnIdempotencyKey ?? null,
      summary: String(body?.summary ?? ""),
      detail: String(body?.detail ?? ""),
      error: body?.error ?? null,
      reason: body?.reason ?? null,
      evidence: Array.isArray(body?.evidence) ? body.evidence : [],
      payload: body,
      at: now(),
    });
    return success({ ok: true, duplicate: Boolean(result.duplicate), status: result.status });
  } catch (error) {
    if (error?.code === "WORK_ITEM_NOT_FOUND") return failure(404, error.code, "No such work item for this connector.");
    if (["INVALID_TRANSITION", "MISSING_REASON", "REPORT_IDENTITY_MISMATCH"].includes(error?.code)) {
      return failure(409, error.code, error.message);
    }
    throw error;
  }
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
