import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PROJECTION_BATCH_SIZE,
  ProjectionError,
  createProjectionRunner,
  createSqliteProjectionReader,
  projectMessageRows,
  validateProjectionTarget,
} from "../connector/messageProjection.js";

const TARGET = Object.freeze({
  bindingId: "binding-1",
  conversationId: "conversation-1",
  organizationProfileId: "bibi-07",
  executionProfileId: "bibi-07",
  hermesSessionId: "20260824_120000_abcd12",
  channel: "telegram",
  checkpoint: 0,
});

function row(overrides = {}) {
  return {
    id: 1,
    session_id: TARGET.hermesSessionId,
    role: "user",
    content: "오늘 일정 알려줘",
    timestamp: 1787530800,
    active: 1,
    compacted: 0,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    reasoning: null,
    reasoning_content: null,
    reasoning_details: null,
    api_content: null,
    display_kind: null,
    display_metadata: null,
    ...overrides,
  };
}

test("projection target enforces the 18-role mapping and Telegram provenance", () => {
  assert.equal(validateProjectionTarget(TARGET).executionProfileId, "bibi-07");
  assert.equal(validateProjectionTarget({ ...TARGET, organizationProfileId: "bibi-01", executionProfileId: "default" }).executionProfileId, "default");
  for (const target of [
    { ...TARGET, executionProfileId: "bibi-01" },
    { ...TARGET, organizationProfileId: "bibi-01", executionProfileId: "bibi-07" },
    { ...TARGET, organizationProfileId: "bibi-07", executionProfileId: "default" },
    { ...TARGET, channel: "web" },
    { ...TARGET, hermesSessionId: "x' OR 1=1 --" },
  ]) {
    assert.throws(() => validateProjectionTarget(target), (error) => error instanceof ProjectionError);
  }
});

test("plain user and assistant content is projected, including convergence tombstones", () => {
  const messages = projectMessageRows([
    row(),
    row({ id: 2, role: "assistant", content: "오후 3시 회의가 있어요" }),
    row({ id: 3, role: "tool", content: "tool payload" }),
    row({ id: 4, role: "system", content: "hidden runtime context" }),
    row({ id: 5, role: "assistant", content: "visible", tool_calls: "[{\"name\":\"terminal\"}]" }),
    row({ id: 6, active: 0 }),
    row({ id: 7, compacted: 1 }),
  ], TARGET);

  assert.deepEqual(messages.map((message) => [message.sourceMessageId, message.role]), [
    [1, "user"], [2, "assistant"], [6, "user"], [7, "user"],
  ]);
  assert.deepEqual(messages.map((message) => message.sourceSequence), [1, 2, 6, 7]);
  assert.deepEqual(messages.slice(2).map((message) => message.lifecycleState), ["deleted", "archived"]);
  assert.ok(messages.slice(2).every((message) => message.body === ""));
  assert.ok(messages.every((message) => !JSON.stringify(message).includes("tool payload")));
});

test("Hermes infrastructure envelopes become body-free convergence tombstones", () => {
  const projected = projectMessageRows([
    row({ id: 10, content: "[CONTEXT COMPACTION — REFERENCE ONLY] generated handoff" }),
    row({ id: 11, content: "[ASYNC DELEGATION BATCH COMPLETE — deleg_test]\ninternal result" }),
    row({ id: 12, content: "[Your active task list was preserved across context compression]\n- internal task" }),
    row({ id: 13, content: "hidden metadata row", display_kind: "hidden" }),
  ], TARGET);

  assert.deepEqual(projected.map((message) => message.sourceMessageId), [10, 11, 12, 13]);
  assert.ok(projected.every((message) => message.lifecycleState === "deleted"));
  assert.ok(projected.every((message) => message.body === ""));
});

test("merged compaction rows preserve only the genuine tail message", () => {
  const [projected] = projectMessageRows([row({
    id: 13,
    role: "assistant",
    content: "[CONTEXT COMPACTION — REFERENCE ONLY] generated handoff\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---\n실제 사용자에게 보낸 답변",
  })], TARGET);

  assert.equal(projected.lifecycleState, "active");
  assert.equal(projected.body, "실제 사용자에게 보낸 답변");
  assert.doesNotMatch(projected.body, /CONTEXT COMPACTION|generated handoff/);
});

test("merged compaction rows tombstone a synthetic tail envelope", () => {
  const [projected] = projectMessageRows([row({
    id: 14,
    role: "user",
    content: "[CONTEXT COMPACTION — REFERENCE ONLY] generated handoff\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---\n[ASYNC DELEGATION BATCH COMPLETE — deleg_nested]\ninternal result",
  })], TARGET);

  assert.equal(projected.lifecycleState, "deleted");
  assert.equal(projected.body, "");
});

test("projection redacts secrets and local paths without uploading hidden columns", () => {
  const [message] = projectMessageRows([row({
    content: "Authorization: Bearer eyJhbG....sig password=hunter2 파일 /Users/example/private/report.txt",
    reasoning: "private chain of thought",
    api_content: "provider payload",
    display_metadata: "{\"cwd\":\"/Users/example\"}",
  })], TARGET);
  assert.doesNotMatch(message.body, /eyJ|hunter2|\/Users\/example/);
  assert.match(message.body, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(message), /private chain|provider payload|display_metadata|api_content|reasoning/);
  assert.match(message.contentSha256, /^[0-9a-f]{64}$/);
});

test("ordering is deterministic and duplicate source ids collapse", () => {
  const messages = projectMessageRows([
    row({ id: 9, timestamp: 200 }),
    row({ id: 8, timestamp: 300 }),
    row({ id: 9, timestamp: 100, content: "duplicate older row" }),
  ], TARGET);
  assert.deepEqual(messages.map((message) => message.sourceMessageId), [8, 9]);
});

test("a web resume turn binds local rows to canonical web/work ids and preserves actual origin", () => {
  const target = {
    ...TARGET,
    canonicalLinks: [{
      workItemId: "work-1",
      requestMessageId: "web-1",
      bodySha256: createHash("sha256").update("같은 질문").digest("hex"),
    }],
  };
  const projected = projectMessageRows([
    row({ id: 20, role: "user", content: "같은 질문" }),
    row({ id: 21, role: "assistant", content: "답변" }),
  ], target);
  assert.deepEqual(projected.map((message) => message.canonicalMessageKey), ["web:web-1", "assistant:work-1"]);
  assert.deepEqual(projected.map((message) => message.originChannel), ["web", "web"]);
});

test("deleted, compacted and retention-expired rows become body-free convergence tombstones", () => {
  const target = { ...TARGET, retentionBefore: "2026-08-24T00:00:00.000Z" };
  const projected = projectMessageRows([
    row({ id: 30, active: 0, content: "must disappear" }),
    row({ id: 31, compacted: 1, content: "archived secret" }),
    row({ id: 32, timestamp: 100, content: "expired" }),
  ], target);
  assert.deepEqual(projected.map((message) => message.lifecycleState), ["deleted", "archived", "retention"]);
  assert.ok(projected.every((message) => message.body === ""));
});

test("checkpoint advances only after an acknowledged idempotent upload", async () => {
  const calls = { read: [], upload: [] };
  const runner = createProjectionRunner({
    transport: {
      async listProjectionTargets() { return { targets: [TARGET] }; },
      async uploadProjection(payload) { calls.upload.push(payload); return { accepted: 2, checkpoint: 2 }; },
    },
    reader: {
      async readMessages(target) {
        calls.read.push(target.checkpoint);
        return projectMessageRows([row(), row({ id: 2, role: "assistant" })], target);
      },
    },
  });
  const result = await runner.runOnce();
  assert.deepEqual(calls.read, [0]);
  assert.equal(calls.upload.length, 1);
  assert.equal(result.projected, 2);
  assert.equal(result.checkpoint, 2);
});

test("offline failure leaves cloud checkpoint authoritative for replay after restart", async () => {
  let online = false;
  const uploads = [];
  const transport = {
    async listProjectionTargets() { return { targets: [TARGET] }; },
    async uploadProjection(payload) {
      uploads.push(payload);
      if (!online) throw new Error("offline");
      return { accepted: 2, checkpoint: 2 };
    },
  };
  const reader = { async readMessages(target) { return projectMessageRows([row(), row({ id: 2 })], target); } };

  const first = await createProjectionRunner({ transport, reader }).runOnce();
  assert.equal(first.failed, 1);
  assert.equal(first.checkpoint, 0);

  online = true;
  const replay = await createProjectionRunner({ transport, reader }).runOnce();
  assert.equal(replay.projected, 2);
  assert.equal(replay.checkpoint, 2);
  assert.deepEqual(uploads[0].messages, uploads[1].messages, "restart replay must be byte-for-byte deterministic");
});

test("SQLite projection filters hidden rows before JSON output and reads a bounded new-first batch", async () => {
  let invocation;
  const reader = createSqliteProjectionReader({
    homeForProfile: () => "/safe/profile",
    execFileImpl: async (binary, args, options) => {
      invocation = { binary, args, options };
      return { stdout: "[]" };
    },
  });
  await reader.readMessages({ ...TARGET, checkpoint: 42 });

  const sql = invocation.args.at(-1);
  assert.equal(invocation.binary, "sqlite3");
  assert.deepEqual(invocation.args.slice(0, 3), ["-json", "/safe/profile/state.db", sql]);
  assert.doesNotMatch(invocation.args.join(" "), /-readonly/);
  assert.match(sql, /^pragma query_only = on;/i);
  assert.match(sql, /role in \('user', 'assistant'\)/);
  assert.match(sql, /tool_call_id is null and tool_calls is null and tool_name is null/);
  assert.match(sql, /typeof\(content\) = 'text' and length\(trim\(content\)\) > 0/);
  assert.match(sql, /order by case when id > 42 then 0 when id > 0 then 1 else 2 end, id asc/);
  assert.match(sql, new RegExp(`limit ${PROJECTION_BATCH_SIZE}`));
  assert.equal(PROJECTION_BATCH_SIZE, 100);
  assert.equal(invocation.options.maxBuffer, 2 * 1024 * 1024);
});

test("SQLite lifecycle scan revisits previously projected active infrastructure envelopes", async () => {
  let sql;
  const reader = createSqliteProjectionReader({
    homeForProfile: () => "/safe/profile",
    execFileImpl: async (_binary, args) => {
      sql = args.at(-1);
      return { stdout: JSON.stringify([row({
        id: 10,
        content: "[ASYNC DELEGATION BATCH COMPLETE — deleg_old]\ninternal result",
      })]) };
    },
  });

  const batch = await reader.readMessages({ ...TARGET, checkpoint: 100, lifecycleCheckpoint: 0 });
  assert.equal(batch.nextLifecycleCheckpoint, 10);
  assert.deepEqual(batch.messages.map((message) => [message.sourceMessageId, message.lifecycleState, message.body]), [
    [10, "deleted", ""],
  ]);
  assert.match(sql, /ASYNC DELEGATION BATCH COMPLETE/);
  assert.match(sql, /CONTEXT COMPACTION/);
  assert.match(sql, /active task list was preserved across context compression/);
});

test("projection failures expose a bounded operational code without message or payload content", async () => {
  const runner = createProjectionRunner({
    transport: {
      async listProjectionTargets() { return { targets: [TARGET] }; },
      async uploadProjection() { throw new Error("must not upload"); },
    },
    reader: {
      async readMessages() {
        throw new ProjectionError("secret-shaped local detail", "STATE_DB_READ_FAILED");
      },
    },
  });
  const result = await runner.runOnce();
  assert.deepEqual(result.errors, [{ bindingId: "inding-1", code: "STATE_DB_READ_FAILED" }]);
  assert.equal(JSON.stringify(result).includes("secret-shaped"), false);
});

test("a separate circular lifecycle cursor scans more than one batch without starving later tombstones", async () => {
  const ids = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const queryOrder = [ids(1, 100), ids(101, 200), [...ids(201, 250), ...ids(1, 50)]];
  let call = 0;
  const reader = createSqliteProjectionReader({
    homeForProfile: () => "/safe/profile",
    execFileImpl: async () => ({
      stdout: JSON.stringify(queryOrder[call++].map((id) => row({
        id,
        active: 0,
        content: `tombstone-${id}`,
      }))),
    }),
  });

  const first = await reader.readMessages({ ...TARGET, checkpoint: 1_000, lifecycleCheckpoint: 0 });
  const second = await reader.readMessages({ ...TARGET, checkpoint: 1_000, lifecycleCheckpoint: first.nextLifecycleCheckpoint });
  const wrapped = await reader.readMessages({ ...TARGET, checkpoint: 1_000, lifecycleCheckpoint: second.nextLifecycleCheckpoint });

  assert.deepEqual([
    first.nextLifecycleCheckpoint,
    second.nextLifecycleCheckpoint,
    wrapped.nextLifecycleCheckpoint,
  ], [100, 200, 50]);
  assert.equal(new Set([...first.messages, ...second.messages].map((message) => message.sourceMessageId)).size, 200);
  assert.ok(wrapped.messages.some((message) => message.sourceMessageId === 250));
  assert.ok(wrapped.messages.some((message) => message.sourceMessageId === 1), "the scan must wrap after reaching the end");
});
