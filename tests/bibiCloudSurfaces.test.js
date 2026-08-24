import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("all organization-bearing workspace routes use authenticated Bibi cloud surfaces", async () => {
  const [surface, app] = await Promise.all([read("src/bibi/surface.js"), read("src/App.jsx")]);
  for (const view of ["ceo", "office", "chat", "meeting", "kanban", "command", "data", "sessions", "team"]) {
    assert.match(surface, new RegExp(`\\b${view}\\b`), `${view} must be a Bibi surface`);
  }
  assert.match(app, /<BibiWorkspace\s+surface=\{view\}/);
  assert.match(app, /\{!bibiSurface && view === "meeting"/);
  assert.match(app, /\{!bibiSurface && view === "data"/);
  assert.match(app, /\{!bibiSurface && \(\s*<section[\s\S]*?persistent-chat-runtime/);
  assert.match(app, /useEffect\(\(\) => \{\s*if \(bibiSurface\) return undefined;\s*const initialLoad = window\.setTimeout\(refresh, 0\)/);
});

test("meeting and data room contracts are durable, owner scoped, and provenance preserving", async () => {
  const [client, migration, surfaces] = await Promise.all([
    read("src/cloud/workspaceClient.js"),
    read("supabase/migrations/20260824000700_bibi_meetings.sql"),
    read("src/BibiCloudSurfaces.jsx"),
  ]);
  assert.match(client, /export async function startMeeting/);
  assert.match(client, /export async function loadMeetings/);
  assert.match(client, /export async function loadDataRoomArtifacts/);
  assert.match(migration, /create table if not exists public\.bibi_meetings/i);
  assert.match(migration, /create table if not exists public\.bibi_meeting_participants/i);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /kind in \('work', 'chat', 'meeting'\)/);
  assert.match(surfaces, /work_item_id/);
  assert.match(surfaces, /execution_profile_id/);
  assert.match(surfaces, /profile_id/);
  assert.doesNotMatch(surfaces, /localStorage|\/bridge\/data-room|\/hermes/);
});

test("the cloud surface renders the canonical 18-profile roster", async () => {
  const surfaces = await read("src/BibiCloudSurfaces.jsx");
  assert.match(surfaces, /18 \/ 18/);
  assert.match(surfaces, /display_name/);
  assert.match(surfaces, /execution_profile/);
});
