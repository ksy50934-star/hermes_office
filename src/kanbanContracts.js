const OFFICE_MARKER = "hermes-office-kanban:v1";
const MARKER_PATTERN = /\n?<!-- (?:[a-z0-9._-]+-)?office-kanban:v1 ([A-Za-z0-9_-]+) -->\s*$/i;

function encodeMetadata(metadata) {
  const json = JSON.stringify(metadata ?? {});
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeMetadata(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function splitOfficeTaskBody(body = "") {
  const source = String(body ?? "");
  const match = source.match(MARKER_PATTERN);
  if (!match) return { description: source, metadata: {} };
  try {
    return {
      description: source.slice(0, match.index).trimEnd(),
      metadata: decodeMetadata(match[1]),
    };
  } catch {
    return { description: source, metadata: {} };
  }
}

export function joinOfficeTaskBody(description = "", metadata = {}) {
  const cleanDescription = String(description ?? "").replace(MARKER_PATTERN, "").trimEnd();
  const marker = `<!-- ${OFFICE_MARKER} ${encodeMetadata(metadata)} -->`;
  return cleanDescription ? `${cleanDescription}\n\n${marker}` : marker;
}

export function normalizeOfficeTask(task = {}) {
  const { description, metadata } = splitOfficeTaskBody(task.body);
  return { ...task, body: description, metadata };
}

export function normalizeOfficeBoard(board = {}) {
  return {
    ...board,
    columns: (board.columns ?? []).map((column) => ({
      ...column,
      tasks: (column.tasks ?? []).map(normalizeOfficeTask),
    })),
  };
}

/**
 * The legacy Hermes board's own statuses, spelled out. This is exact 1:1 copy
 * for states the board really has — not a second, invented vocabulary layered
 * over them.
 */
export const HERMES_TASK_STATUS_LABELS = Object.freeze({
  triage: "분류 대기",
  todo: "할 일",
  scheduled: "예약됨",
  ready: "실행 준비",
  running: "진행 중",
  blocked: "멈춤",
  review: "검토",
  done: "완료",
  archived: "보관됨",
});

export const HERMES_TASK_STATUS_MEANINGS = Object.freeze({
  triage: "아직 담당자나 완료 기준이 정해지지 않았습니다.",
  todo: "업무로 확정되어 백로그에 있습니다.",
  scheduled: "지정한 시점이나 조건에 실행되도록 예약되었습니다.",
  ready: "준비가 끝나 dispatcher가 가져가기를 기다립니다.",
  running: "Hermes worker가 실제로 실행하는 중입니다.",
  blocked: "막힌 이유가 기록된 채 멈춰 있습니다.",
  review: "Hermes worker가 결과를 검토 상태로 올려두었습니다.",
  done: "완료 처리되었습니다.",
  archived: "보관함으로 옮겨졌습니다.",
});

const MISSION_TONE_BY_TASK_STATUS = {
  running: "working",
  ready: "working",
  scheduled: "working",
  review: "approval",
  blocked: "approval",
  done: "done",
  archived: "done",
};

const TERMINAL_TASK_STATUSES = new Set(["done", "archived"]);

const ROOM_BY_PROFILE = {
  default: "executive",
  "hermes-operations": "operations",
  "hermes-brand": "brand",
  "hermes-growth": "content",
  "hermes-content": "content",
  "hermes-creative": "creative",
  "hermes-customer": "customer",
  "hermes-finance": "finance",
  "hermes-technology": "tech",
};

/**
 * Progress from evidence or not at all.
 *
 * A checklist is a real record of what has been ticked off, so it yields a real
 * percentage. Nothing else does: the previous version returned 60% for every
 * running task and 90% for every review task, which is a number the board made
 * up about work it had not measured.
 */
function taskProgress(task) {
  const checklist = Array.isArray(task.metadata?.checklist) ? task.metadata.checklist : [];
  if (!checklist.length) return null;
  return Math.round((checklist.filter((item) => item.done).length / checklist.length) * 100);
}

export function officeMissionsFromBoard(board = {}) {
  const normalized = normalizeOfficeBoard(board);
  return (normalized.columns ?? []).flatMap((column) => (column.tasks ?? [])
    .filter((task) => !task.metadata?.deleted_at)
    .map((task) => {
    const status = String(task.status ?? column.name ?? "triage");
    const owner = task.assignee || "default";
    const checklist = Array.isArray(task.metadata?.checklist) ? task.metadata.checklist : [];
    const progress = taskProgress(task);
    const title = String(task.title ?? "").trim();
    return {
      id: task.id,
      // Left null rather than titled for the user. A task with no title is a
      // real defect in the board, and printing "제목 없는 Hermes 업무" hid it.
      title: title || null,
      titleMissing: !title,
      objective: String(task.body ?? "").trim() || null,
      owner,
      ownerLabel: owner,
      room: ROOM_BY_PROFILE[owner] ?? "operations",
      status,
      statusLabel: HERMES_TASK_STATUS_LABELS[status] ?? status,
      statusMeaning: HERMES_TASK_STATUS_MEANINGS[status] ?? "이 상태 값을 현재 화면이 해석하지 못했습니다.",
      statusTone: MISSION_TONE_BY_TASK_STATUS[status] ?? "queued",
      officialStatus: status,
      terminal: TERMINAL_TASK_STATUSES.has(status),
      active: !TERMINAL_TASK_STATUSES.has(status),
      // Null when there is no checklist to measure. Callers render the status
      // instead of a bar they cannot honestly fill.
      progress,
      progressBasis: progress == null ? null : "checklist",
      stage: null,
      stageLabel: null,
      // The board does carry a real due date when someone set one. It is only
      // reported when it exists; there is no 기한 미정 stand-in.
      due: String(task.metadata?.due_date ?? "").trim() || null,
      updatedAt: task.updated_at ?? task.created_at ?? null,
      createdAt: task.created_at ?? null,
      blockedReason: String(task.block_reason ?? task.metadata?.blocked_reason ?? "").trim() || null,
      error: null,
      hasResult: Boolean(task.metadata?.completed_at),
      priority: Number(task.priority ?? 0) > 0 ? "high" : "normal",
      navigation: { view: "kanban", target: "task", taskId: task.id, profileId: owner },
      steps: checklist.map((item, index) => ({
        id: item.id ?? `${task.id}-step-${index}`,
        label: item.text ?? item.label ?? `체크리스트 ${index + 1}`,
        done: Boolean(item.done),
      })),
      metadata: task.metadata ?? {},
    };
    }));
}

export function officialTaskPatch(task, patch, metadata) {
  const payload = { ...patch };
  delete payload.metadata;
  payload.body = joinOfficeTaskBody(patch.body ?? task.body ?? "", metadata);
  if (["blocked", "scheduled"].includes(payload.status)) {
    payload.block_reason = String(
      patch.block_reason ?? metadata?.blocked_reason ?? metadata?.status_note ?? "",
    ).trim();
  }
  if (payload.status === "done") {
    payload.summary = String(patch.summary ?? metadata?.status_note ?? "Completed in Hermes Office").trim();
    payload.metadata = { hermes_office: metadata };
  }
  return payload;
}

export function officialKanbanMovePlan(targetStatus) {
  const status = String(targetStatus ?? "");
  if (status === "review") {
    throw new Error("검토 상태는 Hermes worker 흐름에서만 전환됩니다.");
  }
  if (status === "running") return { status: "ready", dispatch: true };
  return { status, dispatch: false };
}

export async function patchOfficeTaskFromLatest(fetcher, taskId, patch, metadataForTask) {
  const path = `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`;
  const detail = await fetcher(path, { cacheTtlMs: 0, dedupe: false });
  if (!detail?.task || String(detail.task.id) !== String(taskId)) {
    throw new Error("Hermes task 최신 본문을 확인하지 못해 변경을 중단했습니다.");
  }
  const latestTask = normalizeOfficeTask(detail.task);
  const metadata = typeof metadataForTask === "function"
    ? metadataForTask(latestTask)
    : metadataForTask;
  const payload = officialTaskPatch(latestTask, patch, metadata);
  await fetcher(path, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return {
    payload,
    task: { ...latestTask, ...patch, metadata },
  };
}

export function officialCreateTaskPayload({ title, assignee, description = "" }) {
  return {
    title: String(title).trim(),
    assignee,
    priority: 0,
    triage: false,
    body: joinOfficeTaskBody(description, {
      due_date: "",
      checklist: [],
      task_events: [],
    }),
  };
}
