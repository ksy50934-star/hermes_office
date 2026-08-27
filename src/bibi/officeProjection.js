/**
 * The one honest projection of Office work.
 *
 * Everything the Office, the right-hand panel, the mobile Office, the agent
 * consoles and the work board show about *work* is derived here, from rows the
 * browser actually read back. Nothing in this module invents a title, a due
 * date, a percentage or an activity line.
 *
 * Three rules it exists to enforce:
 *
 *  - Only `kind = "work"` is deliberate work. Chat dispatch and meeting
 *    participation use the same table and the same lifecycle, but a sentence
 *    typed into a chat box is not a job the user filed. Counting them was what
 *    turned two real work items into thirty-eight.
 *  - Progress is a position in the canonical lifecycle, not a completion
 *    percentage. `running` is stage four of five; it is not "65%". Nobody knows
 *    how much of a job is done, so this module does not say.
 *  - Absence is a state with a name. Loading, empty, offline, stale and error
 *    are each reported explicitly, so a surface never renders "nothing to do"
 *    when what it means is "not read yet".
 */

import { CONNECTOR_STATE } from "./connectionState.js";
import { TERMINAL_STATUSES, WORK_STATUS, isTerminalStatus } from "./workLifecycle.js";
import { bibiProfile, toExecutionProfileId } from "./roster.js";

/** The `work_items.kind` discriminator. Only one of these is deliberate work. */
export const WORK_KIND = Object.freeze({
  WORK: "work",
  CHAT: "chat",
  MEETING: "meeting",
});

/** What a work surface is currently able to say. */
export const OFFICE_STATE = Object.freeze({
  LOADING: "loading",
  ERROR: "error",
  READY: "ready",
});

/**
 * What the right-hand panel and the board are showing. Distinct from
 * `OFFICE_STATE` because "read successfully, and there is nothing" and "read
 * successfully, but the Mac is gone" are different things to tell the user.
 */
export const WORK_VIEW_STATE = Object.freeze({
  LOADING: "loading",
  ERROR: "error",
  OFFLINE: "offline",
  STALE: "stale",
  EMPTY: "empty",
  READY: "ready",
});

/** Exact 1:1 copy for the canonical statuses. No status is renamed or merged. */
export const WORK_STATUS_LABELS = Object.freeze({
  [WORK_STATUS.INTAKE]: "접수됨",
  [WORK_STATUS.ASSIGNED]: "배정됨",
  [WORK_STATUS.LEASED]: "실행 준비",
  [WORK_STATUS.RUNNING]: "실행 중",
  [WORK_STATUS.BLOCKED]: "보류",
  [WORK_STATUS.SUCCEEDED]: "완료",
  [WORK_STATUS.FAILED]: "실패",
  [WORK_STATUS.CANCELLED]: "취소됨",
});

/**
 * One plain sentence per status, written for someone who has never read the
 * state chart. The right-hand panel renders this next to every item it shows,
 * because a list of statuses nobody can interpret is the same as no list.
 */
export const WORK_STATUS_MEANINGS = Object.freeze({
  [WORK_STATUS.INTAKE]: "맡겨졌지만 아직 담당자가 정해지지 않았습니다.",
  [WORK_STATUS.ASSIGNED]: "담당자가 정해졌고 로컬 Mac이 가져가기를 기다리는 중입니다.",
  [WORK_STATUS.LEASED]: "로컬 Mac이 이 업무를 가져갔고 곧 실행합니다.",
  [WORK_STATUS.RUNNING]: "로컬 Mac에서 실제로 실행되는 중입니다.",
  [WORK_STATUS.BLOCKED]: "보류되었습니다. 아래 사유가 풀려야 다시 진행됩니다.",
  [WORK_STATUS.SUCCEEDED]: "실행이 끝났고 결과가 저장되었습니다.",
  [WORK_STATUS.FAILED]: "실행이 실패했습니다. 아래 오류가 실제 실패 사유입니다.",
  [WORK_STATUS.CANCELLED]: "사용자가 취소했습니다. 실행되지 않았습니다.",
});

/**
 * The canonical chain a work item walks. `blocked` is deliberately not on it:
 * a blocked item stopped somewhere, and the row does not record where, so this
 * module reports "정지" rather than guessing a stage.
 */
export const LIFECYCLE_STAGES = Object.freeze([
  WORK_STATUS.INTAKE,
  WORK_STATUS.ASSIGNED,
  WORK_STATUS.LEASED,
  WORK_STATUS.RUNNING,
]);

/** Lifecycle positions, including the single terminal position at the end. */
export const LIFECYCLE_STAGE_COUNT = LIFECYCLE_STAGES.length + 1;

/** The four transitions an owner may actually request. Everything else is the connector's. */
export const OWNER_EVENTS = Object.freeze(["assign", "block", "unblock", "cancel"]);

const OWNER_EVENT_SOURCES = Object.freeze({
  assign: [WORK_STATUS.INTAKE, WORK_STATUS.ASSIGNED, WORK_STATUS.BLOCKED],
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

/** How long a snapshot may go unrefreshed before the surface calls it stale. */
export const SNAPSHOT_STALE_AFTER_MS = 90_000;

export class OfficeProjectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "OfficeProjectionError";
    this.code = code;
  }
}

function isWorkStatus(value) {
  return Object.values(WORK_STATUS).includes(value);
}

function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Deliberate work only.
 *
 * Strict equality against `"work"`, not "anything that is not chat": a row whose
 * kind the client has never heard of is a row this build cannot classify, and
 * counting it as deliberate work is exactly the failure being fixed here.
 */
export function deliberateWork(workItems = []) {
  return (workItems ?? []).filter((item) => item?.kind === WORK_KIND.WORK);
}

/** What was left out, and under which kind, so a surface can say so out loud. */
export function excludedWorkKinds(workItems = []) {
  const counts = { meeting: 0, chat: 0, other: 0, total: 0 };
  for (const item of workItems ?? []) {
    if (!item || item.kind === WORK_KIND.WORK) continue;
    counts.total += 1;
    if (item.kind === WORK_KIND.MEETING) counts.meeting += 1;
    else if (item.kind === WORK_KIND.CHAT) counts.chat += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * Where a work item stands in the canonical chain.
 *
 * Returns a stage index, never a percentage. `percent` is present and always
 * `null` so a caller that reaches for it finds an explicit absence rather than
 * an undefined it might render as `undefined%`.
 */
export function describeWorkStage(status) {
  const terminal = isTerminalStatus(status);
  if (terminal) {
    return {
      index: LIFECYCLE_STAGE_COUNT,
      count: LIFECYCLE_STAGE_COUNT,
      label: `${LIFECYCLE_STAGE_COUNT}/${LIFECYCLE_STAGE_COUNT} 단계 · 종료`,
      complete: true,
      percent: null,
      basis: "lifecycle",
    };
  }
  if (status === WORK_STATUS.BLOCKED) {
    return {
      index: null,
      count: LIFECYCLE_STAGE_COUNT,
      label: "진행 단계 정지 · 보류",
      complete: false,
      percent: null,
      // The row records that it is blocked, not where it stopped. Saying which
      // stage it paused at would be a guess.
      basis: "unknown",
    };
  }
  const index = LIFECYCLE_STAGES.indexOf(status);
  if (index === -1) {
    return { index: null, count: LIFECYCLE_STAGE_COUNT, label: "알 수 없는 상태", complete: false, percent: null, basis: "unknown" };
  }
  return {
    index: index + 1,
    count: LIFECYCLE_STAGE_COUNT,
    label: `${index + 1}/${LIFECYCLE_STAGE_COUNT} 단계 · ${WORK_STATUS_LABELS[status]}`,
    complete: false,
    percent: null,
    basis: "lifecycle",
  };
}

/** Which owner actions the lifecycle would actually accept from this status. */
export function ownerActionsFor(status) {
  return Object.fromEntries(
    OWNER_EVENTS.map((event) => [event, (OWNER_EVENT_SOURCES[event] ?? []).includes(status)]),
  );
}

function assigneeLabel(profileId) {
  if (!profileId) return "미배정";
  const profile = bibiProfile(profileId);
  return profile ? `${profile.id} · ${profile.displayName}` : profileId;
}

/**
 * One work row as every Office surface should see it.
 *
 * Fields are either read off the row or explicitly `null`. There is no branch
 * in here that substitutes prose for a value the database did not have.
 */
export function projectWorkCard(item, { rosterById = null } = {}) {
  if (!item?.id) throw new OfficeProjectionError("업무 행에 id가 없습니다.", "MISSING_ID");
  const status = isWorkStatus(item.status) ? item.status : null;
  const profileId = text(item.profile_id) || null;
  const rosterRow = profileId && rosterById ? rosterById.get(profileId) ?? null : null;
  const updatedAt = item.updated_at ?? item.created_at ?? null;

  return {
    id: item.id,
    kind: WORK_KIND.WORK,
    // `work_items.title` is NOT NULL and intake refuses a blank one, so there is
    // nothing here to fall back to. A row that somehow has none reports that.
    title: text(item.title) || null,
    titleMissing: !text(item.title),
    brief: text(item.brief) || null,
    status,
    statusLabel: status ? WORK_STATUS_LABELS[status] : "알 수 없는 상태",
    statusMeaning: status
      ? WORK_STATUS_MEANINGS[status]
      : "이 업무의 상태 값을 현재 화면이 해석하지 못했습니다.",
    statusKnown: Boolean(status),
    terminal: isTerminalStatus(status),
    active: Boolean(status) && !isTerminalStatus(status),
    profileId,
    assignee: profileId,
    assigneeLabel: rosterRow?.display_name ? `${profileId} · ${rosterRow.display_name}` : assigneeLabel(profileId),
    executionProfileId: profileId ? toExecutionProfileId(profileId) : null,
    attempt: Number.isFinite(Number(item.attempt)) ? Number(item.attempt) : 0,
    createdAt: item.created_at ?? null,
    updatedAt,
    updatedAtMs: timestamp(updatedAt),
    leaseExpiresAt: item.lease_expires_at ?? null,
    blockedReason: text(item.blocked_reason) || null,
    error: text(item.error) || null,
    resultId: item.result_id ?? null,
    hasResult: Boolean(item.result_id),
    clientRequestId: item.client_request_id ?? null,
    stage: describeWorkStage(status),
    actions: ownerActionsFor(status),
    // Every surface that renders a card links to the same place, so "explain
    // this item" and "open this item" can never disagree.
    navigation: { view: "kanban", target: "work", workItemId: item.id, profileId },
  };
}

/** Sort newest activity first, with rows that have no timestamp last. */
function byRecency(a, b) {
  if (a.updatedAtMs == null && b.updatedAtMs == null) return 0;
  if (a.updatedAtMs == null) return 1;
  if (b.updatedAtMs == null) return -1;
  return b.updatedAtMs - a.updatedAtMs;
}

/**
 * Connector reachability, expressed for a work surface rather than for a badge.
 */
export function describeWorkConnectivity(health) {
  const state = health?.state ?? CONNECTOR_STATE.UNKNOWN;
  return {
    state,
    label: health?.label ?? "UNKNOWN · 아직 보고 없음",
    online: state === CONNECTOR_STATE.ONLINE,
    stale: state === CONNECTOR_STATE.STALE,
    offline: state === CONNECTOR_STATE.OFFLINE,
    unknown: state === CONNECTOR_STATE.UNKNOWN,
    canRunNow: state === CONNECTOR_STATE.ONLINE,
    lastHeartbeatAt: health?.lastHeartbeatAt ?? null,
    ageMs: health?.ageMs ?? null,
    detail: state === CONNECTOR_STATE.ONLINE
      ? "로컬 Mac이 연결되어 있어 맡긴 업무가 바로 실행됩니다."
      : state === CONNECTOR_STATE.STALE
        ? "로컬 Mac의 응답이 늦습니다. 아래 상태는 마지막으로 확인된 값입니다."
        : state === CONNECTOR_STATE.OFFLINE
          ? "로컬 Mac이 연결되어 있지 않습니다. 새 업무는 대기열에 저장됩니다."
          : "로컬 Mac이 아직 한 번도 보고하지 않았습니다. 실행 여부를 확인할 수 없습니다.",
  };
}

/**
 * The canonical Office work projection.
 *
 * @param {object} input
 * @param {Array} input.workItems every `work_items` row the snapshot holds,
 *   of any kind. Filtering happens here so no caller can forget to.
 * @param {Array} input.meetings meetings, for context only. A meeting is never
 *   counted as deliberate work, and its participant work items are excluded by
 *   `kind`.
 * @param {object} input.connectorHealth from `describeConnectorHealth`.
 * @param {boolean} input.loaded whether the first read has completed.
 * @param {string} input.error the read failure, if there was one.
 */
export function projectOfficeWork({
  workItems = null,
  meetings = [],
  connectorHealth = null,
  roster = [],
  loaded = false,
  error = "",
  lastSyncAt = null,
  now = Date.now(),
  staleAfterMs = SNAPSHOT_STALE_AFTER_MS,
} = {}) {
  const connectivity = describeWorkConnectivity(connectorHealth);
  const failure = text(error);
  const rows = Array.isArray(workItems) ? workItems : [];
  const rosterById = new Map((roster ?? []).filter((row) => row?.id).map((row) => [row.id, row]));

  const cards = deliberateWork(rows)
    .map((item) => projectWorkCard(item, { rosterById }))
    .sort(byRecency);
  const excluded = excludedWorkKinds(rows);

  const active = cards.filter((card) => card.active);
  const blocked = cards.filter((card) => card.status === WORK_STATUS.BLOCKED);
  const running = cards.filter((card) => card.status === WORK_STATUS.RUNNING);
  const completed = cards.filter((card) => card.terminal);

  const syncedAtMs = timestamp(lastSyncAt);
  const snapshotStale = syncedAtMs != null && now - syncedAtMs > staleAfterMs;

  const state = failure
    ? OFFICE_STATE.ERROR
    : (!loaded || !Array.isArray(workItems))
      ? OFFICE_STATE.LOADING
      : OFFICE_STATE.READY;

  const meetingRows = meetings ?? [];

  return {
    state,
    loading: state === OFFICE_STATE.LOADING,
    ready: state === OFFICE_STATE.READY,
    error: failure,
    connectivity,
    cards,
    active,
    blocked,
    running,
    completed,
    byId: new Map(cards.map((card) => [card.id, card])),
    counts: {
      total: cards.length,
      active: active.length,
      running: running.length,
      blocked: blocked.length,
      succeeded: cards.filter((card) => card.status === WORK_STATUS.SUCCEEDED).length,
      failed: cards.filter((card) => card.status === WORK_STATUS.FAILED).length,
      cancelled: cards.filter((card) => card.status === WORK_STATUS.CANCELLED).length,
    },
    excluded,
    // Meetings are reported beside the work, never inside it.
    meetings: {
      total: meetingRows.length,
      active: meetingRows.filter((meeting) => meeting?.status !== "complete").length,
      completed: meetingRows.filter((meeting) => meeting?.status === "complete").length,
    },
    isEmpty: state === OFFICE_STATE.READY && cards.length === 0,
    hasActive: active.length > 0,
    lastSyncAt: lastSyncAt ?? null,
    stale: snapshotStale,
  };
}

/**
 * The same projection shape, built from missions that were already mapped by
 * another adapter — the legacy Hermes board, which has its own status
 * vocabulary and cannot be re-derived from `work_items`.
 *
 * It exists so the right-hand panel has exactly one implementation. Whatever
 * the source, the panel is fed a projection, and the honesty rules in
 * `describeRnbWork` apply to both paths.
 */
export function projectionFromMissions(missions, {
  loaded = false,
  error = "",
  connectorHealth = null,
  lastSyncAt = null,
  now = Date.now(),
  staleAfterMs = SNAPSHOT_STALE_AFTER_MS,
} = {}) {
  const connectivity = describeWorkConnectivity(connectorHealth);
  const failure = text(error);
  const rows = Array.isArray(missions) ? missions : [];

  const cards = rows.map((mission) => ({
    ...mission,
    kind: WORK_KIND.WORK,
    terminal: Boolean(mission.terminal),
    active: !mission.terminal,
    profileId: mission.owner ?? null,
    assigneeLabel: mission.ownerLabel ?? mission.owner ?? "미배정",
    statusLabel: mission.statusLabel ?? mission.status ?? "알 수 없는 상태",
    statusMeaning: mission.statusMeaning ?? "이 상태 값을 현재 화면이 해석하지 못했습니다.",
    stage: mission.stage ?? { index: null, count: null, label: mission.stageLabel ?? null, complete: Boolean(mission.terminal), percent: null, basis: "unknown" },
    hasResult: Boolean(mission.hasResult),
    updatedAtMs: timestamp(mission.updatedAt),
    navigation: mission.navigation ?? { view: "kanban", target: "task", taskId: mission.id, profileId: mission.owner ?? null },
  })).sort(byRecency);

  const active = cards.filter((card) => card.active);
  const completed = cards.filter((card) => card.terminal);
  const syncedAtMs = timestamp(lastSyncAt);

  const state = failure
    ? OFFICE_STATE.ERROR
    : (!loaded || !Array.isArray(missions))
      ? OFFICE_STATE.LOADING
      : OFFICE_STATE.READY;

  return {
    state,
    loading: state === OFFICE_STATE.LOADING,
    ready: state === OFFICE_STATE.READY,
    error: failure,
    connectivity,
    cards,
    active,
    blocked: cards.filter((card) => card.blockedReason),
    running: cards.filter((card) => card.status === "running"),
    completed,
    byId: new Map(cards.map((card) => [card.id, card])),
    counts: {
      total: cards.length,
      active: active.length,
      running: cards.filter((card) => card.status === "running").length,
      blocked: cards.filter((card) => card.blockedReason).length,
      succeeded: completed.length,
      failed: 0,
      cancelled: 0,
    },
    excluded: { meeting: 0, chat: 0, other: 0, total: 0 },
    meetings: { total: 0, active: 0, completed: 0 },
    isEmpty: state === OFFICE_STATE.READY && cards.length === 0,
    hasActive: active.length > 0,
    lastSyncAt,
    stale: syncedAtMs != null && now - syncedAtMs > staleAfterMs,
  };
}

/**
 * Per-item evidence, once the detail rows for one work item have been read.
 * Used to answer "is there a result to open" without claiming one exists
 * because the status says `succeeded`.
 */
export function describeWorkEvidence(detail) {
  const events = detail?.events ?? [];
  const results = detail?.results ?? [];
  const evidence = detail?.evidence ?? [];
  return {
    loaded: Boolean(detail),
    events,
    results,
    evidence,
    hasEvents: events.length > 0,
    hasResult: results.length > 0,
    hasEvidence: evidence.length > 0,
    latestEventAt: events.length ? events[events.length - 1]?.created_at ?? null : null,
  };
}

/**
 * What the right-hand panel should render.
 *
 * There is no slot count. The panel used to draw five fixed category buttons
 * and pad every count to at least one, which meant it showed five pieces of
 * work on a workspace that had none. This returns exactly what exists.
 */
export function describeRnbWork(projection, { completedLimit = 3 } = {}) {
  if (!projection) {
    return {
      state: WORK_VIEW_STATE.LOADING,
      headline: "업무를 불러오는 중입니다",
      detail: "실제 업무 기록을 읽고 있습니다.",
      items: [],
      completed: [],
      notice: "",
      empty: null,
    };
  }

  const toEntry = (card) => ({
    id: card.id,
    title: card.title,
    titleMissing: card.titleMissing,
    // The whole point of the panel: every row says why it is on screen.
    meaning: card.statusMeaning,
    statusLabel: card.statusLabel,
    status: card.status,
    assigneeLabel: card.assigneeLabel,
    updatedAt: card.updatedAt,
    stageLabel: card.stage.label,
    blockedReason: card.blockedReason,
    error: card.error,
    hasResult: card.hasResult,
    navigation: card.navigation,
    tone: card.status === WORK_STATUS.FAILED
      ? "error"
      : card.status === WORK_STATUS.BLOCKED
        ? "blocked"
        : card.status === WORK_STATUS.RUNNING
          ? "running"
          : "queued",
  });

  if (projection.state === OFFICE_STATE.ERROR) {
    return {
      state: WORK_VIEW_STATE.ERROR,
      headline: "업무를 불러오지 못했습니다",
      detail: projection.error,
      items: [],
      completed: [],
      notice: "",
      empty: null,
    };
  }

  if (projection.state === OFFICE_STATE.LOADING) {
    return {
      state: WORK_VIEW_STATE.LOADING,
      headline: "업무를 불러오는 중입니다",
      detail: "실제 업무 기록을 읽고 있습니다.",
      items: [],
      completed: [],
      notice: "",
      empty: null,
    };
  }

  const completed = projection.completed.slice(0, completedLimit).map(toEntry);
  const notice = projection.connectivity.online
    ? projection.stale
      ? "마지막 동기화가 오래되었습니다. 아래 내용은 최신이 아닐 수 있습니다."
      : ""
    : projection.connectivity.detail;

  if (!projection.hasActive) {
    return {
      // Offline with nothing running is still "nothing running" — but the
      // reason the user cannot start anything belongs on screen too.
      state: projection.connectivity.online ? WORK_VIEW_STATE.EMPTY : WORK_VIEW_STATE.OFFLINE,
      headline: "진행 중인 업무가 없습니다",
      detail: projection.counts.total
        ? `맡긴 업무 ${projection.counts.total}건은 모두 끝났습니다.`
        : "아직 맡긴 업무가 없습니다.",
      items: [],
      completed,
      notice,
      empty: {
        title: "지금 맡길 업무를 적어주세요",
        detail: projection.connectivity.online
          ? "업무를 맡기면 로컬 Mac이 바로 실행합니다."
          : "지금 맡기면 대기열에 저장되고, 로컬 Mac이 돌아오면 실행됩니다.",
        action: { label: "업무 맡기기", navigation: { view: "kanban", target: "intake" } },
      },
    };
  }

  return {
    state: projection.stale ? WORK_VIEW_STATE.STALE : WORK_VIEW_STATE.READY,
    headline: "진행 중인 업무",
    detail: `실행 중 ${projection.counts.running}건 · 보류 ${projection.counts.blocked}건`,
    // Everything active, in recency order. No cap, no padding.
    items: projection.active.map(toEntry),
    completed,
    notice,
    empty: null,
  };
}

/**
 * The board columns.
 *
 * One column per canonical status, in lifecycle order, with the copy naming the
 * status it actually maps to. `manual` says whether an owner-scoped API call can
 * put a card here; the columns the connector owns are display-only, and the UI
 * must not offer a drop target that would be refused.
 */
export const BOARD_COLUMNS = Object.freeze([
  {
    status: WORK_STATUS.INTAKE,
    label: "접수됨",
    english: "INTAKE",
    meaning: "맡겨졌지만 담당자가 아직 없습니다.",
    manual: false,
    manualNote: "업무를 맡기면 여기에 들어옵니다.",
  },
  {
    status: WORK_STATUS.ASSIGNED,
    label: "배정됨",
    english: "ASSIGNED",
    meaning: "담당자가 정해졌고 로컬 Mac이 가져가기를 기다립니다.",
    manual: true,
    manualNote: "담당자를 지정하면 여기로 옮겨집니다.",
  },
  {
    status: WORK_STATUS.LEASED,
    label: "실행 준비",
    english: "LEASED",
    meaning: "로컬 Mac이 가져갔습니다. 사람이 옮길 수 없습니다.",
    manual: false,
    manualNote: "로컬 Mac이 업무를 가져갈 때만 바뀝니다.",
  },
  {
    status: WORK_STATUS.RUNNING,
    label: "실행 중",
    english: "RUNNING",
    meaning: "로컬 Mac에서 실제로 실행되는 중입니다.",
    manual: false,
    manualNote: "실제 실행이 시작될 때만 바뀝니다.",
  },
  {
    status: WORK_STATUS.BLOCKED,
    label: "보류",
    english: "BLOCKED",
    meaning: "사유를 남기고 멈춰 세운 업무입니다.",
    manual: true,
    manualNote: "보류 사유를 적으면 여기로 옮겨집니다.",
  },
  {
    status: WORK_STATUS.SUCCEEDED,
    label: "완료",
    english: "SUCCEEDED",
    meaning: "실행이 끝나고 결과가 저장되었습니다.",
    manual: false,
    manualNote: "실제 실행 결과로만 완료됩니다.",
  },
  {
    status: WORK_STATUS.FAILED,
    label: "실패",
    english: "FAILED",
    meaning: "실행이 실패했습니다. 오류가 함께 저장됩니다.",
    manual: false,
    manualNote: "실제 실행 실패로만 이동합니다.",
  },
  {
    status: WORK_STATUS.CANCELLED,
    label: "취소됨",
    english: "CANCELLED",
    meaning: "사용자가 취소했습니다.",
    manual: true,
    manualNote: "업무 취소를 누르면 여기로 옮겨집니다.",
  },
]);

/** Columns holding work that is finished for good. */
export const TERMINAL_BOARD_STATUSES = TERMINAL_STATUSES;

export function projectWorkBoard(projection) {
  const columns = BOARD_COLUMNS.map((column) => {
    const cards = projection?.cards?.filter((card) => card.status === column.status) ?? [];
    return { ...column, cards, count: cards.length, terminal: isTerminalStatus(column.status) };
  });

  const state = !projection
    ? WORK_VIEW_STATE.LOADING
    : projection.state === OFFICE_STATE.ERROR
      ? WORK_VIEW_STATE.ERROR
      : projection.state === OFFICE_STATE.LOADING
        ? WORK_VIEW_STATE.LOADING
        : projection.isEmpty
          ? WORK_VIEW_STATE.EMPTY
          : projection.stale
            ? WORK_VIEW_STATE.STALE
            : WORK_VIEW_STATE.READY;

  return {
    state,
    // Explicitly separate from `state`, because a board that is refreshing in
    // the background must keep its cards on screen rather than being covered.
    loading: state === WORK_VIEW_STATE.LOADING,
    error: projection?.error ?? "",
    columns,
    total: projection?.counts.total ?? 0,
    connectivity: projection?.connectivity ?? describeWorkConnectivity(null),
    excluded: projection?.excluded ?? { meeting: 0, chat: 0, other: 0, total: 0 },
    stale: Boolean(projection?.stale),
  };
}

/**
 * Board columns for a list of already-projected missions.
 *
 * Used by the surfaces that receive missions rather than the projection itself.
 * Canonical statuses always get a column, in lifecycle order, even when empty —
 * a board that hides `실패` because nothing failed teaches the user a column
 * that does not exist. Anything else present in the data gets a column named
 * after its own status, never folded into a canonical one.
 */
export function groupMissionsByStatus(missions = []) {
  const grouped = new Map();
  for (const mission of missions ?? []) {
    const status = mission?.status ?? "unknown";
    if (!grouped.has(status)) grouped.set(status, []);
    grouped.get(status).push(mission);
  }

  const canonical = BOARD_COLUMNS.map((column) => ({
    ...column,
    canonical: true,
    missions: grouped.get(column.status) ?? [],
    count: (grouped.get(column.status) ?? []).length,
  }));
  const canonicalStatuses = new Set(BOARD_COLUMNS.map((column) => column.status));

  const extra = [...grouped.entries()]
    .filter(([status]) => !canonicalStatuses.has(status))
    .map(([status, rows]) => ({
      status,
      label: rows[0]?.statusLabel ?? status,
      english: String(status).toUpperCase(),
      meaning: rows[0]?.statusMeaning ?? "",
      // Not a canonical status, so this build cannot promise any transition.
      manual: false,
      manualNote: "이 상태는 실제 실행 기록에서만 바뀝니다.",
      canonical: false,
      missions: rows,
      count: rows.length,
    }));

  // A surface fed non-canonical statuses (the legacy Hermes board) should not
  // be shown eight empty canonical columns it can never fill.
  if (extra.length && canonical.every((column) => column.count === 0)) return extra;
  return [...canonical, ...extra];
}

/**
 * Turn "the user wants this card in that column" into the owner event that
 * would do it, or refuse with the reason.
 *
 * Terminal work is refused before anything else: the lifecycle reducer would
 * refuse it too, and refusing here means the UI never sends a request it knows
 * will 409.
 */
export function boardMovePlan(card, targetStatus, { profileId = null, reason = "" } = {}) {
  if (!card?.status) throw new OfficeProjectionError("업무 상태를 알 수 없어 이동할 수 없습니다.", "UNKNOWN_STATUS");
  if (card.terminal) {
    throw new OfficeProjectionError(
      `이미 종료된 업무(${WORK_STATUS_LABELS[card.status] ?? card.status})는 다시 이동할 수 없습니다.`,
      "TERMINAL_WORK_ITEM",
    );
  }
  const column = BOARD_COLUMNS.find((entry) => entry.status === targetStatus);
  if (!column) throw new OfficeProjectionError(`'${targetStatus}'은(는) 업무 보드의 상태가 아닙니다.`, "UNKNOWN_COLUMN");
  if (!column.manual) {
    throw new OfficeProjectionError(
      `'${column.label}'은(는) 실제 실행으로만 바뀝니다. ${column.manualNote}`,
      "NOT_OWNER_TRANSITION",
    );
  }
  if (card.status === targetStatus) {
    throw new OfficeProjectionError("이미 같은 상태입니다.", "NO_CHANGE");
  }

  if (targetStatus === WORK_STATUS.CANCELLED) {
    if (!card.actions.cancel) throw new OfficeProjectionError("지금 상태에서는 취소할 수 없습니다.", "INVALID_TRANSITION");
    return { type: "cancel", reason: text(reason) || "사용자 취소" };
  }
  if (targetStatus === WORK_STATUS.BLOCKED) {
    if (!card.actions.block) throw new OfficeProjectionError("지금 상태에서는 보류할 수 없습니다.", "INVALID_TRANSITION");
    const why = text(reason);
    if (!why) throw new OfficeProjectionError("보류 사유를 입력해야 합니다.", "MISSING_REASON");
    return { type: "block", reason: why };
  }
  // assigned
  if (card.status === WORK_STATUS.BLOCKED && !text(profileId)) {
    if (!card.actions.unblock) throw new OfficeProjectionError("지금 상태에서는 보류를 풀 수 없습니다.", "INVALID_TRANSITION");
    return { type: "unblock" };
  }
  const target = text(profileId) || card.profileId;
  if (!target) throw new OfficeProjectionError("담당자를 선택해야 배정할 수 있습니다.", "MISSING_PROFILE");
  if (!card.actions.assign) throw new OfficeProjectionError("지금 상태에서는 배정할 수 없습니다.", "INVALID_TRANSITION");
  return { type: "assign", profileId: target };
}

/**
 * What one profile is actually doing, for the roster and the agent console.
 *
 * The old version of this had a hard-coded sentence per profile — "브랜드 문구
 * 검토" — rendered whether or not the profile had ever run anything. There is
 * no sentence here that is not read off a work row.
 */
export function describeProfileWork(projection, profileId) {
  const assigned = projection?.cards?.filter((card) => card.profileId === profileId) ?? [];
  const active = assigned.filter((card) => card.active);
  const current = active[0] ?? null;
  const lastFinished = assigned.find((card) => card.terminal) ?? null;

  return {
    profileId,
    assigned,
    active,
    current,
    lastFinished,
    counts: { assigned: assigned.length, active: active.length },
    // Null, not a placeholder. A caller that has nothing to show must say so in
    // its own words rather than being handed an invented activity line.
    headline: current ? current.title : null,
    headlineMeaning: current
      ? current.statusMeaning
      : lastFinished
        ? `마지막 업무는 ${WORK_STATUS_LABELS[lastFinished.status]} 상태로 끝났습니다.`
        : "이 구성원에게 맡긴 업무가 아직 없습니다.",
    state: current ? current.status : null,
  };
}
