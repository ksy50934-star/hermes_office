import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleProjectionTargets, handleProjectionUpload } from "../api/_lib/handlers.js";

const AUTH = Object.freeze({ ownerId: "owner-a", connectorNodeId: "node-a" });
const TARGET = Object.freeze({
  bindingId: "binding-a",
  conversationId: "conversation-a",
  organizationProfileId: "bibi-07",
  executionProfileId: "bibi-07",
  hermesSessionId: "session-a",
  channel: "telegram",
  checkpoint: 0,
});
const MESSAGE = Object.freeze({
  bindingId: "binding-a",
  conversationId: "conversation-a",
  organizationProfileId: "bibi-07",
  executionProfileId: "bibi-07",
  hermesSessionId: "session-a",
  channel: "telegram",
  sourceMessageId: 1,
  sourceSequence: 1,
  sourceTimestamp: "2026-08-24T03:00:00.000Z",
  role: "user",
  lifecycleState: "active",
  body: "안녕",
  contentSha256: "a".repeat(64),
});
const STORE_SOURCE = readFileSync(new URL("../api/_lib/store.js", import.meta.url), "utf8");
const CURSOR_MIGRATION = readFileSync(new URL(
  "../supabase/migrations/20260827000400_projection_lifecycle_cursor.sql",
  import.meta.url,
), "utf8");

test("projection targets are owner scoped and restricted to verified Telegram bindings", async () => {
  const calls = [];
  const result = await handleProjectionTargets({
    auth: AUTH,
    store: { async listProjectionTargets(args) { calls.push(args); return [TARGET]; } },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ ownerId: "owner-a", connectorNodeId: "node-a" }]);
  assert.deepEqual(result.body.targets, [TARGET]);
});

test("projection upload rejects any identity mismatch before the store", async () => {
  let writes = 0;
  const store = { async applyProjection() { writes += 1; return { accepted: 1, checkpoint: 1 }; } };
  for (const body of [
    { target: { ...TARGET, organizationProfileId: "bibi-08" }, messages: [MESSAGE] },
    { target: TARGET, messages: [{ ...MESSAGE, executionProfileId: "bibi-08" }] },
    { target: TARGET, messages: [{ ...MESSAGE, conversationId: "conversation-b" }] },
    { target: TARGET, messages: [{ ...MESSAGE, hermesSessionId: "session-b" }] },
    { target: TARGET, messages: [{ ...MESSAGE, role: "tool" }] },
    { target: { ...TARGET, nextLifecycleCheckpoint: -1 }, messages: [MESSAGE] },
  ]) {
    const result = await handleProjectionUpload({ auth: AUTH, body, store });
    assert.equal(result.status, 400);
  }
  assert.equal(writes, 0);
});

test("idempotent projection upload returns the cloud checkpoint", async () => {
  const calls = [];
  const result = await handleProjectionUpload({
    auth: AUTH,
    body: { target: TARGET, messages: [MESSAGE] },
    store: {
      async applyProjection(args) {
        calls.push(args);
        return { accepted: 1, duplicates: 0, checkpoint: 1 };
      },
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.checkpoint, 1);
  assert.equal(calls[0].ownerId, "owner-a");
  assert.equal(calls[0].target.bindingId, "binding-a");
});

test("body-free non-active tombstones pass the same handler boundary while active empties fail closed", async () => {
  const calls = [];
  const tombstone = {
    ...MESSAGE,
    lifecycleState: "deleted",
    body: "",
    contentSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  const accepted = await handleProjectionUpload({
    auth: AUTH,
    body: { target: { ...TARGET, nextLifecycleCheckpoint: 1 }, messages: [tombstone] },
    store: {
      async applyProjection(args) {
        calls.push(args);
        return { accepted: 1, duplicates: 0, checkpoint: 1, lifecycleCheckpoint: 1 };
      },
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages[0].body, "");
  assert.equal(calls[0].target.nextLifecycleCheckpoint, 1);

  for (const invalid of [
    { ...MESSAGE, body: "" },
    { ...tombstone, body: "secret must not survive" },
    { ...tombstone, contentSha256: "a".repeat(64) },
    { ...tombstone, lifecycleState: "unknown" },
  ]) {
    const rejected = await handleProjectionUpload({
      auth: AUTH,
      body: { target: TARGET, messages: [invalid] },
      store: { async applyProjection() { throw new Error("must not write"); } },
    });
    assert.equal(rejected.status, 400);
  }
});

test("the forward lifecycle cursor migration and store use the proof-gated atomic v2 RPC", () => {
  assert.match(CURSOR_MIGRATION, /add column if not exists last_lifecycle_scan_message_id bigint not null default 0/i);
  assert.match(CURSOR_MIGRATION, /create or replace function public\.bibi_apply_message_projection_v2\(/i);
  assert.match(CURSOR_MIGRATION, /and verified_at is not null\s+and verified_by_node_id is not null/i);
  assert.match(CURSOR_MIGRATION, /last_lifecycle_scan_message_id = excluded\.last_lifecycle_scan_message_id/i);
  assert.doesNotMatch(CURSOR_MIGRATION, /greatest\([^\n]*last_lifecycle_scan_message_id/i);
  assert.match(CURSOR_MIGRATION, /revoke all on function public\.bibi_apply_message_projection_v2[^;]+from authenticated/i);
  assert.match(CURSOR_MIGRATION, /grant execute on function public\.bibi_apply_message_projection_v2[^;]+to service_role/i);
  assert.match(STORE_SOURCE, /\.rpc\("bibi_apply_message_projection_v2"/);
  assert.match(STORE_SOURCE, /p_lifecycle_scan_cursor: target\.nextLifecycleCheckpoint/);
  assert.match(STORE_SOURCE, /last_lifecycle_scan_message_id/);
});
