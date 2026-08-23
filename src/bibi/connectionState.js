/**
 * Honest availability reporting for the local Mac connector.
 *
 * The upstream product optimistically treated the primary profile as running
 * whenever the workspace had loaded at all. That is exactly the wrong default
 * here: the Mac sleeps, the connector stops, and a profile can be absent. When
 * this module lacks evidence that a profile is reachable it says OFFLINE or
 * UNKNOWN and queues the work. It never infers "running" from a missing signal.
 */

import { isBibiProfileId, toExecutionProfileId } from "./roster.js";

/** How often the connector is expected to check in. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Two missed beats still counts as online; laptops jitter. */
export const ONLINE_LIMIT_MS = HEARTBEAT_INTERVAL_MS * 2;
/** Beyond six missed beats the Mac is gone, not slow. */
export const STALE_LIMIT_MS = HEARTBEAT_INTERVAL_MS * 6;

export const CONNECTOR_STATE = Object.freeze({
  ONLINE: "online",
  STALE: "stale",
  OFFLINE: "offline",
  UNKNOWN: "unknown",
});

export const DISPATCH_MODE = Object.freeze({
  LIVE: "live",
  QUEUED: "queued",
  BLOCKED: "blocked",
});

const CONNECTOR_LABELS = Object.freeze({
  [CONNECTOR_STATE.ONLINE]: "ONLINE · 로컬 Mac 연결됨",
  [CONNECTOR_STATE.STALE]: "STALE · 응답 지연",
  [CONNECTOR_STATE.OFFLINE]: "OFFLINE · 로컬 Mac 연결 없음",
  [CONNECTOR_STATE.UNKNOWN]: "UNKNOWN · 아직 보고 없음",
});

export function describeConnectorHealth({
  lastHeartbeatAt,
  now = Date.now(),
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
} = {}) {
  const timestamp = typeof lastHeartbeatAt === "string" ? Date.parse(lastHeartbeatAt) : NaN;
  if (!Number.isFinite(timestamp)) {
    return {
      state: CONNECTOR_STATE.UNKNOWN,
      ageMs: null,
      canDispatchLive: false,
      label: CONNECTOR_LABELS[CONNECTOR_STATE.UNKNOWN],
      lastHeartbeatAt: null,
    };
  }

  // Clock skew must never make a heartbeat look fresher than the present.
  const ageMs = Math.max(0, now - timestamp);
  const state = ageMs <= heartbeatIntervalMs * 2
    ? CONNECTOR_STATE.ONLINE
    : ageMs <= heartbeatIntervalMs * 6
      ? CONNECTOR_STATE.STALE
      : CONNECTOR_STATE.OFFLINE;

  return {
    state,
    ageMs,
    canDispatchLive: state === CONNECTOR_STATE.ONLINE,
    label: CONNECTOR_LABELS[state],
    lastHeartbeatAt: new Date(timestamp).toISOString(),
  };
}

/**
 * @param {object} options
 * @param {string} options.profileId organisational role slot, bibi-01..bibi-18.
 * @param {string[]} options.reportedProfileIds *physical* profiles the connector
 *   observed on the Mac. The role slot is translated before it is looked up, so
 *   bibi-01 is satisfied by `default` and never by the rollback `bibi-01`
 *   directory.
 */
export function describeProfileAvailability({ profileId, health, reportedProfileIds } = {}) {
  const executionProfileId = toExecutionProfileId(profileId);
  if (!isBibiProfileId(profileId) || !executionProfileId) {
    return {
      profileId: profileId ?? null,
      executionProfileId: null,
      available: false,
      dispatch: DISPATCH_MODE.BLOCKED,
      reason: "PROFILE_NOT_IN_ROSTER",
      label: "BLOCKED · 로스터에 없는 프로필",
      detail: "bibi-01부터 bibi-18까지의 조직 역할만 사용할 수 있습니다. 일반 프로필로 대체하지 않습니다.",
    };
  }

  const connectorState = health?.state ?? CONNECTOR_STATE.UNKNOWN;

  if (connectorState !== CONNECTOR_STATE.ONLINE) {
    const unknown = connectorState === CONNECTOR_STATE.UNKNOWN;
    return {
      profileId,
      executionProfileId,
      available: false,
      dispatch: DISPATCH_MODE.QUEUED,
      reason: unknown ? "CONNECTOR_UNKNOWN" : "CONNECTOR_OFFLINE",
      label: unknown ? "OFFLINE · 아직 보고 없음" : "OFFLINE · 로컬 Mac 연결 없음",
      detail: "로컬 Mac이 연결되어 있지 않습니다. 지금 맡기는 업무는 대기열에 저장되고 Mac이 돌아오면 실행됩니다.",
    };
  }

  const reported = Array.isArray(reportedProfileIds) ? reportedProfileIds : [];
  if (!reported.includes(executionProfileId)) {
    return {
      profileId,
      executionProfileId,
      available: false,
      dispatch: DISPATCH_MODE.QUEUED,
      reason: "PROFILE_NOT_REPORTED",
      label: "OFFLINE · 프로필 보고 없음",
      detail: `로컬 Mac은 연결되어 있지만 실행 프로필 '${executionProfileId}'이(가) 명단에 없습니다. 업무는 대기열에 저장됩니다.`,
    };
  }

  return {
    profileId,
    executionProfileId,
    available: true,
    dispatch: DISPATCH_MODE.LIVE,
    reason: null,
    label: "ONLINE · 온라인",
    detail: `로컬 Mac의 '${executionProfileId}' 프로필이 바로 업무를 받을 수 있습니다.`,
  };
}
