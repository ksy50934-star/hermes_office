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
import { WorkLifecycleError, applyWorkEvent } from "../../src/bibi/workLifecycle.js";
import { ProjectionError, validateProjectionTarget } from "../../connector/messageProjection.js";

const REPORT_TYPES = new Set(["start", "succeed", "fail", "release", "block"]);
const OWNER_EVENTS = new Set(["assign", "cancel", "block", "unblock"]);

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

// ---------------------------------------------------------------------------
// Telegram binding onboarding
// ---------------------------------------------------------------------------

/** Identity values are opaque strings, but they are not unbounded ones. */
function identityText(value, max = 200) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max ? text : "";
}

const BINDING_STATUS = Object.freeze({
  BINDING_NOT_FOUND: 404,
  BINDING_CONFLICT: 409,
  BINDING_IDENTITY_MISMATCH: 409,
  BINDING_VERIFICATION_FORBIDDEN: 403,
  BINDING_INVALID_REQUEST: 400,
});

function bindingFailure(error) {
  const status = BINDING_STATUS[error?.code];
  if (!status) return null;
  return failure(status, error.code, error.message);
}

/**
 * The owner asking for a Telegram thread to be connected.
 *
 * Everything this route can produce is a `pending` request. There is no field
 * here that names a binding state, and the RPC behind it hard-codes `pending`,
 * so no shape of browser input reaches `verified`. Proof is the connector's job
 * and it happens on a different route with a different credential.
 */
export async function handleConversationBinding({ auth, body, store }) {
  const action = String(body?.action ?? "request").trim();

  if (action === "cancel") {
    const bindingId = identityText(body?.bindingId, 64);
    if (!bindingId) return failure(400, "INVALID_REQUEST", "bindingId is required.");
    try {
      const result = await store.cancelConversationBinding({
        ownerId: auth.ownerId,
        bindingId,
        reason: identityText(body?.reason, 300) || "owner disconnected the Telegram binding",
      });
      return success({ ok: true, ...result });
    } catch (error) {
      const mapped = bindingFailure(error);
      if (!mapped) throw error;
      return mapped;
    }
  }

  // `retry` and `request` are the same operation: the RPC returns an existing
  // row untouched, and moves a blocked or cancelled one back to pending.
  if (action !== "request" && action !== "retry") {
    return failure(400, "UNSUPPORTED_ACTION", `'${action}' is not a binding action.`);
  }

  const conversationId = identityText(body?.conversationId, 64);
  const channel = identityText(body?.channel, 20) || "telegram";
  const channelAccountId = identityText(body?.channelAccountId);
  const externalConversationId = identityText(body?.externalConversationId);
  const hermesSessionId = identityText(body?.hermesSessionId);
  const clientRequestId = identityText(body?.clientRequestId, 120) || null;

  if (!conversationId) return failure(400, "INVALID_REQUEST", "conversationId is required.");
  if (channel !== "telegram") {
    return failure(400, "UNSUPPORTED_CHANNEL", "Only Telegram bindings can be requested.");
  }
  if (!channelAccountId || !externalConversationId || !hermesSessionId) {
    // The onboarding UI only offers sessions the connector reported complete
    // identities for, so this is the guard for a hand-made request.
    return failure(400, "INCOMPLETE_BINDING_IDENTITY", "The Telegram session identity is incomplete.");
  }

  try {
    const result = await store.requestConversationBinding({
      ownerId: auth.ownerId,
      conversationId,
      channel,
      channelAccountId,
      externalConversationId,
      hermesSessionId,
      clientRequestId,
    });
    return success({ ok: true, ...result });
  } catch (error) {
    const mapped = bindingFailure(error);
    if (!mapped) throw error;
    return mapped;
  }
}

export async function handlePendingBindings({ auth, store }) {
  const bindings = await store.listPendingBindings({ ownerId: auth.ownerId });
  return success({ bindings });
}

/**
 * The connector's verdict on one pending binding.
 *
 * A positive verdict has to name back the exact identity it proved. The RPC
 * compares it against the stored request and refuses a mismatch, so a connector
 * that verified some other session cannot have that count as proof of this one.
 */
export async function handleBindingVerification({ auth, body, store }) {
  const bindingId = identityText(body?.bindingId, 64);
  if (!bindingId) return failure(400, "INVALID_REQUEST", "bindingId is required.");

  if (body?.verified !== true) {
    const code = identityText(body?.code, 80);
    if (!code) return failure(400, "INVALID_REQUEST", "A refused verification needs a reason code.");
    try {
      const result = await store.failConversationBinding({
        ownerId: auth.ownerId,
        connectorNodeId: auth.connectorNodeId,
        bindingId,
        code,
        detail: identityText(body?.detail, 500) || null,
      });
      return success({ ok: true, verified: false, ...result });
    } catch (error) {
      const mapped = bindingFailure(error);
      if (!mapped) throw error;
      return mapped;
    }
  }

  const channelAccountId = identityText(body?.channelAccountId);
  const externalConversationId = identityText(body?.externalConversationId);
  const hermesSessionId = identityText(body?.hermesSessionId);
  const executionProfileId = identityText(body?.executionProfileId, 40);
  if (!channelAccountId || !externalConversationId || !hermesSessionId
    || !isExecutionProfileId(executionProfileId)) {
    return failure(400, "INCOMPLETE_VERIFICATION_IDENTITY", "The verification must name the identity it proved.");
  }

  const evidence = body?.evidence && typeof body.evidence === "object" && !Array.isArray(body.evidence)
    ? {
        sessionState: identityText(body.evidence.sessionState, 40) || null,
        messageCount: Number.isInteger(body.evidence.messageCount) ? body.evidence.messageCount : null,
        lastActivityAt: Number.isFinite(Date.parse(body.evidence.lastActivityAt ?? "")) ? body.evidence.lastActivityAt : null,
        verifiedVia: identityText(body.evidence.verifiedVia, 120) || null,
      }
    : {};

  try {
    const result = await store.verifyConversationBinding({
      ownerId: auth.ownerId,
      connectorNodeId: auth.connectorNodeId,
      bindingId,
      channelAccountId,
      externalConversationId,
      hermesSessionId,
      executionProfileId,
      evidence,
    });
    return success({ ok: true, verified: true, ...result });
  } catch (error) {
    const mapped = bindingFailure(error);
    if (!mapped) throw error;
    return mapped;
  }
}

/**
 * Eligible Telegram sessions as the connector found them.
 *
 * The accepted shape is identity and reachability only. A body, a title or an
 * excerpt sent here would simply be dropped: there is no column to put it in and
 * no field of this payload that carries it.
 */
export async function handleTelegramSessionDiscovery({ auth, body, store, now = () => new Date().toISOString() }) {
  const organizationProfileId = identityText(body?.organizationProfileId, 40);
  const executionProfileId = identityText(body?.executionProfileId, 40);
  if (!isBibiProfileId(organizationProfileId) || !isExecutionProfileId(executionProfileId)
    || toExecutionProfileId(organizationProfileId) !== executionProfileId) {
    return failure(400, "INVALID_DISCOVERY_IDENTITY", "Telegram discovery profile identity is invalid.");
  }

  const sessions = boundedList(body?.sessions, 200).flatMap((session) => {
    const hermesSessionId = identityText(session?.hermesSessionId);
    if (!hermesSessionId) return [];
    const sessionState = ["active", "archived", "expired"].includes(session?.sessionState)
      ? session.sessionState : "active";
    const lastActivityAt = Number.isFinite(Date.parse(session?.lastActivityAt ?? ""))
      ? session.lastActivityAt : null;
    return [{
      hermesSessionId,
      channelAccountId: identityText(session?.channelAccountId) || null,
      externalConversationId: identityText(session?.externalConversationId) || null,
      sessionState,
      messageCount: Math.max(0, Number.parseInt(session?.messageCount ?? 0, 10) || 0),
      lastActivityAt,
    }];
  });

  const result = await store.recordTelegramSessionScan({
    ownerId: auth.ownerId,
    connectorNodeId: auth.connectorNodeId,
    organizationProfileId,
    executionProfileId,
    sessions,
    scanError: identityText(body?.scanError, 200) || null,
    scannedAt: Number.isFinite(Date.parse(body?.scannedAt ?? "")) ? body.scannedAt : now(),
  });
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

/** Owner-only work transitions, sharing the same lifecycle reducer as reports. */
export async function handleWorkTransition({ auth, body, store, now = () => new Date().toISOString() }) {
  const type = String(body?.type ?? "").trim();
  const workItemId = String(body?.workItemId ?? "").trim();
  const eventId = String(body?.eventId ?? "").trim();
  if (!OWNER_EVENTS.has(type)) return failure(400, "UNSUPPORTED_EVENT", `'${type}' is not an owner action.`);
  if (!workItemId || !eventId) return failure(400, "INVALID_REQUEST", "workItemId and eventId are required.");

  const work = await store.loadWorkItem({ ownerId: auth.ownerId, workItemId });
  if (!work) return failure(404, "WORK_ITEM_NOT_FOUND", "No such work item for this owner.");

  const at = now();
  const { duplicate } = await store.recordEvent({
    ownerId: auth.ownerId, workItemId, eventId, eventType: type, payload: body, at,
  });
  if (duplicate) return success({ ok: true, duplicate: true, status: work.status });

  try {
    const next = applyWorkEvent(work, {
      id: eventId, type, at, profileId: body.profileId, reason: body.reason,
    });
    if (type === "cancel") {
      await store.releaseLease({ ownerId: auth.ownerId, workItemId, reason: "cancelled", at });
    }
    await store.saveWorkItem({ ownerId: auth.ownerId, work: next });
    return success({ ok: true, duplicate: false, status: next.status });
  } catch (error) {
    if (error instanceof WorkLifecycleError) return failure(409, error.code, error.message);
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
