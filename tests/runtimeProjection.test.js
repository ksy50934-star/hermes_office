import test from "node:test";
import assert from "node:assert/strict";

import { handleRuntimeProjection } from "../api/_lib/handlers.js";
import {
  createRuntimeProjectionRunner,
  organizationProfileId,
  parseMcpCatalog,
  parseMcpServers,
  parseRuntimeStatus,
  parseToolsets,
} from "../connector/runtimeProjection.js";

const TOOL_OUTPUT = `Built-in toolsets (cli):
  ✓ enabled  web  🔍 Web Search & Scraping
  ✗ disabled  stt  🎙️ Speech-to-Text
  ✓ enabled  computer_use  🖱️ Computer Use`;
const CATALOG_OUTPUT = `MCP Catalog + configured servers:

  Name               Status                   Description
  ------------------ ------------------------ -----------
  figma              available                Official Figma remote MCP
  n8n                installed                Manage n8n workflows`;
const STATUS_OUTPUT = `Hermes Agent v0.20.0 (2026.8.3)
  Model:        gpt-5.6-sol
  Provider:     OpenAI Codex
◆ Gateway Service
  Status:       ✓ running
◆ Sessions
  Active:       3 session(s)`;

test("runtime projection parsers keep only public tool and health facts", () => {
  assert.deepEqual(parseToolsets(TOOL_OUTPUT).map((item) => [item.name, item.enabled]), [
    ["web", true], ["stt", false], ["computer_use", true],
  ]);
  assert.deepEqual(parseMcpCatalog(CATALOG_OUTPUT).map((item) => [item.name, item.installed]), [
    ["figma", false], ["n8n", true],
  ]);
  assert.deepEqual(parseMcpServers("No MCP servers configured."), []);
  assert.deepEqual(parseRuntimeStatus(STATUS_OUTPUT), {
    hermesVersion: "0.20.0",
    model: "gpt-5.6-sol",
    provider: "OpenAI Codex",
    gatewayStatus: "running",
    activeSessions: 3,
  });
  assert.equal(organizationProfileId("default"), "bibi-01");
  assert.equal(organizationProfileId("bibi-18"), "bibi-18");
});

test("runtime projection runner uploads once per interval and retries on the next interval", async () => {
  let clock = 1_000_000;
  const uploaded = [];
  const runner = createRuntimeProjectionRunner({
    intervalMs: 300_000,
    now: () => clock,
    listProfileIds: async () => ["default", "bibi-02"],
    collector: { collect: async (id) => ({ profileId: organizationProfileId(id), executionProfileId: id }) },
    transport: { uploadRuntimeProjection: async (payload) => uploaded.push(payload) },
  });
  assert.deepEqual(await runner.runOnce(), { skipped: false, projected: 2, failed: 0 });
  assert.deepEqual(await runner.runOnce(), { skipped: true, projected: 0, failed: 0 });
  clock += 300_000;
  assert.deepEqual(await runner.runOnce(), { skipped: false, projected: 2, failed: 0 });
  assert.equal(uploaded.length, 4);
});

test("runtime projection API rejects cross-profile identity and persists only bounded fields", async () => {
  const calls = [];
  const store = { upsertRuntimeProjection: async (payload) => calls.push(payload) };
  const body = {
    profileId: "bibi-02",
    executionProfileId: "bibi-02",
    collectedAt: "2026-08-24T12:00:00.000Z",
    inventory: {
      catalog: [{ name: "figma", label: "Figma", description: "safe", secret: "never" }],
      servers: [],
      toolsets: [{ name: "web", enabled: true }],
      errors: [],
    },
    health: { hermesVersion: "0.20.0", model: "gpt-5.6-sol", provider: "OpenAI Codex", gatewayStatus: "running", activeSessions: 1, enabledToolsets: 1, disabledToolsets: 0 },
  };
  const result = await handleRuntimeProjection({ auth: { ownerId: "owner-1", connectorNodeId: "node-1" }, body, store });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal("secret" in calls[0].inventory.catalog[0], false);

  const refused = await handleRuntimeProjection({
    auth: { ownerId: "owner-1", connectorNodeId: "node-1" },
    body: { ...body, executionProfileId: "bibi-03" }, store,
  });
  assert.equal(refused.status, 400);
  assert.equal(calls.length, 1);
});
