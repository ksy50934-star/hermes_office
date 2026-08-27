/**
 * What the chat surface may honestly say about the Telegram bridge.
 *
 * Production right now has seven web-origin conversations, zero bindings, zero
 * checkpoints and zero projected messages. A badge that said "동기화됨" over
 * that state would be a lie, and a badge that said nothing would leave the owner
 * with no idea why their Telegram history is missing. So every state below
 * names the thing that is actually true and the one action that would move it
 * forward.
 *
 * The rules this encodes:
 *
 *   * No binding means no sync. Not "pending sync", not "connecting" — the
 *     conversation is web-only and the copy says so.
 *   * A pending binding is a request, not a connection. The browser cannot
 *     complete it, and the copy says who can.
 *   * A verified binding with no checkpoint has moved nothing yet, and is
 *     reported that way rather than as a working mirror.
 *   * When session discovery did not work, onboarding is unavailable and the
 *     reason is given. It never falls back to asking the owner to type a raw
 *     identifier, because an identifier the connector cannot confirm produces a
 *     binding that will only ever be refused.
 */

import { CONNECTOR_STATE } from "./connectionState.js";

export const BRIDGE_STATE = Object.freeze({
  /** No binding row at all: the conversation lives only in the web workspace. */
  NONE: "none",
  /** The owner asked; the connector has not proved it. */
  PENDING: "pending",
  /** The connector proved the exact session identity. */
  VERIFIED: "verified",
  /** The connector looked and refused. */
  BLOCKED: "blocked",
  /** The owner disconnected it. Messages already received are kept. */
  UNBOUND: "unbound",
});

export const DISCOVERY_STATE = Object.freeze({
  /** The connector could not produce a list, and said why. */
  UNAVAILABLE: "unavailable",
  /** The connector looked and this profile has no connectable Telegram session. */
  EMPTY: "empty",
  /** There is at least one session the owner can connect. */
  READY: "ready",
});

const DISCOVERY_REASONS = Object.freeze({
  CONNECTOR_NEVER_REPORTED: "로컬 Mac 커넥터(맥에서 바깥으로만 연결하는 연동 프로그램)가 아직 한 번도 보고하지 않았습니다. 연결 가능한 Telegram 대화를 확인할 방법이 없어 목록을 만들지 않습니다.",
  CONNECTOR_OFFLINE: "로컬 Mac 커넥터가 지금 연결되어 있지 않습니다. 아래 목록은 마지막 보고 시점의 내용이며, 연결 확인은 Mac이 돌아온 뒤에 진행됩니다.",
  NEVER_SCANNED: "커넥터는 보고 중이지만 이 프로필의 Telegram 세션(대화 한 건의 저장 단위)을 아직 훑지 않았습니다. 잠시 후 다시 확인해 주세요.",
  STATE_DB_UNREADABLE: "커넥터가 이 프로필의 로컬 대화 저장소(state.db)를 읽지 못했습니다. Mac에서 프로필 홈 경로와 접근 권한을 확인해야 합니다.",
  SESSIONS_TABLE_UNSUPPORTED: "로컬 Hermes 대화 저장소의 구조가 달라 Telegram 세션을 식별할 수 없습니다. 커넥터를 최신 버전으로 올려야 합니다.",
  TELEGRAM_IDENTITY_COLUMNS_MISSING: "로컬 Hermes가 Telegram 대화 주소(어느 계정의 어느 채팅인지)를 저장하고 있지 않습니다. 확정할 수 없는 값을 지어내지 않으므로 연결을 시작할 수 없습니다.",
  NO_ELIGIBLE_SESSIONS: "커넥터가 확인했지만 이 프로필에는 연결할 수 있는 Telegram 세션이 없습니다.",
});

const VERIFICATION_REASONS = Object.freeze({
  PROFILE_UNAVAILABLE: "이 실행 프로필이 Mac에 없어 확인하지 못했습니다.",
  DISCOVERY_UNAVAILABLE: "커넥터가 로컬 대화 저장소를 읽지 못해 확인하지 못했습니다.",
  SESSION_NOT_FOUND: "요청한 Telegram 세션을 이 프로필의 로컬 기록에서 찾지 못했습니다.",
  SESSION_SOURCE_MISMATCH: "그 세션은 Telegram에서 시작된 대화가 아닙니다.",
  SESSION_ARCHIVED: "그 세션은 이미 보관 처리되어 이어갈 수 없습니다.",
  SESSION_EXPIRED: "그 세션은 만료되어 이어갈 수 없습니다.",
  SESSION_PROFILE_MISMATCH: "그 세션은 다른 실행 프로필의 것입니다.",
  SESSION_UNVERIFIABLE: "커넥터가 세션 정보를 읽지 못해 증명할 수 없었습니다.",
  INVALID_SESSION_ID: "세션 식별자 형식이 올바르지 않습니다.",
  IDENTITY_MISMATCH: "그 세션이 실제로 연결된 Telegram 대화가 요청한 대화와 다릅니다.",
  IDENTITY_INCOMPLETE: "그 세션에는 Telegram 대화 주소가 기록되어 있지 않아 같은 대화임을 증명할 수 없습니다.",
});

function timeText(value) {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat("ko", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(parsed));
}

/**
 * Which Telegram sessions this profile can actually offer, and why not when the
 * answer is none.
 *
 * A session is offerable only when the connector reported a complete Telegram
 * address for it. An incomplete one is counted and reported, not listed: it
 * would produce a binding the verifier is guaranteed to refuse.
 */
export function describeTelegramDiscovery({
  sessions = [],
  scans = [],
  executionProfileId = null,
  connectorHealth = null,
} = {}) {
  const scan = scans.find((row) => row.execution_profile_id === executionProfileId) ?? null;
  const profileSessions = sessions.filter((row) => row.execution_profile_id === executionProfileId);
  const eligible = profileSessions.filter((row) => row.identity_complete && row.session_state === "active");
  const connectorState = connectorHealth?.state ?? CONNECTOR_STATE.UNKNOWN;

  const base = {
    scannedAt: scan?.scanned_at ?? null,
    scannedAtLabel: timeText(scan?.scanned_at),
    sessions: eligible,
    incompleteCount: profileSessions.length - eligible.length,
    connectorState,
  };

  if (!scan) {
    const reason = connectorState === CONNECTOR_STATE.UNKNOWN ? "CONNECTOR_NEVER_REPORTED" : "NEVER_SCANNED";
    return { ...base, state: DISCOVERY_STATE.UNAVAILABLE, reason, detail: DISCOVERY_REASONS[reason], sessions: [] };
  }
  if (scan.scan_error) {
    const reason = DISCOVERY_REASONS[scan.scan_error] ? scan.scan_error : "SESSIONS_TABLE_UNSUPPORTED";
    return {
      ...base,
      state: DISCOVERY_STATE.UNAVAILABLE,
      reason: scan.scan_error,
      detail: DISCOVERY_REASONS[reason],
      // A scan that failed on identity columns can still have listed sessions,
      // but none of them are connectable, so none of them are offered.
      sessions: eligible.length && scan.scan_error !== "TELEGRAM_IDENTITY_COLUMNS_MISSING" ? eligible : [],
    };
  }
  if (!eligible.length) {
    return { ...base, state: DISCOVERY_STATE.EMPTY, reason: "NO_ELIGIBLE_SESSIONS", detail: DISCOVERY_REASONS.NO_ELIGIBLE_SESSIONS };
  }
  return {
    ...base,
    state: DISCOVERY_STATE.READY,
    reason: connectorState === CONNECTOR_STATE.ONLINE ? null : "CONNECTOR_OFFLINE",
    detail: connectorState === CONNECTOR_STATE.ONLINE ? null : DISCOVERY_REASONS.CONNECTOR_OFFLINE,
  };
}

function projectionText(checkpoint) {
  if (!checkpoint || Number(checkpoint.last_source_message_id ?? 0) === 0) {
    return "아직 이 대화로 반영된 Telegram 메시지가 없습니다.";
  }
  const at = timeText(checkpoint.updated_at);
  return `마지막 반영: Telegram 메시지 #${checkpoint.last_source_message_id}${at ? ` · ${at}` : ""}`;
}

/**
 * The whole honest state of one conversation's bridge, as the chat panel shows
 * it: connector health, where the conversation came from, whether a binding
 * exists and what state it is in, whether mirroring is on, what the last
 * projection moved, and the one thing the owner could do next.
 */
export function describeConversationBridge({
  conversation = null,
  binding = null,
  checkpoint = null,
  connectorHealth = null,
  discovery = null,
} = {}) {
  const connectorState = connectorHealth?.state ?? CONNECTOR_STATE.UNKNOWN;
  const connectorOnline = connectorState === CONNECTOR_STATE.ONLINE;
  const originChannel = conversation?.origin_channel ?? "web";
  const discoveryReady = discovery?.state === DISCOVERY_STATE.READY;

  const shared = {
    connectorState,
    connectorLabel: connectorHealth?.label ?? "UNKNOWN · 아직 보고 없음",
    originChannel,
    originLabel: originChannel === "telegram" ? "Telegram에서 시작" : "웹에서 시작",
    syncStatus: conversation?.sync_status ?? "UNKNOWN",
    syncError: conversation?.sync_error ?? null,
    mirroringEnabled: Boolean(conversation?.telegram_mirroring_enabled),
    bindingId: binding?.id ?? null,
    hermesSessionId: binding?.hermes_session_id ?? null,
    externalConversationId: binding?.external_conversation_id ?? null,
    projectionLabel: projectionText(checkpoint),
    checkpointStatus: checkpoint?.sync_status ?? null,
    checkpointError: checkpoint?.last_error ?? null,
    canRequest: false,
    canRetry: false,
    canDisconnect: false,
  };

  if (!binding) {
    return {
      ...shared,
      state: BRIDGE_STATE.NONE,
      label: "Telegram 연결 없음",
      detail: discoveryReady
        ? "이 대화는 웹에만 있습니다. 아래에서 연결할 Telegram 대화를 고르면 연결 요청이 시작됩니다."
        : `이 대화는 웹에만 있습니다. Telegram 동기화는 시작되지 않았습니다. ${discovery?.detail ?? ""}`.trim(),
      projectionLabel: "아직 이 대화로 반영된 Telegram 메시지가 없습니다.",
      canRequest: discoveryReady,
    };
  }

  if (binding.binding_state === "pending") {
    return {
      ...shared,
      state: BRIDGE_STATE.PENDING,
      label: "Telegram 연결 확인 대기",
      detail: connectorOnline
        ? "연결 요청이 저장됐습니다. 로컬 Mac 커넥터가 Telegram 세션 신원을 직접 증명해야 연결이 완료됩니다. 브라우저는 이 확인을 대신할 수 없습니다."
        : "연결 요청이 저장됐습니다. 확인은 로컬 Mac 커넥터만 할 수 있는데 지금 연결되어 있지 않아, Mac이 돌아올 때까지 대기 상태로 남습니다.",
      canDisconnect: true,
    };
  }

  if (binding.binding_state === "verified") {
    const failing = checkpoint?.sync_status === "failed" || checkpoint?.sync_status === "blocked";
    return {
      ...shared,
      state: BRIDGE_STATE.VERIFIED,
      label: "Telegram 연결됨",
      detail: failing
        ? `연결은 확인됐지만 최근 반영이 실패했습니다: ${checkpoint?.last_error ?? "원인이 보고되지 않았습니다."}`
        : connectorOnline
          ? "커넥터가 이 Telegram 세션의 신원을 증명했습니다. 새 메시지는 커넥터가 올릴 때 이 타임라인에 나타납니다."
          : "연결은 확인됐지만 로컬 Mac이 지금 연결되어 있지 않아 새 Telegram 메시지는 반영되지 않습니다.",
      canDisconnect: true,
    };
  }

  if (binding.binding_state === "blocked") {
    const code = binding.verification_code ?? null;
    const reason = VERIFICATION_REASONS[code] ?? binding.verification_error ?? "커넥터가 원인을 보고하지 않았습니다.";
    return {
      ...shared,
      state: BRIDGE_STATE.BLOCKED,
      label: "Telegram 연결 확인 실패",
      detail: `커넥터가 이 연결을 증명하지 못했습니다: ${reason}`,
      canRetry: discoveryReady,
      canDisconnect: true,
    };
  }

  return {
    ...shared,
    state: BRIDGE_STATE.UNBOUND,
    label: "Telegram 연결 해제됨",
    detail: "연결을 해제했습니다. 이미 받은 대화 내용은 그대로 남아 있고, 새 Telegram 메시지만 더 이상 들어오지 않습니다.",
    canRequest: discoveryReady,
  };
}

/** One line describing an offerable session, without quoting anything it contains. */
export function describeEligibleSession(session) {
  const at = timeText(session?.last_activity_at);
  return {
    id: session?.id ?? session?.hermes_session_id ?? "",
    hermesSessionId: session?.hermes_session_id ?? "",
    channelAccountId: session?.channel_account_id ?? "",
    externalConversationId: session?.external_conversation_id ?? "",
    title: `Telegram 대화 ${session?.external_conversation_id ?? "?"}`,
    detail: `메시지 ${Number(session?.message_count ?? 0)}개${at ? ` · 마지막 활동 ${at}` : ""}`,
  };
}
