/**
 * What a durable Bibi Cloud meeting is, in the browser's terms.
 *
 * The rules here are the client-side reading of `bibi_complete_meeting`. They
 * exist so the UI can decide what to show and when to ask the database to
 * complete something — never so it can decide a meeting is over on its own. The
 * database re-derives the same condition from the work rows before it writes,
 * so a wrong answer here shows the wrong badge for a moment; it cannot end a
 * meeting that has not ended.
 *
 * Nothing in this module invents text. A meeting with no result rows describes
 * itself as having none, because "the profiles produced nothing yet" and "here
 * is a summary of what they said" are not the same claim.
 */

import { isTerminalStatus, TERMINAL_STATUSES } from "./workLifecycle.js";

export const MEETING_STATUS = Object.freeze({
  RUNNING: "running",
  COMPLETE: "complete",
  CANCELLED: "cancelled",
});

/** How a completed meeting got there. Mirrors the column's check constraint. */
export const MEETING_COMPLETION_MODE = Object.freeze({
  MANUAL: "manual",
  AUTOMATIC: "automatic",
});

/** The work states that let a meeting complete by itself. */
export const MEETING_TERMINAL_WORK_STATUSES = TERMINAL_STATUSES;

/** Meeting states that belong in the archive rather than on the active list. */
const ARCHIVED_MEETING_STATUSES = new Set([MEETING_STATUS.COMPLETE, MEETING_STATUS.CANCELLED]);

export function isMeetingComplete(meeting) {
  return meeting?.status === MEETING_STATUS.COMPLETE;
}

/**
 * A participant is finished when it links to a work item that reached a
 * terminal state. A participant with no `work_item_id` is *not* finished: the
 * link is set null when a work item goes away, and an absent link is not
 * evidence of completed work.
 */
export function isMeetingParticipantTerminal(participant) {
  if (!participant?.work_item_id) return false;
  return isTerminalStatus(participant.work?.status);
}

/**
 * Whether the database would accept an automatic completion for this meeting.
 * A meeting with no participants never qualifies — "every participant is
 * finished" is vacuously true over an empty list, and a meeting nobody was
 * assigned to is not a meeting that concluded.
 */
export function isMeetingAutoCompletable(meeting) {
  if (!meeting || meeting.status !== MEETING_STATUS.RUNNING) return false;
  const participants = meeting.participants ?? [];
  return participants.length > 0 && participants.every(isMeetingParticipantTerminal);
}

/**
 * Split the owner's meetings into the ones still open and the ones that are
 * records. Cancelled meetings archive alongside completed ones and keep their
 * own status when rendered — they are over, so they do not belong on a list of
 * meetings the user can still join.
 */
export function partitionCloudMeetings(meetings = []) {
  const active = [];
  const completed = [];
  for (const meeting of Array.isArray(meetings) ? meetings : []) {
    if (ARCHIVED_MEETING_STATUSES.has(meeting?.status)) completed.push(meeting);
    else active.push(meeting);
  }
  return { active, completed };
}

export function activeCloudMeetings(meetings = []) {
  return partitionCloudMeetings(meetings).active;
}

export function completedCloudMeetings(meetings = []) {
  return partitionCloudMeetings(meetings).completed;
}

function millis(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * One participant's real contribution: what was assigned, what state it reached
 * and every result and evidence row persisted against it.
 */
function describeParticipant(participant) {
  const results = (participant.results ?? (participant.result ? [participant.result] : []))
    .map((result) => ({
      id: result.id,
      summary: textOf(result.summary),
      detail: textOf(result.detail),
      createdAt: result.created_at ?? null,
      timestamp: millis(result.created_at),
    }))
    .sort((left, right) => left.timestamp - right.timestamp);

  const evidence = (participant.evidence ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    label: textOf(item.label),
    sha256: item.sha256 ?? null,
    byteSize: item.byte_size ?? null,
    storagePath: item.storage_path ?? null,
    excerpt: textOf(item.inline_excerpt),
    executionProfileId: item.execution_profile_id ?? null,
    createdAt: item.created_at ?? null,
  }));

  return {
    id: participant.id,
    profileId: participant.profile_id,
    workItemId: participant.work_item_id ?? null,
    workStatus: participant.work?.status ?? null,
    workError: textOf(participant.work?.error) || null,
    terminal: isMeetingParticipantTerminal(participant),
    results,
    evidence,
  };
}

/**
 * The honest record of a meeting.
 *
 * `outcome` is deliberately null and stays null. The old local meeting console
 * produced one by joining every statement together and labelling the result a
 * summary; a cloud meeting has no such artifact, and manufacturing one here
 * would put words in eighteen profiles' mouths. What the meeting actually
 * produced is `participants[].results` and `participants[].evidence`, verbatim.
 */
export function describeMeetingRecord(meeting) {
  const participants = (meeting?.participants ?? []).map(describeParticipant);
  return {
    id: meeting?.id,
    topic: meeting?.topic ?? "",
    status: meeting?.status ?? MEETING_STATUS.RUNNING,
    completionMode: meeting?.completion_mode ?? null,
    createdAt: meeting?.created_at ?? null,
    completedAt: meeting?.completed_at ?? null,
    updatedAt: millis(meeting?.completed_at) || millis(meeting?.created_at),
    participants,
    participantCount: participants.length,
    terminalCount: participants.filter((participant) => participant.terminal).length,
    resultCount: participants.reduce((sum, participant) => sum + participant.results.length, 0),
    evidenceCount: participants.reduce((sum, participant) => sum + participant.evidence.length, 0),
    outcome: null,
  };
}

/**
 * Every span of persisted text a follow-up could be filed from, as its own
 * selectable candidate.
 *
 * A result's summary and its detail are listed separately rather than merged,
 * because the user is choosing which sentence becomes the next piece of work
 * and that choice has to be over text that was really written, not over a
 * concatenation this function assembled.
 */
export function meetingFollowupCandidates(record) {
  const candidates = [];
  for (const participant of record?.participants ?? []) {
    for (const result of participant.results) {
      if (result.summary) {
        candidates.push({
          id: `${result.id}:summary`,
          sourceId: result.id,
          sourceKind: "work_result.summary",
          profileId: participant.profileId,
          workItemId: participant.workItemId,
          text: result.summary,
        });
      }
      if (result.detail && result.detail !== result.summary) {
        candidates.push({
          id: `${result.id}:detail`,
          sourceId: result.id,
          sourceKind: "work_result.detail",
          profileId: participant.profileId,
          workItemId: participant.workItemId,
          text: result.detail,
        });
      }
    }
    for (const item of participant.evidence) {
      if (!item.excerpt) continue;
      candidates.push({
        id: `${item.id}:excerpt`,
        sourceId: item.id,
        sourceKind: "work_evidence.inline_excerpt",
        profileId: participant.profileId,
        workItemId: participant.workItemId,
        text: item.excerpt,
      });
    }
  }
  return candidates;
}

/**
 * A 32-bit FNV-1a digest, in hex.
 *
 * The follow-up key has to be stable across reloads, browsers and retries, so
 * it cannot be random, and it has to be computable synchronously, so it cannot
 * be WebCrypto's async digest. This is not a security primitive — it exists so
 * that the same selection produces the same idempotency key twice.
 */
export function stableDigest(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Collapse the whitespace a selection can pick up without changing the words. */
function normalizeSelection(text) {
  return textOf(text).replace(/\s+/g, " ");
}

export function meetingFollowupKey({ meetingId, candidate } = {}) {
  const meeting = textOf(meetingId);
  const sourceId = textOf(candidate?.sourceId ?? candidate?.id);
  const text = normalizeSelection(candidate?.text);
  if (!meeting || !sourceId || !text) return null;
  return `meeting-followup:${meeting}:${sourceId}:${stableDigest(text)}`;
}

/** The first line of the selection, which is what the user is looking at. */
function followupTitle(text) {
  const firstLine = normalizeSelection(text).split(/(?<=[.!?。])\s/)[0] ?? "";
  const title = (firstLine || normalizeSelection(text)).slice(0, 110);
  return title;
}

/**
 * Turn one explicitly selected span into a work intake request.
 *
 * The title is the selection's own opening sentence and the brief is the
 * selection verbatim, followed by the ids it came from. Nothing is summarized,
 * rephrased or added: a follow-up is the user promoting a sentence somebody
 * really wrote, not this module deciding what the meeting implied.
 *
 * The returned `clientRequestId` is derived from the meeting, the source row and
 * the selected text, so filing the same selection twice hits the intake unique
 * constraint and returns the first work item instead of creating a second.
 */
export function meetingFollowupRequest({ meetingId, candidate } = {}) {
  const clientRequestId = meetingFollowupKey({ meetingId, candidate });
  if (!clientRequestId) throw new Error("후속 업무로 만들 결과 텍스트를 먼저 선택해 주세요.");
  const text = textOf(candidate.text);
  return {
    clientRequestId,
    profileId: candidate.profileId ?? null,
    title: followupTitle(text),
    brief: [
      text,
      "",
      `출처: meeting_id=${meetingId}`,
      `출처: work_item_id=${candidate.workItemId ?? "unknown"}`,
      `출처: ${candidate.sourceKind ?? "work_result"}=${candidate.sourceId ?? candidate.id}`,
    ].join("\n"),
  };
}

/**
 * Which follow-ups already exist, keyed by the selection they came from.
 *
 * Idempotency is enforced by the database, but the user should not have to
 * press the button to find that out. Work items carry the key they were filed
 * with, so an already-filed selection can be shown as filed.
 */
export function indexMeetingFollowups(workItems = []) {
  const byKey = new Map();
  for (const item of Array.isArray(workItems) ? workItems : []) {
    const key = textOf(item?.client_request_id);
    if (key.startsWith("meeting-followup:")) byKey.set(key, item);
  }
  return byKey;
}
