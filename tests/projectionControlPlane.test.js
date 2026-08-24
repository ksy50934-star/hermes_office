import assert from "node:assert/strict";
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
  body: "안녕",
  contentSha256: "a".repeat(64),
});

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
