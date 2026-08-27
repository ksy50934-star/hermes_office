import assert from "node:assert/strict";
import test from "node:test";

import {
  activeCloudMeetings,
  completedCloudMeetings,
  describeMeetingRecord,
  indexMeetingFollowups,
  isMeetingAutoCompletable,
  isMeetingComplete,
  isMeetingParticipantTerminal,
  meetingFollowupCandidates,
  meetingFollowupKey,
  meetingFollowupRequest,
  partitionCloudMeetings,
} from "../src/bibi/meetingLifecycle.js";
import { cloudArchiveView, createCloudArchiveAdapter } from "../src/bibi/archiveAdapter.js";
import { completeMeetingWithReadback, createMeetingFollowup } from "../src/cloud/workspaceClient.js";

function participant(overrides = {}) {
  return {
    id: overrides.id ?? "participant-1",
    profile_id: overrides.profile_id ?? "bibi-02",
    work_item_id: "work_item_id" in overrides ? overrides.work_item_id : "work-1",
    work: "work" in overrides ? overrides.work : { id: "work-1", status: "succeeded" },
    results: overrides.results ?? [],
    evidence: overrides.evidence ?? [],
  };
}

function meeting(overrides = {}) {
  return {
    id: overrides.id ?? "meeting-1",
    topic: overrides.topic ?? "배포 판단",
    status: overrides.status ?? "running",
    completion_mode: overrides.completion_mode ?? null,
    created_at: overrides.created_at ?? "2026-08-27T01:00:00.000Z",
    completed_at: overrides.completed_at ?? null,
    participants: overrides.participants ?? [participant()],
  };
}

// ---------------------------------------------------------------------------
// Terminal condition
// ---------------------------------------------------------------------------

test("a participant is terminal only when a linked work item reached a terminal state", () => {
  for (const status of ["succeeded", "failed", "cancelled"]) {
    assert.equal(isMeetingParticipantTerminal(participant({ work: { status } })), true, status);
  }
  for (const status of ["intake", "assigned", "leased", "running", "blocked"]) {
    assert.equal(isMeetingParticipantTerminal(participant({ work: { status } })), false, status);
  }
});

test("a participant with no linked work item is never terminal", () => {
  // `bibi_meeting_participants.work_item_id` is set null when the work item
  // goes away. An absent link is not evidence of finished work, so it must not
  // be able to complete a meeting.
  assert.equal(isMeetingParticipantTerminal(participant({ work_item_id: null, work: null })), false);
  assert.equal(isMeetingParticipantTerminal(participant({ work: null })), false);
});

test("automatic completion needs at least one participant and every one of them terminal", () => {
  assert.equal(isMeetingAutoCompletable(meeting()), true);
  assert.equal(
    isMeetingAutoCompletable(meeting({ participants: [] })),
    false,
    "a meeting nobody was assigned to did not conclude",
  );
  assert.equal(
    isMeetingAutoCompletable(meeting({
      participants: [participant(), participant({ id: "participant-2", work: { status: "running" } })],
    })),
    false,
  );
  assert.equal(
    isMeetingAutoCompletable(meeting({
      participants: [participant(), participant({ id: "participant-2", work_item_id: null, work: null })],
    })),
    false,
  );
});

test("a meeting that already ended is never auto-completed again", () => {
  const completed = meeting({ status: "complete", completed_at: "2026-08-27T02:00:00.000Z" });
  assert.equal(isMeetingComplete(completed), true);
  assert.equal(isMeetingAutoCompletable(completed), false);
  assert.equal(isMeetingAutoCompletable(meeting({ status: "cancelled" })), false);
});

// ---------------------------------------------------------------------------
// Active / archive separation
// ---------------------------------------------------------------------------

test("the active list holds only meetings that have not ended", () => {
  const rows = [
    meeting({ id: "running" }),
    meeting({ id: "done", status: "complete", completed_at: "2026-08-27T02:00:00.000Z" }),
    meeting({ id: "stopped", status: "cancelled" }),
  ];
  const { active, completed } = partitionCloudMeetings(rows);

  assert.deepEqual(active.map((item) => item.id), ["running"]);
  assert.deepEqual(completed.map((item) => item.id), ["done", "stopped"]);
  assert.deepEqual(activeCloudMeetings(rows).map((item) => item.id), ["running"]);
  assert.deepEqual(completedCloudMeetings(rows).map((item) => item.id), ["done", "stopped"]);
  assert.equal(active.every((item) => item.status !== "complete"), true);
});

// ---------------------------------------------------------------------------
// Honest record
// ---------------------------------------------------------------------------

test("the meeting record reports the persisted work, result and evidence rows verbatim", () => {
  const record = describeMeetingRecord(meeting({
    status: "complete",
    completion_mode: "automatic",
    completed_at: "2026-08-27T02:00:00.000Z",
    participants: [
      participant({
        results: [{ id: "result-1", summary: "배포 보류", detail: "회귀를 먼저 수정합니다.", created_at: "2026-08-27T01:30:00.000Z" }],
        evidence: [{ id: "evidence-1", kind: "log", label: "regression.log", inline_excerpt: "3 failing", execution_profile_id: "bibi-02" }],
      }),
      participant({ id: "participant-2", profile_id: "bibi-03", work_item_id: "work-2", work: { status: "failed", error: "gateway timeout" } }),
    ],
  }));

  assert.equal(record.participantCount, 2);
  assert.equal(record.terminalCount, 2);
  assert.equal(record.resultCount, 1);
  assert.equal(record.evidenceCount, 1);
  assert.equal(record.completionMode, "automatic");
  assert.equal(record.participants[0].results[0].detail, "회귀를 먼저 수정합니다.");
  assert.equal(record.participants[0].evidence[0].excerpt, "3 failing");
  assert.equal(record.participants[1].workError, "gateway timeout");
  // A participant that produced nothing produces nothing here either.
  assert.deepEqual(record.participants[1].results, []);
});

test("no meeting outcome is ever synthesized from the participants' text", () => {
  const record = describeMeetingRecord(meeting({
    participants: [
      participant({ results: [{ id: "r1", summary: "첫 결론", detail: "근거 A", created_at: "2026-08-27T01:10:00.000Z" }] }),
      participant({ id: "p2", work_item_id: "work-2", results: [{ id: "r2", summary: "둘째 결론", detail: "근거 B", created_at: "2026-08-27T01:20:00.000Z" }] }),
    ],
  }));

  assert.equal(record.outcome, null);
  assert.equal("decisions" in record, false);
  assert.equal("summary" in record, false);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("첫 결론\n\n둘째 결론"), false, "statements must not be joined into a summary");
});

test("a participant's single `result` field is still understood by the record", () => {
  // `loadMeetings` keeps `result` for the callers that render one statement per
  // speaker. The record reads `results` first and falls back to it.
  const record = describeMeetingRecord({
    id: "meeting-1",
    participants: [{ id: "p1", profile_id: "bibi-02", work_item_id: "work-1", work: { status: "succeeded" }, result: { id: "r1", summary: "확인", created_at: "2026-08-27T01:00:00.000Z" } }],
  });
  assert.equal(record.resultCount, 1);
  assert.equal(record.participants[0].results[0].summary, "확인");
});

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------

const FOLLOWUP_MEETING = meeting({
  status: "complete",
  completed_at: "2026-08-27T02:00:00.000Z",
  participants: [participant({
    results: [{ id: "result-1", summary: "회귀 테스트 추가", detail: "release 파이프라인에 회귀 테스트를 추가한다.", created_at: "2026-08-27T01:30:00.000Z" }],
    evidence: [{ id: "evidence-1", kind: "log", label: "run.log", inline_excerpt: "exit 1" }],
  })],
});

test("follow-up candidates are the persisted spans themselves, listed separately", () => {
  const candidates = meetingFollowupCandidates(describeMeetingRecord(FOLLOWUP_MEETING));

  assert.deepEqual(candidates.map((candidate) => candidate.sourceKind), [
    "work_result.summary",
    "work_result.detail",
    "work_evidence.inline_excerpt",
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.text), [
    "회귀 테스트 추가",
    "release 파이프라인에 회귀 테스트를 추가한다.",
    "exit 1",
  ]);
  assert.equal(candidates.every((candidate) => candidate.profileId === "bibi-02"), true);
});

test("a follow-up carries the selected text verbatim and invents no content", () => {
  const [summaryCandidate, detailCandidate] = meetingFollowupCandidates(describeMeetingRecord(FOLLOWUP_MEETING));
  const request = meetingFollowupRequest({ meetingId: "meeting-1", candidate: detailCandidate });

  assert.equal(request.profileId, "bibi-02");
  assert.equal(request.title, "release 파이프라인에 회귀 테스트를 추가한다.");
  assert.ok(request.brief.startsWith("release 파이프라인에 회귀 테스트를 추가한다."));
  assert.match(request.brief, /출처: meeting_id=meeting-1/);
  assert.match(request.brief, /출처: work_item_id=work-1/);
  assert.match(request.brief, /출처: work_result\.detail=result-1/);
  assert.notEqual(
    meetingFollowupKey({ meetingId: "meeting-1", candidate: summaryCandidate }),
    request.clientRequestId,
    "two different selections are two different follow-ups",
  );
});

test("the follow-up key is stable for the same selection and scoped to its meeting", () => {
  const [candidate] = meetingFollowupCandidates(describeMeetingRecord(FOLLOWUP_MEETING));
  const first = meetingFollowupKey({ meetingId: "meeting-1", candidate });
  const second = meetingFollowupKey({ meetingId: "meeting-1", candidate });
  const whitespaceVariant = meetingFollowupKey({
    meetingId: "meeting-1",
    candidate: { ...candidate, text: `  ${candidate.text.replace(" ", "  ")}  ` },
  });

  assert.equal(first, second);
  assert.equal(whitespaceVariant, first, "whitespace is not a different decision");
  assert.match(first, /^meeting-followup:meeting-1:result-1:[0-9a-f]{8}$/);
  assert.notEqual(meetingFollowupKey({ meetingId: "meeting-2", candidate }), first);
  assert.equal(meetingFollowupKey({ meetingId: "", candidate }), null);
  assert.equal(meetingFollowupKey({ meetingId: "meeting-1", candidate: { ...candidate, text: "   " } }), null);
});

test("filing a follow-up twice resolves to the work item the first attempt created", async () => {
  const filed = new Map();
  const calls = [];
  const fileWork = async ({ clientRequestId, title, brief, profileId, ownerId }) => {
    calls.push({ clientRequestId, title, ownerId });
    if (filed.has(clientRequestId)) return { workItem: filed.get(clientRequestId), duplicate: true };
    const workItem = { id: `work-${filed.size + 1}`, profile_id: profileId, title, brief, client_request_id: clientRequestId };
    filed.set(clientRequestId, workItem);
    return { workItem, duplicate: false };
  };

  const [candidate] = meetingFollowupCandidates(describeMeetingRecord(FOLLOWUP_MEETING));
  const input = { ownerId: "owner-1", meetingId: "meeting-1", candidate };
  const first = await createMeetingFollowup(input, { fileWork });
  const second = await createMeetingFollowup(input, { fileWork });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.workItem.id, first.workItem.id);
  assert.equal(second.clientRequestId, first.clientRequestId);
  assert.equal(filed.size, 1);
  assert.deepEqual(calls.map((call) => call.ownerId), ["owner-1", "owner-1"]);
});

test("a follow-up cannot be filed from a selection that is not there", async () => {
  await assert.rejects(
    () => createMeetingFollowup(
      { ownerId: "owner-1", meetingId: "meeting-1", candidate: { sourceId: "result-1", text: "" } },
      { fileWork: async () => { throw new Error("must not file"); } },
    ),
    /결과 텍스트를 먼저 선택/,
  );
});

test("already-filed follow-ups are recognised by their intake key", () => {
  const index = indexMeetingFollowups([
    { id: "work-1", client_request_id: "meeting-followup:meeting-1:result-1:0badf00d" },
    { id: "work-2", client_request_id: "intake-9" },
    { id: "work-3" },
  ]);
  assert.equal(index.size, 1);
  assert.equal(index.get("meeting-followup:meeting-1:result-1:0badf00d").id, "work-1");
});

// ---------------------------------------------------------------------------
// Completion readback
// ---------------------------------------------------------------------------

test("manual completion is persisted and read back before it is reported", async () => {
  const calls = [];
  const completed = meeting({ status: "complete", completed_at: "2026-08-27T02:00:00.000Z", completion_mode: "manual" });
  const result = await completeMeetingWithReadback({ meetingId: "meeting-1", mode: "manual" }, {
    complete: async (input) => {
      calls.push(["complete", input.mode]);
      return { meetingId: "meeting-1", status: "complete", completionMode: "manual", completedNow: true };
    },
    load: async () => { calls.push(["load"]); return [completed]; },
  });

  assert.deepEqual(calls, [["complete", "manual"], ["load"]]);
  assert.equal(result.meeting.status, "complete");
  assert.equal(result.meeting.completion_mode, "manual");
  assert.equal(result.completion.completedNow, true);
});

test("manual completion works even while participant work is still running", async () => {
  // The owner walking away ends the meeting. Only the *automatic* rule needs
  // every work item terminal.
  const running = meeting({ participants: [participant({ work: { status: "running" } })] });
  assert.equal(isMeetingAutoCompletable(running), false);

  const result = await completeMeetingWithReadback({ meetingId: "meeting-1", mode: "manual" }, {
    complete: async () => ({ meetingId: "meeting-1", status: "complete", completionMode: "manual", completedNow: true }),
    load: async () => [{ ...running, status: "complete", completed_at: "2026-08-27T02:00:00.000Z", completion_mode: "manual" }],
  });
  assert.equal(result.meeting.status, "complete");
});

test("a second completion of the same meeting is idempotent, not a second record", async () => {
  const stored = meeting({ status: "complete", completed_at: "2026-08-27T02:00:00.000Z", completion_mode: "manual" });
  let writes = 0;
  const complete = async () => {
    // Mirrors `bibi_complete_meeting`: an already-complete meeting is returned
    // as it stands, with its original timestamp, and nothing is written.
    if (stored.status === "complete") {
      return { meetingId: stored.id, status: "complete", completedAt: stored.completed_at, completionMode: "manual", completedNow: false };
    }
    writes += 1;
    return { meetingId: stored.id, status: "complete", completedAt: stored.completed_at, completionMode: "manual", completedNow: true };
  };
  const deps = { complete, load: async () => [stored] };

  const first = await completeMeetingWithReadback({ meetingId: "meeting-1" }, deps);
  const second = await completeMeetingWithReadback({ meetingId: "meeting-1" }, deps);

  assert.equal(writes, 0);
  assert.equal(first.completion.completedNow, false);
  assert.equal(second.completion.completedNow, false);
  assert.equal(second.completion.completedAt, first.completion.completedAt);
});

test("a completion that did not land is reported instead of being assumed", async () => {
  await assert.rejects(
    () => completeMeetingWithReadback({ meetingId: "meeting-1" }, {
      complete: async () => ({ meetingId: "meeting-1", status: "running", completedNow: false }),
      load: async () => [meeting()],
    }),
    /아직 반영되지 않았습니다/,
  );

  await assert.rejects(
    () => completeMeetingWithReadback({ meetingId: "meeting-1" }, {
      complete: async () => ({ meetingId: "meeting-1", status: "complete", completedNow: true }),
      load: async () => [],
    }),
    /다시 확인하지 못했습니다/,
  );
});

// ---------------------------------------------------------------------------
// Cloud archive
// ---------------------------------------------------------------------------

test("the cloud archive lists completed meetings only", async () => {
  const view = cloudArchiveView({
    archive: [],
    meetings: [
      meeting({ id: "running" }),
      meeting({ id: "done", status: "complete", completed_at: "2026-08-27T02:00:00.000Z", completion_mode: "manual" }),
    ],
  });

  assert.deepEqual(view.meetings.map((item) => item.id), ["done"]);
  assert.equal(view.meetings[0].completionMode, "manual");
  assert.equal(view.meetings[0].outcome, null);
  assert.ok(view.meetings[0].record, "the archive carries the honest record");
});

test("the archive transcript is built from result and evidence rows, in written order", async () => {
  const view = cloudArchiveView({
    meetings: [meeting({
      id: "done",
      status: "complete",
      completed_at: "2026-08-27T03:00:00.000Z",
      participants: [participant({
        results: [{ id: "result-1", summary: "요지", detail: "본문", created_at: "2026-08-27T01:30:00.000Z" }],
        evidence: [{ id: "evidence-1", kind: "log", label: "run.log", inline_excerpt: "exit 1", created_at: "2026-08-27T01:00:00.000Z" }],
      })],
    })],
  });

  const entries = view.meetings[0].entries;
  assert.deepEqual(entries.map((entry) => entry.kind), ["evidence", "statement"]);
  assert.equal(entries[1].summary, "요지");
  assert.equal(entries[1].detail, "본문");
  assert.equal(view.meetings[0].followupCandidates.length, 3);
});

test("the archive adapter files a follow-up against the owner it was built for", async () => {
  const calls = [];
  const adapter = createCloudArchiveAdapter({
    ownerId: "owner-1",
    meetings: [meeting({ id: "done", status: "complete", completed_at: "2026-08-27T02:00:00.000Z", participants: [participant({ results: [{ id: "result-1", summary: "정리", created_at: "2026-08-27T01:30:00.000Z" }] })] })],
    followups: new Map([["meeting-followup:done:result-1:deadbeef", { id: "work-9" }]]),
    createFollowupFn: async (input) => { calls.push(input); return { workItem: { id: "work-1" }, duplicate: false }; },
  });

  const { meetings } = await adapter.list();
  const [candidate] = meetings[0].followupCandidates;
  await adapter.createFollowup(meetings[0], candidate);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownerId, "owner-1");
  assert.equal(calls[0].meetingId, "done");
  assert.equal(calls[0].candidate.sourceId, "result-1");
  assert.equal(adapter.followups.get("meeting-followup:done:result-1:deadbeef").id, "work-9");
});
