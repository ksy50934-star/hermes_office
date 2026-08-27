import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("owner-data routes keep specialist renderers behind the authenticated cloud controller", async () => {
  const [surface, app] = await Promise.all([read("src/bibi/surface.js"), read("src/App.jsx")]);
  for (const view of ["ceo", "office", "chat", "meeting", "kanban", "command", "data", "sessions", "team", "plugins", "system", "terminal"]) {
    assert.match(surface, new RegExp(`\\b${view}\\b`), `${view} must be a Bibi surface`);
  }
  assert.match(app, /<BibiWorkspace\s+surface=\{view\}/);
  assert.match(app, /controllerOnly=\{!bibiSurface\}/);
  assert.match(app, /view === "office"[\s\S]*?<HermesOffice/);
  assert.match(app, /view === "meeting"[\s\S]*?<MeetingLobby/);
  assert.match(app, /view === "data"[\s\S]*?<DataRoom adapter=\{bibiCloudView \? bibiDataRoomAdapter : null\}/);
  assert.doesNotMatch(app, /view === "data"[\s\S]{0,800}<BibiDataRoom/);
  assert.match(app, /view === "chat"[\s\S]*?<BibiDirectChat/);
  for (const view of ["plugins", "system", "terminal"]) {
    assert.match(app, new RegExp(`specialistSurfaceReady && view === "${view}"`));
  }
  assert.match(app, /if \(bibiCloudView\) return undefined;/);
});

test("cloud views never start the legacy organization bridge loader", async () => {
  const app = await read("src/App.jsx");
  assert.match(
    app,
    /useEffect\(\(\) => \{\s*if \(bibiCloudView\) return undefined;\s*let stopped = false;\s*loadOrganization\(\)/,
  );
  assert.match(
    app,
    /return \(\) => \{ stopped = true; \};\s*\}, \[bibiCloudView\]\);/,
  );
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

test("mobile direct chat keeps the textarea in a flexible two-column composer", async () => {
  const [chat, styles] = await Promise.all([
    read("src/BibiDirectChat.jsx"),
    read("src/styles.css"),
  ]);
  const tabletStart = styles.indexOf("@media (min-width: 641px) and (max-width: 820px)");
  const tabletEnd = styles.indexOf("@media (max-width: 430px)", tabletStart);
  const tabletStyles = styles.slice(tabletStart, tabletEnd);
  assert.match(chat, /profile-chat-layout bibi-direct-chat mobile-stage-/);
  assert.doesNotMatch(chat, /attach-button/);
  assert.match(styles, /\.profile-chat-layout\.bibi-direct-chat \.chat-composer-row\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.match(styles, /\.chat-composer-actions\s*\{\s*grid-column:\s*1 \/ -1;/);
  assert.ok(tabletStart >= 0 && tabletEnd > tabletStart);
  assert.match(tabletStyles, /\.profile-chat-layout\.bibi-direct-chat \.chat-composer-actions\s*\{\s*grid-column:\s*auto;/);
  assert.match(styles, /\.profile-chat-layout\.bibi-direct-chat \.chat-composer-row\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) auto !important;/);
});
