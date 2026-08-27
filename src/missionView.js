/**
 * Display copy for one work item, derived from what the row actually holds.
 *
 * Every function here is total: given a mission it returns something renderable.
 * What it never does is substitute content for a value the source did not have.
 * A missing title renders as a statement that the title is missing; an
 * unmeasured job renders its lifecycle stage rather than a made-up percentage;
 * a work item with no due date says so instead of showing "기한 미정" beside a
 * formatted `updated_at`.
 *
 * These live in a plain module rather than inside the Office components so the
 * honesty rules can be tested directly.
 */

/** A title the board really has, or a statement that it does not. */
export function missionTitle(mission) {
  const title = typeof mission?.title === "string" ? mission.title.trim() : "";
  return title || "제목이 비어 있는 업무";
}

/** The brief, or the plain-language meaning of the status. Never filler. */
export function missionSummary(mission) {
  const objective = typeof mission?.objective === "string" ? mission.objective.trim() : "";
  if (objective) return objective;
  return mission?.statusMeaning || "이 업무에 대한 설명이 아직 입력되지 않았습니다.";
}

export function missionStatusLabel(mission) {
  return mission?.statusLabel || mission?.status || "알 수 없는 상태";
}

export function missionStatusTone(mission) {
  return mission?.statusTone || "queued";
}

/**
 * The measured percentage, or `null`.
 *
 * Only a checklist produces one. Callers must not render a progress bar when
 * this is null — there is nothing to draw, and drawing an empty bar reads as
 * "0% done" rather than "not measured".
 */
export function missionProgressPercent(mission) {
  const value = Number(mission?.progress);
  if (mission?.progress == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function hasMeasuredProgress(mission) {
  return missionProgressPercent(mission) != null;
}

/**
 * What to print where a percentage used to go.
 *
 * In order of what is actually known: a measured checklist, then the canonical
 * lifecycle stage, then the status itself.
 */
export function missionProgressLabel(mission) {
  const percent = missionProgressPercent(mission);
  if (percent != null) {
    const done = (mission.steps ?? []).filter((step) => step.done).length;
    const total = (mission.steps ?? []).length;
    return total ? `체크리스트 ${done}/${total} · ${percent}%` : `${percent}%`;
  }
  if (mission?.stageLabel) return mission.stageLabel;
  return missionStatusLabel(mission);
}

/** Why the progress figure is what it is, for a tooltip or a caption. */
export function missionProgressBasis(mission) {
  if (hasMeasuredProgress(mission)) return "체크리스트에 실제로 표시된 항목 기준입니다.";
  if (mission?.stageLabel) return "실행 단계만 알 수 있습니다. 완료 비율은 측정되지 않습니다.";
  return "진행률을 측정할 근거가 없습니다.";
}

const TIME_FORMAT = { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" };

/** The last time the row changed. Labelled as such — never as a deadline. */
export function missionUpdatedLabel(mission, { locale = "ko" } = {}) {
  const value = mission?.updatedAt ?? null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return "변경 기록 없음";
  return `최근 변경 ${new Intl.DateTimeFormat(locale, TIME_FORMAT).format(new Date(parsed))}`;
}

/**
 * A due date, only when one was set.
 *
 * Cloud work items have no due date at all, so this reports the absence rather
 * than dressing `updated_at` up as one.
 */
export function missionDueLabel(mission) {
  const due = typeof mission?.due === "string" ? mission.due.trim() : "";
  return due || "기한 없음";
}

export function missionOwnerLabel(mission, fallbackName = "") {
  return mission?.ownerLabel || fallbackName || mission?.owner || "미배정";
}

/**
 * The one-line "what is this profile doing" for a roster tile or agent console.
 *
 * Returns the real work title when there is active work, and otherwise the
 * projection's explanation of why there is none. There is no per-profile stock
 * sentence anywhere in this path.
 */
export function activityHeadline(activity) {
  const text = typeof activity?.text === "string" ? activity.text.trim() : "";
  if (text) return text;
  return activity?.meaning || "맡긴 업무가 없습니다.";
}

/** Whether `activityHeadline` is naming real work or explaining its absence. */
export function activityHasWork(activity) {
  return Boolean(typeof activity?.text === "string" && activity.text.trim());
}
