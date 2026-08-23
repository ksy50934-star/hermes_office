/**
 * Durable work lifecycle for the Bibi Workspace.
 *
 * A work item is created once at intake and then only ever moves by applying an
 * event. Two properties matter more than the state chart itself:
 *
 *  - Every event carries an id, and an id is applied at most once. The connector
 *    reconnects, retries and replays; without this a reconnect would double a
 *    retry counter or re-run a finished job.
 *  - A lost lease is not a failure. It returns the work to `assigned` with the
 *    assignment intact, because the Mac going to sleep mid-task is normal and
 *    must not silently discard the user's request.
 */

import { isBibiProfileId } from "./roster.js";

export const WORK_STATUS = Object.freeze({
  INTAKE: "intake",
  ASSIGNED: "assigned",
  LEASED: "leased",
  RUNNING: "running",
  BLOCKED: "blocked",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const TERMINAL_STATUSES = Object.freeze([
  WORK_STATUS.SUCCEEDED,
  WORK_STATUS.FAILED,
  WORK_STATUS.CANCELLED,
]);

const TERMINAL_SET = new Set(TERMINAL_STATUSES);

export function isTerminalStatus(status) {
  return TERMINAL_SET.has(status);
}

export class WorkLifecycleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WorkLifecycleError";
    this.code = code;
  }
}

const ALLOWED_FROM = Object.freeze({
  assign: [WORK_STATUS.INTAKE, WORK_STATUS.ASSIGNED, WORK_STATUS.BLOCKED],
  lease: [WORK_STATUS.ASSIGNED],
  start: [WORK_STATUS.LEASED],
  succeed: [WORK_STATUS.RUNNING],
  fail: [WORK_STATUS.LEASED, WORK_STATUS.RUNNING],
  release: [WORK_STATUS.LEASED, WORK_STATUS.RUNNING],
  block: [WORK_STATUS.ASSIGNED, WORK_STATUS.LEASED, WORK_STATUS.RUNNING],
  unblock: [WORK_STATUS.BLOCKED],
  cancel: [
    WORK_STATUS.INTAKE,
    WORK_STATUS.ASSIGNED,
    WORK_STATUS.LEASED,
    WORK_STATUS.RUNNING,
    WORK_STATUS.BLOCKED,
  ],
});

function requiredText(value, message, code) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new WorkLifecycleError(message, code);
  return text;
}

export function createWorkItem({
  id,
  ownerId,
  clientRequestId,
  title,
  brief = "",
  profileId = null,
  createdAt = null,
} = {}) {
  const workId = requiredText(id, "업무 ID가 필요합니다.", "MISSING_ID");
  const owner = requiredText(ownerId, "업무 소유자가 필요합니다.", "MISSING_OWNER");
  const requestId = requiredText(
    clientRequestId,
    "클라이언트 요청 ID가 필요합니다. 재접속 시 중복 생성을 막는 값입니다.",
    "MISSING_CLIENT_REQUEST_ID",
  );
  const workTitle = requiredText(title, "업무 제목이 필요합니다.", "MISSING_TITLE");

  if (profileId !== null && !isBibiProfileId(profileId)) {
    throw new WorkLifecycleError(`'${profileId}'은(는) 실제 bibi 프로필이 아닙니다.`, "INVALID_PROFILE");
  }

  return {
    id: workId,
    ownerId: owner,
    clientRequestId: requestId,
    title: workTitle,
    brief: typeof brief === "string" ? brief : "",
    status: profileId ? WORK_STATUS.ASSIGNED : WORK_STATUS.INTAKE,
    profileId,
    leaseId: null,
    nodeId: null,
    leaseExpiresAt: null,
    attempt: 0,
    resultId: null,
    error: null,
    blockedReason: null,
    createdAt: createdAt ?? null,
    updatedAt: createdAt ?? null,
    appliedEventIds: [],
  };
}

function assertTransition(work, type) {
  const allowed = ALLOWED_FROM[type];
  if (!allowed) throw new WorkLifecycleError(`알 수 없는 이벤트 '${type}'입니다.`, "UNKNOWN_EVENT");
  if (isTerminalStatus(work.status)) {
    throw new WorkLifecycleError(
      `이미 종료된 업무(${work.status})에는 '${type}' 이벤트를 적용할 수 없습니다.`,
      "TERMINAL_WORK_ITEM",
    );
  }
  if (!allowed.includes(work.status)) {
    throw new WorkLifecycleError(
      `'${work.status}' 상태에서는 '${type}' 이벤트를 적용할 수 없습니다.`,
      "INVALID_TRANSITION",
    );
  }
}

const CLEARED_LEASE = { leaseId: null, nodeId: null, leaseExpiresAt: null };

function transition(work, event) {
  switch (event.type) {
    case "assign": {
      const profileId = typeof event.profileId === "string" ? event.profileId.trim() : "";
      if (!isBibiProfileId(profileId)) {
        throw new WorkLifecycleError(
          `'${profileId}'은(는) 실제 bibi 프로필이 아닙니다. 일반 프로필로 대체하지 않습니다.`,
          "INVALID_PROFILE",
        );
      }
      return { status: WORK_STATUS.ASSIGNED, profileId, blockedReason: null, ...CLEARED_LEASE };
    }
    case "lease": {
      const leaseId = requiredText(event.leaseId, "리스 ID가 필요합니다.", "MISSING_LEASE");
      const nodeId = requiredText(event.nodeId, "커넥터 노드 ID가 필요합니다.", "MISSING_NODE");
      const leaseExpiresAt = requiredText(
        event.leaseExpiresAt,
        "리스 만료 시각이 필요합니다.",
        "MISSING_LEASE_EXPIRY",
      );
      return { status: WORK_STATUS.LEASED, leaseId, nodeId, leaseExpiresAt };
    }
    case "start":
      return { status: WORK_STATUS.RUNNING, attempt: work.attempt + 1 };
    case "succeed":
      return {
        status: WORK_STATUS.SUCCEEDED,
        resultId: typeof event.resultId === "string" ? event.resultId : null,
        error: null,
        ...CLEARED_LEASE,
      };
    case "fail":
      return {
        status: WORK_STATUS.FAILED,
        error: requiredText(event.error, "실패 사유가 필요합니다.", "MISSING_REASON"),
        ...CLEARED_LEASE,
      };
    case "release":
      return { status: WORK_STATUS.ASSIGNED, ...CLEARED_LEASE };
    case "block":
      return {
        status: WORK_STATUS.BLOCKED,
        blockedReason: requiredText(event.reason, "보류 사유가 필요합니다.", "MISSING_REASON"),
        ...CLEARED_LEASE,
      };
    case "unblock":
      return { status: WORK_STATUS.ASSIGNED, blockedReason: null };
    case "cancel":
      return {
        status: WORK_STATUS.CANCELLED,
        blockedReason: null,
        ...CLEARED_LEASE,
      };
    default:
      throw new WorkLifecycleError(`알 수 없는 이벤트 '${event.type}'입니다.`, "UNKNOWN_EVENT");
  }
}

/**
 * Apply one event and return a new work item. Replaying an already-applied
 * event id returns the input unchanged.
 */
export function applyWorkEvent(work, event) {
  if (!event || typeof event !== "object") {
    throw new WorkLifecycleError("이벤트 객체가 필요합니다.", "MISSING_EVENT");
  }
  const eventId = requiredText(
    event.id,
    "이벤트 ID가 필요합니다. 재전송 시 중복 적용을 막는 값입니다.",
    "MISSING_EVENT_ID",
  );
  if (work.appliedEventIds.includes(eventId)) return work;

  assertTransition(work, event.type);
  const patch = transition(work, event);

  return {
    ...work,
    ...patch,
    updatedAt: typeof event.at === "string" && event.at ? event.at : work.updatedAt,
    appliedEventIds: [...work.appliedEventIds, eventId],
  };
}

export function reduceWorkEvents(work, events = []) {
  return events.reduce((current, event) => applyWorkEvent(current, event), work);
}
