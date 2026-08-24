import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCloudTeamAdapter } from "../src/bibi/teamAdapter.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("cloud team adapter maps runtime projection and archive without inventing unavailable data", async () => {
  const adapter = createCloudTeamAdapter({
    runtime: {
      inventory: [{ profile_id: "bibi-02", catalog: [{ name: "plugin-a" }], servers: [{ name: "mcp-a" }], toolsets: [{ name: "web", enabled: true, available: true }] }],
      health: [],
    },
    archive: [{ id: "conversation-1", profile_id: "bibi-02", title: "최근 업무", created_at: "2026-08-24T00:00:00Z", messages: [{ body: "완료" }] }],
  });
  const result = await adapter.load("bibi-02");
  assert.equal(adapter.backend, "bibi-cloud");
  assert.equal(adapter.readOnly, true);
  assert.deepEqual(result.capabilities.skills, []);
  assert.equal(result.capabilities.plugins[0].name, "plugin-a");
  assert.equal(result.capabilities.mcp[0].name, "mcp-a");
  assert.equal(result.capabilities.toolsets[0].name, "web");
  assert.equal(result.sessions[0].message_count, 1);
});

test("cloud read-only plugin inventory does not expose mutation controls", async () => {
  const [app, plugin] = await Promise.all([read("src/App.jsx"), read("src/PluginHub.jsx")]);
  assert.match(app, /bibiCloudView \? "프로필별 도구 투영 상태"/);
  assert.match(plugin, /!adapter\?\.readOnly && <footer>/);
  assert.match(plugin, /Object\.keys\(env\)\.length > 0 && !adapter\?\.readOnly/);
  assert.match(plugin, /!adapter\?\.readOnly && <button type="button" onClick=\{\(\) => installCatalogItem/);
});

test("TeamWorkspace uses its cloud adapter instead of legacy profile loaders", async () => {
  const [app, team] = await Promise.all([read("src/App.jsx"), read("src/TeamWorkspace.jsx")]);
  assert.match(app, /adapter=\{bibiCloudView \? bibiTeamAdapter : null\}/);
  assert.match(team, /const load = adapter\s*\? adapter\.load\(activeName\)/);
  assert.match(team, /if \(!adapter\) saveTeamCache/);
});
