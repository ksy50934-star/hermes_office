import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const MIGRATION = "supabase/migrations/20260827000100_bibi_meeting_completion.sql";

/** The completion function body, isolated from the rest of the migration. */
function completionFunction(sql) {
  const start = sql.indexOf("create or replace function public.bibi_complete_meeting");
  assert.ok(start > -1, "bibi_complete_meeting must exist");
  const end = sql.indexOf("revoke execute on function public.bibi_complete_meeting", start);
  assert.ok(end > start, "the function must be followed by its grants");
  return sql.slice(start, end);
}

/** The backfill statement, isolated from the rest of the migration. */
function backfill(sql) {
  const start = sql.indexOf("with participant_state as (");
  assert.ok(start > -1, "the backfill must exist");
  return sql.slice(start, sql.indexOf(";", sql.indexOf("s.terminal = s.participants", start)) + 1);
}

// ---------------------------------------------------------------------------
// Owner scoping and RLS
// ---------------------------------------------------------------------------

test("completion is a narrow definer RPC and every statement is still scoped to the authenticated owner", async () => {
  const sql = await read(MIGRATION);
  const fn = completionFunction(sql);

  // Direct UPDATE is revoked below, so the RPC needs definer privileges. The
  // fixed search path and explicit auth.uid owner predicates are mandatory.
  assert.match(fn, /security definer/);
  assert.doesNotMatch(fn, /security invoker/);
  assert.match(fn, /set search_path = ''/);
  assert.match(fn, /v_owner uuid := \(select auth\.uid\(\)\)/);
  assert.match(fn, /if v_owner is null then raise exception 'AUTH_REQUIRED'/);

  // Owner scoping is not left to RLS alone: every statement names it.
  assert.match(fn, /from public\.bibi_meetings m\s+where m\.id = p_meeting_id and m\.owner_id = v_owner/);
  assert.match(fn, /where p\.meeting_id = v_meeting\.id and p\.owner_id = v_owner/);
  assert.match(fn, /on w\.id = p\.work_item_id and w\.owner_id = v_owner/);
  assert.match(fn, /update public\.bibi_meetings m[\s\S]*?where m\.id = v_meeting\.id\s+and m\.owner_id = v_owner/);
});

test("only the authenticated role may complete a meeting", async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /revoke execute on function public\.bibi_complete_meeting\(uuid, text\) from public;/);
  assert.match(sql, /grant execute on function public\.bibi_complete_meeting\(uuid, text\) to authenticated;/);
  assert.doesNotMatch(sql, /grant execute on function public\.bibi_complete_meeting\(uuid, text\) to anon/);
});

test("authenticated browsers have no direct meeting UPDATE surface", async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /drop policy if exists "bibi_meetings_update_own" on public\.bibi_meetings/);
  assert.match(sql, /revoke update on table public\.bibi_meetings from authenticated/);
  assert.doesNotMatch(sql, /create policy "bibi_meetings_update_own"/);
  assert.doesNotMatch(sql, /grant update on (table )?public\.bibi_meetings to authenticated/);
});

test("the obsolete client update guard is removed rather than left as a bypass", async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /drop trigger if exists bibi_meetings_client_update_guard on public\.bibi_meetings/);
  assert.match(sql, /drop function if exists public\.bibi_meetings_client_update_guard\(\)/);
  assert.doesNotMatch(sql, /create trigger bibi_meetings_client_update_guard/);
  assert.doesNotMatch(sql, /create or replace function public\.bibi_meetings_client_update_guard/);
});

test("meeting creation is owner-scoped and idempotent across transport retries", async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /add column if not exists client_request_id text/);
  assert.match(sql, /create unique index if not exists bibi_meetings_owner_request_uidx\s+on public\.bibi_meetings \(owner_id, client_request_id\)/);
  assert.match(sql, /drop function public\.bibi_start_meeting\(text, text\[\]\)/);
  assert.match(sql, /create function public\.bibi_start_meeting\([\s\S]*p_client_request_id text/);
  assert.match(sql, /on conflict \(owner_id, client_request_id\) where client_request_id is not null do nothing/);
  assert.match(sql, /where m\.owner_id = v_owner and m\.client_request_id = v_request_id/);
  assert.match(sql, /revoke execute on function public\.bibi_start_meeting\(text, text\[\], text\) from public/);
  assert.match(sql, /grant execute on function public\.bibi_start_meeting\(text, text\[\], text\) to authenticated/);
});

test("the browser sends the stable meeting request ID to the RPC", async () => {
  const [client, app] = await Promise.all([read("src/cloud/workspaceClient.js"), read("src/App.jsx")]);
  assert.match(client, /p_client_request_id: requestId/);
  assert.match(app, /clientRequestId: meeting\.id \?\? crypto\.randomUUID\(\)/);
});

// ---------------------------------------------------------------------------
// Idempotency and concurrency
// ---------------------------------------------------------------------------

test("completion locks the meeting row before it decides anything", async () => {
  const fn = completionFunction(await read(MIGRATION));
  const lock = fn.indexOf("for update");
  const decision = fn.indexOf("if v_meeting.status in ('complete', 'cancelled') then");
  assert.ok(lock > -1, "the meeting row must be locked");
  assert.ok(lock < decision, "the lock must be taken before the status is acted on");
  // The write re-checks the status it locked on, so nothing can complete twice
  // even if the lock were ever bypassed.
  assert.match(fn, /and m\.status = 'running'/);
});

test("complete and cancelled meetings are immutable and retries write nothing", async () => {
  const fn = completionFunction(await read(MIGRATION));
  const idempotentBranch = fn.slice(
    fn.indexOf("if v_meeting.status in ('complete', 'cancelled') then"),
    fn.indexOf("if v_mode = 'automatic'"),
  );
  assert.match(idempotentBranch, /return query select v_meeting\.id, v_meeting\.topic, v_meeting\.status/);
  assert.match(idempotentBranch, /v_meeting\.completed_at, v_meeting\.completion_mode/);
  assert.doesNotMatch(idempotentBranch, /update public\./);
  assert.match(idempotentBranch, /false;\s*\n\s*return;/, "it must report that nothing was completed now");
  assert.match(fn, /and m\.status = 'running'/);
});

// ---------------------------------------------------------------------------
// The terminal condition, and manual completion
// ---------------------------------------------------------------------------

test("automatic completion requires one participant and every linked work item terminal", async () => {
  const fn = completionFunction(await read(MIGRATION));

  assert.match(
    fn,
    /count\(\*\) filter \(\s*where p\.work_item_id is not null\s*and w\.id is not null\s*and w\.status in \('succeeded', 'failed', 'cancelled'\)\s*\)/,
  );
  assert.match(fn, /if v_mode = 'automatic' and not \(v_participants > 0 and v_terminal = v_participants\) then/);
  // Declining is an ordinary answer for a realtime caller, not an error.
  const declineBranch = fn.slice(fn.indexOf("if v_mode = 'automatic'"), fn.indexOf("update public.bibi_meetings m"));
  assert.doesNotMatch(declineBranch, /raise exception/);
});

test("manual completion is available to the owner whatever the work is doing", async () => {
  const fn = completionFunction(await read(MIGRATION));
  // The terminal condition is guarded by `v_mode = 'automatic'`, so the manual
  // path never reaches it.
  assert.equal((fn.match(/v_terminal = v_participants/g) ?? []).length, 1);
  assert.match(fn, /v_mode text := lower\(coalesce\(nullif\(btrim\(p_mode\), ''\), 'manual'\)\)/);
  assert.match(fn, /if v_mode not in \('manual', 'automatic'\) then raise exception 'INVALID_COMPLETION_MODE'/);
  assert.match(fn, /completion_mode = v_mode/);
});

test("completing a meeting never touches the work behind it", async () => {
  const sql = await read(MIGRATION);
  const fn = completionFunction(sql);
  assert.doesNotMatch(fn, /update public\.work_items/);
  assert.doesNotMatch(fn, /insert into public\.work_(items|results|evidence|events)/);
  assert.doesNotMatch(fn, /delete from public\./);
  // Nor does anything else in this migration: terminal work stays as the
  // connector reported it.
  assert.doesNotMatch(sql, /update public\.work_items/);
});

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

test("the backfill closes exactly the meetings the automatic rule would close", async () => {
  const sql = await read(MIGRATION);
  const statement = backfill(sql);

  assert.match(statement, /where s\.meeting_id = m\.id\s*and m\.status = 'running'/);
  assert.match(statement, /and s\.participants > 0/);
  assert.match(statement, /and s\.terminal = s\.participants/);
  assert.match(
    statement,
    /count\(\*\) filter \(\s*where p\.work_item_id is not null\s*and w\.id is not null\s*and w\.status in \('succeeded', 'failed', 'cancelled'\)\s*\)/,
  );
  assert.match(statement, /on w\.id = p\.work_item_id and w\.owner_id = p\.owner_id/, "owners must not be crossed");
  assert.match(statement, /completion_mode = 'automatic'/);
});

test("the backfill dates a meeting from its own work, never from the deploy", async () => {
  const statement = backfill(await read(MIGRATION));
  assert.match(statement, /max\(coalesce\(w\.updated_at, w\.created_at\)\) as last_terminal_at/);
  assert.match(statement, /completed_at = greatest\(s\.last_terminal_at, m\.created_at\)/);
  assert.match(statement, /and s\.last_terminal_at is not null/);
  assert.doesNotMatch(statement, /completed_at = now\(\)/);
});

test("the migration destroys nothing and stays forward-only", async () => {
  const sql = await read(MIGRATION);
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+column\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  // Adding the completed_at rule must never fail an apply because of a row that
  // predates it.
  assert.match(sql, /check \(status <> 'complete' or completed_at is not null\) not valid/);
});

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

test("result and evidence rows are published, so a landing result is an event", async () => {
  const sql = await read(MIGRATION);
  for (const table of ["work_results", "work_evidence"]) {
    assert.match(sql, new RegExp(`alter publication supabase_realtime add table public\\.${table};`));
  }
  assert.match(sql, /alter table public\.bibi_meetings replica identity full/);
  assert.match(sql, /alter table public\.bibi_meeting_participants replica identity full/);
});

test("every realtime table the workspace binds triggers an owner-scoped readback", async () => {
  const workspace = await read("src/BibiWorkspace.jsx");
  const subscription = workspace.slice(
    workspace.indexOf("return subscribeToWorkspace({"),
    workspace.indexOf("// ---- connector health"),
  );

  for (const handler of ["onMeeting", "onMeetingParticipant", "onResult", "onEvidence"]) {
    assert.match(
      subscription,
      new RegExp(`${handler}: \\(\\) => \\{ setCloudRevision\\(\\(current\\) => current \\+ 1\\); void refresh\\(\\); \\}`),
      `${handler} must re-read the snapshot`,
    );
  }
  // A meeting participant's work item going terminal changes no row on
  // bibi_meetings, so merging it in place would leave the meeting stale.
  assert.match(subscription, /if \(row\.kind === "meeting"\) \{ void refresh\(\); return; \}/);
  // A reconnect replays nothing that happened while the socket was down.
  assert.match(subscription, /onResync: refresh/);
  // The readback is the owner's own snapshot: it is gated on the session's
  // owner id and every query under it runs under RLS.
  assert.match(workspace, /if \(!cloud\.configured \|\| !ownerId\) return null;/);
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

test("the cloud active meeting list is built from the non-complete meetings only", async () => {
  const app = await read("src/App.jsx");
  assert.match(app, /partitionCloudMeetings\(bibiCloudSnapshot\?\.meetings \?\? \[\]\)/);
  assert.match(app, /const cloudRuntimeMeetings = useMemo\(\(\) => cloudMeetingSplit\.active\.map/);
  assert.match(app, /const effectiveMeetings = bibiCloudView \? cloudRuntimeMeetings : activeMeetings/);
});

test("closing a cloud meeting persists through the RPC and reads it back", async () => {
  const app = await read("src/App.jsx");
  assert.match(app, /completeMeetingWithReadback as completeBibiMeetingWithReadback/);
  assert.match(app, /await completeBibiMeetingWithReadback\(\{ meetingId: meeting\.id, mode \}\)/);
  assert.match(app, /if \(bibiCloudView\) \{\s*setMeetingCloseError\(""\);\s*completeCloudMeeting\(meeting\)/);
  assert.match(app, /<BibiCloudMeetingConsole meeting=\{meeting\} onExit=\{\(\) => navigate\("office"\)\} onComplete=\{completeCloudMeeting\} \/>/);
  // The close control is no longer withheld from the cloud surface.
  assert.doesNotMatch(app, /\{!bibiCloudView && <button\s+type="button"\s+className="meeting-runtime-tab-close"/);
});

test("the surface asks for automatic completion only under the rule the database enforces", async () => {
  const app = await read("src/App.jsx");
  assert.match(app, /\.filter\(isMeetingAutoCompletable\)/);
  assert.match(app, /await completeCloudMeeting\(meeting, "automatic"\)/);
  assert.match(app, /autoCompletedMeetingsRef/);
  assert.match(app, /const completion = await completeBibiMeeting\(\{ meetingId: meeting\.id, mode \}\);\s*if \(completion\.status !== "complete"\) return false;/);
});

test("every Bibi Cloud meeting view reads its archive from the durable snapshot", async () => {
  const [app, surfaces, archive] = await Promise.all([
    read("src/App.jsx"),
    read("src/BibiCloudSurfaces.jsx"),
    read("src/SessionArchive.jsx"),
  ]);

  // The archive adapter is fed the snapshot's meetings, not a browser cache.
  assert.match(app, /createCloudArchiveAdapter\(\{\s*archive: bibiCloudSnapshot\.archive \?\? \[\],\s*meetings: bibiCloudSnapshot\.meetings \?\? \[\],/);
  // The meeting surface renders the snapshot array it is handed, and splits it.
  assert.match(surfaces, /export function BibiMeetingSurface\(\{ roster, availabilityFor, meetings = \[\]/);
  assert.match(surfaces, /partitionCloudMeetings\(meetings\)/);
  assert.match(surfaces, /data-meeting-list="active"/);
  assert.match(surfaces, /data-meeting-list="archive"/);
  assert.doesNotMatch(surfaces, /localStorage/);
  // And the reader refuses the local meeting cache whenever a cloud adapter is
  // in play.
  assert.match(archive, /useState\(\(\) => \(archiveAdapter \? null : loadArchiveSnapshot\(\)\)\)/);
  assert.match(archive, /archiveSnapshot\?\.meetings \?\? \(archiveAdapter \? \[\] : loadMeetings\(\)\)/);
});

test("the meeting record shows real rows and never a manufactured summary", async () => {
  const [record, console_, adapter] = await Promise.all([
    read("src/BibiMeetingRecord.jsx"),
    read("src/BibiCloudMeetingConsole.jsx"),
    read("src/bibi/archiveAdapter.js"),
  ]);

  assert.match(record, /WORK_RESULT/);
  assert.match(record, /EVIDENCE/);
  assert.match(record, /이 참여자가 남긴 결과나 증거가 없습니다/);
  assert.match(adapter, /outcome: null/);
  // The old console joined every statement into a field labelled 요약.
  assert.doesNotMatch(console_, /entries\.map\(\(entry\) => entry\.text\)\.filter\(Boolean\)\.join/);
  assert.doesNotMatch(console_, /<small>요약<\/small>/);
});

test("a follow-up is filed from an explicit selection, once", async () => {
  const record = await read("src/BibiMeetingRecord.jsx");
  assert.match(record, /type="radio"/);
  assert.match(record, /disabled=\{!selected \|\| busy\}/);
  assert.match(record, /meetingFollowupKey\(\{ meetingId: record\.id, candidate \}\)/);
  assert.match(record, /result\?\.duplicate/);
  assert.match(record, /요약이나 새로운 문장은 만들지 않습니다/);
});
