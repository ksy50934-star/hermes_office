/**
 * Owner-initiated work transitions: assign, cancel, block, unblock.
 *
 * These are not client writes. The browser holds an insert policy on work_items
 * and nothing more, so every state change after intake comes through here and is
 * validated by the same lifecycle reducer the connector reports are validated
 * by. One state machine, one place it is enforced.
 */

import { WorkLifecycleError, applyWorkEvent } from "../../src/bibi/workLifecycle.js";
import { authenticateUser } from "../_lib/userAuth.js";
import { createServiceRoleClient, createWorkspaceStore } from "../_lib/store.js";

const OWNER_EVENTS = new Set(["assign", "cancel", "block", "unblock"]);

function sendJson(response, status, body) {
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.send(JSON.stringify(body));
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }

  let supabase;
  try {
    supabase = createServiceRoleClient(process.env);
  } catch (error) {
    sendJson(response, 500, { error: error.code ?? "SERVER_MISCONFIGURED", message: error.message });
    return;
  }

  const auth = await authenticateUser({ headers: request.headers, supabase });
  if (!auth.ok) {
    sendJson(response, auth.status, { error: auth.code, message: auth.message });
    return;
  }

  const body = request.body ?? {};
  const type = String(body.type ?? "").trim();
  const workItemId = String(body.workItemId ?? "").trim();
  const eventId = String(body.eventId ?? "").trim();

  if (!OWNER_EVENTS.has(type)) {
    sendJson(response, 400, { error: "UNSUPPORTED_EVENT", message: `'${type}' is not an owner action.` });
    return;
  }
  if (!workItemId || !eventId) {
    sendJson(response, 400, { error: "INVALID_REQUEST", message: "workItemId and eventId are required." });
    return;
  }

  const store = createWorkspaceStore(supabase);

  try {
    const work = await store.loadWorkItem({ ownerId: auth.ownerId, workItemId });
    // Scoped by owner: another account's work item reads as absent.
    if (!work) {
      sendJson(response, 404, { error: "WORK_ITEM_NOT_FOUND" });
      return;
    }

    const at = new Date().toISOString();
    const { duplicate } = await store.recordEvent({
      ownerId: auth.ownerId,
      workItemId,
      eventId,
      eventType: type,
      payload: body,
      at,
    });
    if (duplicate) {
      sendJson(response, 200, { ok: true, duplicate: true, status: work.status });
      return;
    }

    const next = applyWorkEvent(work, {
      id: eventId,
      type,
      at,
      profileId: body.profileId,
      reason: body.reason,
    });

    if (type === "cancel") {
      await store.releaseLease({ ownerId: auth.ownerId, workItemId, reason: "cancelled", at });
    }
    await store.saveWorkItem({ ownerId: auth.ownerId, work: next });
    sendJson(response, 200, { ok: true, duplicate: false, status: next.status });
  } catch (error) {
    if (error instanceof WorkLifecycleError) {
      sendJson(response, 409, { error: error.code, message: error.message });
      return;
    }
    sendJson(response, 500, { error: "INTERNAL_ERROR", message: error.message });
  }
}
