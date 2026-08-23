/**
 * Data adapter between the workspace UI and Supabase.
 *
 * Reads go straight to PostgREST under row level security, so the browser can
 * only ever see its own rows. Writes are split deliberately: intake and the
 * user's own chat turn are direct inserts the RLS policies allow, while every
 * state transition goes through `/api/work/transition` so the lifecycle stays
 * enforced in one place.
 *
 * Nothing here reads a local file, a profile directory or a credential. The
 * browser's entire view of the Mac is what the connector chose to report.
 */

import { getSupabaseClient } from "./supabaseBrowser.js";
import { BIBI_PROFILE_IDS } from "../bibi/roster.js";
import { describeConnectorHealth } from "../bibi/connectionState.js";

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("클라우드 워크스페이스가 아직 설정되지 않았습니다.");
  return supabase;
}

function unwrap(result, context) {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data ?? [];
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function getSession() {
  const { data } = await client().auth.getSession();
  return data?.session ?? null;
}

export function onAuthStateChange(callback) {
  const { data } = client().auth.onAuthStateChange((_event, session) => callback(session));
  return () => data?.subscription?.unsubscribe();
}

export function signInWithPassword(email, password) {
  return client().auth.signInWithPassword({ email, password });
}

export function signOut() {
  return client().auth.signOut();
}

async function authorizedHeaders() {
  const session = await getSession();
  if (!session?.access_token) throw new Error("로그인이 만료되었습니다. 다시 로그인해 주세요.");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`,
  };
}

// ---------------------------------------------------------------------------
// Roster and connector health
// ---------------------------------------------------------------------------

export async function loadRoster() {
  return unwrap(
    await client()
      .from("bibi_profiles")
      .select("id, ordinal, execution_profile, display_name, role, mandate, role_source, is_primary_surface")
      .order("ordinal"),
    "loadRoster",
  );
}

/**
 * The connector's own view of itself, plus the derived health the UI shows.
 * With no connector row at all the health is UNKNOWN, never online.
 */
export async function loadConnectorState() {
  const nodes = unwrap(
    await client()
      .from("connector_nodes")
      .select("id, label, status, last_heartbeat_at, reported_profile_ids, connector_mode, updated_at")
      .order("last_heartbeat_at", { ascending: false, nullsFirst: false })
      .limit(1),
    "loadConnectorState",
  );

  const node = nodes[0] ?? null;
  return {
    node,
    health: describeConnectorHealth({ lastHeartbeatAt: node?.last_heartbeat_at ?? null }),
    reportedProfileIds: Array.isArray(node?.reported_profile_ids) ? node.reported_profile_ids : [],
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function loadConversations(profileId) {
  return unwrap(
    await client()
      .from("conversations")
      .select("id, profile_id, title, last_message_at, created_at")
      .eq("profile_id", profileId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(50),
    "loadConversations",
  );
}

export async function loadMessages(conversationId) {
  return unwrap(
    await client()
      .from("messages")
      .select("id, role, body, created_at, client_message_id, profile_id")
      .eq("conversation_id", conversationId)
      .order("created_at")
      .limit(500),
    "loadMessages",
  );
}

export async function startConversation({ ownerId, profileId, title = "" }) {
  const rows = unwrap(
    await client()
      .from("conversations")
      .insert({ owner_id: ownerId, profile_id: profileId, title })
      .select("id, profile_id, title, created_at"),
    "startConversation",
  );
  return rows[0];
}

/**
 * Send a chat turn.
 *
 * This goes through the API rather than straight to the table, because the
 * message and the command that will answer it have to be created together. A
 * message written on its own would be a question nothing is assigned to answer.
 *
 * `clientMessageId` is the idempotency key: a resend after a dropped response
 * returns the original turn and its original command instead of asking twice.
 */
export async function sendUserMessage({ conversationId, body, clientMessageId = randomId() }) {
  const response = await fetch("/api/chat/send", {
    method: "POST",
    headers: await authorizedHeaders(),
    body: JSON.stringify({ conversationId, clientMessageId, body }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? `메시지를 보내지 못했습니다 (${response.status})`);
  }
  return {
    messageId: payload.messageId,
    workItemId: payload.workItemId,
    duplicate: Boolean(payload.duplicate),
    clientMessageId,
  };
}

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

export async function loadWorkItems({ limit = 100 } = {}) {
  return unwrap(
    await client()
      .from("work_items")
      .select("id, profile_id, kind, title, brief, status, attempt, error, blocked_reason, result_id, lease_expires_at, created_at, updated_at")
      // Chat dispatch uses the same table and the same lifecycle, but it is not
      // deliberate work; showing it here would bury the board under every
      // sentence the user typed.
      .eq("kind", "work")
      .order("created_at", { ascending: false })
      .limit(limit),
    "loadWorkItems",
  );
}

/**
 * The chat commands behind one conversation. The chat panel uses these to show
 * a turn that is still running, or one that failed, instead of leaving the user
 * waiting on a reply that is never coming.
 */
export async function loadChatDispatch(conversationId) {
  return unwrap(
    await client()
      .from("work_items")
      .select("id, status, attempt, error, request_message_id, created_at")
      .eq("kind", "chat")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(50),
    "loadChatDispatch",
  );
}

export async function loadWorkDetail(workItemId) {
  const supabase = client();
  const [events, results, evidence] = await Promise.all([
    supabase.from("work_events").select("id, event_id, event_type, payload, created_at")
      .eq("work_item_id", workItemId).order("created_at"),
    supabase.from("work_results").select("id, summary, detail, created_at")
      .eq("work_item_id", workItemId).order("created_at"),
    supabase.from("work_evidence").select("id, kind, label, sha256, byte_size, storage_path, inline_excerpt, execution_profile_id, created_at")
      .eq("work_item_id", workItemId).order("created_at"),
  ]);
  return {
    events: unwrap(events, "loadWorkDetail.events"),
    results: unwrap(results, "loadWorkDetail.results"),
    evidence: unwrap(evidence, "loadWorkDetail.evidence"),
  };
}

/**
 * File work. `clientRequestId` is generated once per submission and reused on
 * retry, so a flaky network cannot create the same job twice — the unique
 * (owner_id, client_request_id) constraint absorbs the second attempt.
 */
export async function fileWork({ ownerId, profileId, title, brief = "", clientRequestId = randomId() }) {
  if (profileId !== null && !BIBI_PROFILE_IDS.includes(profileId)) {
    throw new Error(`'${profileId}'은(는) 실제 bibi 프로필이 아닙니다.`);
  }

  const { data, error } = await client()
    .from("work_items")
    .insert({
      owner_id: ownerId,
      profile_id: profileId,
      client_request_id: clientRequestId,
      title,
      brief,
    })
    .select("id, profile_id, title, brief, status, created_at")
    .maybeSingle();

  // 23505 is the intake idempotency key doing its job: the first submission
  // already landed, so return that one instead of surfacing an error.
  if (error?.code === "23505") {
    const existing = unwrap(
      await client()
        .from("work_items")
        .select("id, profile_id, title, brief, status, created_at")
        .eq("client_request_id", clientRequestId)
        .limit(1),
      "fileWork.existing",
    );
    return { workItem: existing[0] ?? null, duplicate: true };
  }
  if (error) throw new Error(`fileWork: ${error.message}`);
  return { workItem: data, duplicate: false };
}

/** Every post-intake transition goes through the API, never straight to the table. */
export async function transitionWork({ workItemId, type, profileId = null, reason = null, eventId = randomId() }) {
  const response = await fetch("/api/work/transition", {
    method: "POST",
    headers: await authorizedHeaders(),
    body: JSON.stringify({ workItemId, type, profileId, reason, eventId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `업무 상태를 바꾸지 못했습니다 (${response.status})`);
  return payload;
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/**
 * Subscribe to the tables the workspace renders. Realtime respects RLS, so this
 * only ever delivers the signed-in owner's rows.
 *
 * `onResync` fires when the socket reconnects: realtime gives no replay of what
 * was missed while the tab was asleep, so the caller must refetch rather than
 * assume its cache is still current.
 */
export function subscribeToWorkspace({ onWorkItem, onWorkEvent, onMessage, onConnector, onResync } = {}) {
  const supabase = getSupabaseClient();
  if (!supabase) return () => {};

  let connectedOnce = false;
  const channel = supabase.channel("bibi-workspace");

  const bind = (table, handler) => {
    if (!handler) return;
    channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
      handler(payload.new ?? payload.old, payload);
    });
  };

  bind("work_items", onWorkItem);
  bind("work_events", onWorkEvent);
  bind("messages", onMessage);
  bind("connector_nodes", onConnector);

  channel.subscribe((status) => {
    if (status !== "SUBSCRIBED") return;
    if (connectedOnce) onResync?.();
    connectedOnce = true;
  });

  return () => {
    supabase.removeChannel(channel);
  };
}
