/**
 * 실행 관제 — what the operator needs to know before they file more work.
 *
 * The surface this feeds used to be a "Hermes 콘솔": a title, a health badge and
 * a list of rows. It said nothing about whether the office could actually run
 * anything, because the one number it did show was read off the wrong field —
 * `connector.health.status`, which `describeConnectorHealth` never sets. It
 * returns `state`. So the badge read UNKNOWN forever, online or not.
 *
 * Everything below is derived from state the connector really reports:
 * the heartbeat (`connector_nodes`), the durable queue (`work_items`) and the
 * runtime projection (`bibi_runtime_health`). Nothing is inferred from the page
 * having loaded, and a missing signal is reported as missing — never as healthy.
 */

import { CONNECTOR_STATE, describeConnectorHealth } from "./connectionState.js";
import { BIBI_PROFILE_COUNT } from "./roster.js";
import { WORK_STATUS } from "./workLifecycle.js";

/** What this surface is for, in the words shown at the top of it. */
export const EXECUTION_CONTROL_PURPOSE =
  "이 화면은 비비 조직이 지금 일을 실행할 수 있는 상태인지 확인하고, 막힌 것을 풀고, 새 실행을 맡기는 곳입니다.";

/** Korean label for every status a work item can actually hold. */
export const WORK_STATUS_LABELS = Object.freeze({
  [WORK_STATUS.INTAKE]: "접수",
  [WORK_STATUS.ASSIGNED]: "배정",
  [WORK_STATUS.LEASED]: "인계",
  [WORK_STATUS.RUNNING]: "실행 중",
  [WORK_STATUS.BLOCKED]: "차단",
  [WORK_STATUS.SUCCEEDED]: "완료",
  [WORK_STATUS.FAILED]: "실패",
  [WORK_STATUS.CANCELLED]: "취소",
});

export function workStatusLabel(status) {
  return WORK_STATUS_LABELS[status] ?? String(status ?? "알 수 없음");
}

/**
 * Statuses that mean the Mac still owes the user a result. `intake`,
 * `assigned` and `leased` are all "filed, not started" from the operator's
 * seat — the distinction between them is the connector's business, not theirs.
 */
const WAITING_STATUSES = new Set([WORK_STATUS.INTAKE, WORK_STATUS.ASSIGNED, WORK_STATUS.LEASED]);

function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Count the durable queue by what the operator can act on. `total` counts the
 * items given, so it never disagrees with the list rendered beside it.
 */
export function summarizeWorkQueue(workItems = []) {
  const items = Array.isArray(workItems) ? workItems : [];
  const summary = {
    total: items.length,
    waiting: 0,
    running: 0,
    blocked: 0,
    failed: 0,
    succeeded: 0,
    cancelled: 0,
    oldestWaitingAt: null,
  };
  for (const item of items) {
    const status = item?.status;
    if (status === WORK_STATUS.RUNNING) summary.running += 1;
    else if (status === WORK_STATUS.BLOCKED) summary.blocked += 1;
    else if (status === WORK_STATUS.FAILED) summary.failed += 1;
    else if (status === WORK_STATUS.SUCCEEDED) summary.succeeded += 1;
    else if (status === WORK_STATUS.CANCELLED) summary.cancelled += 1;
    else if (WAITING_STATUSES.has(status)) {
      summary.waiting += 1;
      const created = timestamp(item?.created_at) ?? timestamp(item?.updated_at);
      if (created !== null && (summary.oldestWaitingAt === null || created < summary.oldestWaitingAt)) {
        summary.oldestWaitingAt = created;
      }
    }
  }
  return summary;
}

/**
 * What the runtime projection says about the Mac. `expected` is the full
 * roster: a profile that never reported is a profile we know nothing about,
 * and that gap is the number worth showing.
 */
export function summarizeRuntimeHealth(health = [], expected = BIBI_PROFILE_COUNT) {
  const rows = Array.isArray(health) ? health : [];
  const gatewayRunning = rows.filter((row) => row?.gateway_status === "running").length;
  const errors = rows.filter((row) => row?.health_error).length;
  const activeSessions = rows.reduce(
    (sum, row) => sum + (Number.isInteger(row?.active_sessions) ? row.active_sessions : 0),
    0,
  );
  const primary = rows.find((row) => row?.profile_id === "bibi-01") ?? rows[0] ?? null;
  const collectedAt = rows
    .map((row) => timestamp(row?.collected_at))
    .filter((value) => value !== null)
    .sort((left, right) => right - left)[0] ?? null;
  return {
    reporting: rows.length,
    expected,
    missing: Math.max(0, expected - rows.length),
    gatewayRunning,
    errors,
    activeSessions,
    model: primary?.model ?? "",
    provider: primary?.provider ?? "",
    collectedAt: collectedAt === null ? null : new Date(collectedAt).toISOString(),
  };
}

/**
 * Read the connector's health honestly.
 *
 * Accepts either the shape `loadConnectorState` returns (`{ node, health }`) or
 * a bare health object, and recomputes from the heartbeat when the caller only
 * passed the raw node. With no evidence at all the answer is UNKNOWN.
 */
export function summarizeConnector(connector, { now = Date.now() } = {}) {
  const health = connector?.health ?? null;
  const lastHeartbeatAt = health?.lastHeartbeatAt ?? connector?.node?.last_heartbeat_at ?? null;
  const derived = health?.state
    ? health
    : describeConnectorHealth({ lastHeartbeatAt, now });
  return {
    state: derived.state ?? CONNECTOR_STATE.UNKNOWN,
    label: derived.label ?? "UNKNOWN · 아직 보고 없음",
    canDispatchLive: Boolean(derived.canDispatchLive),
    lastHeartbeatAt: derived.lastHeartbeatAt ?? lastHeartbeatAt ?? null,
    mode: connector?.node?.connector_mode ?? null,
    nodeLabel: connector?.node?.label ?? null,
    reportedProfiles: Array.isArray(connector?.reportedProfileIds) ? connector.reportedProfileIds.length : 0,
  };
}

/**
 * The ordered list of things the operator should do next, most blocking first.
 *
 * Every action names what is wrong, what it means for their work, and the one
 * move that clears it. When nothing is wrong the list says so explicitly rather
 * than rendering empty, because an empty panel reads as a broken panel.
 */
export function executionControlActions({ connector, work, runtime }) {
  const actions = [];

  if (connector.state === CONNECTOR_STATE.OFFLINE || connector.state === CONNECTOR_STATE.UNKNOWN) {
    actions.push({
      id: "connector-down",
      tone: "critical",
      title: connector.state === CONNECTOR_STATE.UNKNOWN
        ? "connector가 아직 한 번도 보고하지 않았습니다"
        : "로컬 Mac connector가 끊겼습니다",
      detail: "지금 등록하는 실행은 queue에 안전하게 쌓이지만 실행되지는 않습니다. Mac에서 connector를 다시 실행하면 밀린 업무부터 이어서 처리합니다.",
    });
  } else if (connector.state === CONNECTOR_STATE.STALE) {
    actions.push({
      id: "connector-stale",
      tone: "warning",
      title: "connector 응답이 지연되고 있습니다",
      detail: "heartbeat가 늦습니다. Mac이 절전으로 들어갔는지 확인하세요. 실행은 계속 queue에 보존됩니다.",
    });
  }

  if (work.blocked > 0) {
    actions.push({
      id: "work-blocked",
      tone: "critical",
      title: `차단된 업무 ${work.blocked}건`,
      detail: "차단 사유를 확인하고 필요한 정보를 채워야 다시 흐릅니다. 아래 목록에서 해당 업무를 열어 사유를 읽으세요.",
    });
  }

  if (work.failed > 0) {
    actions.push({
      id: "work-failed",
      tone: "warning",
      title: `실패한 업무 ${work.failed}건`,
      detail: "실패는 자동으로 재시도되지 않습니다. 원인을 확인한 뒤 같은 지시를 다시 등록하세요.",
    });
  }

  if (work.waiting > 0 && !connector.canDispatchLive) {
    actions.push({
      id: "work-stranded",
      tone: "warning",
      title: `대기 중인 업무 ${work.waiting}건이 실행을 기다립니다`,
      detail: "connector가 연결되면 등록 순서대로 실행됩니다. 다시 등록할 필요는 없습니다.",
    });
  }

  if (runtime.missing > 0) {
    actions.push({
      id: "runtime-missing",
      tone: "warning",
      title: `런타임 상태를 보고하지 않은 프로필 ${runtime.missing}개`,
      detail: `${runtime.reporting}/${runtime.expected}개 프로필만 보고했습니다. 보고가 없는 프로필은 상태를 알 수 없으므로 정상으로 간주하지 않습니다.`,
    });
  }

  if (runtime.errors > 0) {
    actions.push({
      id: "runtime-errors",
      tone: "warning",
      title: `런타임 오류를 보고한 프로필 ${runtime.errors}개`,
      detail: "해당 프로필의 Hermes gateway 상태를 확인하세요. 오류 상태에서는 실행이 실패로 끝날 수 있습니다.",
    });
  }

  if (actions.length === 0) {
    actions.push({
      id: "all-clear",
      tone: "ok",
      title: "지금 조치할 것이 없습니다",
      detail: "connector가 연결돼 있고 막히거나 실패한 업무가 없습니다. 아래에서 새 실행을 맡기면 됩니다.",
    });
  }

  return actions;
}

/**
 * True when filing work will actually run it now, rather than parking it.
 * Filing is always allowed — the queue is durable — but the operator is told
 * which of the two is about to happen.
 */
export function executionDispatchNotice(connector) {
  return connector.canDispatchLive
    ? "connector가 연결돼 있어 등록 즉시 실행됩니다."
    : "connector가 연결될 때까지 queue에 보존되며, 연결되면 순서대로 실행됩니다.";
}

/** Everything the 실행 관제 surface renders, derived in one place. */
export function summarizeExecutionControl({
  connector = null,
  workItems = [],
  runtime = null,
  expectedProfiles = BIBI_PROFILE_COUNT,
  now = Date.now(),
} = {}) {
  const connectorSummary = summarizeConnector(connector, { now });
  const work = summarizeWorkQueue(workItems);
  const runtimeSummary = summarizeRuntimeHealth(runtime?.health ?? [], expectedProfiles);
  return {
    purpose: EXECUTION_CONTROL_PURPOSE,
    connector: connectorSummary,
    work,
    runtime: runtimeSummary,
    actions: executionControlActions({ connector: connectorSummary, work, runtime: runtimeSummary }),
    dispatchNotice: executionDispatchNotice(connectorSummary),
  };
}
