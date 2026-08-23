import assert from "node:assert/strict";
import test from "node:test";
import {
  commandDedupeKey,
  createIdempotencyLedger,
  suppressDuplicateCommands,
  workIntakeKey,
} from "../src/bibi/idempotency.js";

test("intake keys are scoped per owner so two users can reuse a client request id", () => {
  assert.equal(workIntakeKey({ ownerId: "a", clientRequestId: "r1" }), workIntakeKey({ ownerId: "a", clientRequestId: "r1" }));
  assert.notEqual(workIntakeKey({ ownerId: "a", clientRequestId: "r1" }), workIntakeKey({ ownerId: "b", clientRequestId: "r1" }));
  // A separator collision must not make two different pairs look identical.
  assert.notEqual(workIntakeKey({ ownerId: "a:b", clientRequestId: "c" }), workIntakeKey({ ownerId: "a", clientRequestId: "b:c" }));
});

test("intake keys require both parts", () => {
  assert.throws(() => workIntakeKey({ ownerId: "", clientRequestId: "r" }));
  assert.throws(() => workIntakeKey({ ownerId: "o", clientRequestId: "" }));
});

test("the ledger runs a factory once and replays the first result for a repeat", () => {
  const ledger = createIdempotencyLedger();
  let calls = 0;
  const factory = () => { calls += 1; return { id: `work-${calls}` }; };

  const first = ledger.resolve("k", factory);
  const second = ledger.resolve("k", factory);

  assert.equal(calls, 1);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.value, first.value);
  assert.equal(ledger.size, 1);
});

test("a factory that throws leaves no entry behind, so a genuine retry can succeed", () => {
  const ledger = createIdempotencyLedger();
  assert.throws(() => ledger.resolve("k", () => { throw new Error("db down"); }), /db down/);
  assert.equal(ledger.has("k"), false);
  assert.equal(ledger.resolve("k", () => "ok").duplicate, false);
});

test("the ledger evicts oldest entries first and stays bounded", () => {
  const ledger = createIdempotencyLedger({ maxEntries: 3 });
  for (const key of ["a", "b", "c", "d"]) ledger.resolve(key, () => key);
  assert.equal(ledger.size, 3);
  assert.equal(ledger.has("a"), false);
  assert.equal(ledger.has("d"), true);
});

test("re-resolving a live key refreshes its recency so a hot key is not evicted", () => {
  const ledger = createIdempotencyLedger({ maxEntries: 2 });
  ledger.resolve("a", () => "a");
  ledger.resolve("b", () => "b");
  ledger.resolve("a", () => "a-again");
  ledger.resolve("c", () => "c");
  assert.equal(ledger.has("a"), true);
  assert.equal(ledger.has("b"), false);
});

test("a command dedupe key separates redeliveries from genuine retries", () => {
  const base = { workItemId: "w1", type: "execute", attempt: 1 };
  assert.equal(commandDedupeKey(base), commandDedupeKey({ ...base }));
  assert.notEqual(commandDedupeKey(base), commandDedupeKey({ ...base, attempt: 2 }));
  assert.notEqual(commandDedupeKey(base), commandDedupeKey({ ...base, type: "cancel" }));
  assert.notEqual(commandDedupeKey(base), commandDedupeKey({ ...base, workItemId: "w2" }));
});

test("an explicit command id wins over the derived key", () => {
  assert.equal(commandDedupeKey({ id: "cmd-1", workItemId: "w1", type: "execute", attempt: 1 }), "cmd-1");
});

test("at-least-once delivery is collapsed to exactly-once execution", () => {
  const ledger = createIdempotencyLedger();
  const commands = [
    { id: "cmd-1", workItemId: "w1", type: "execute", attempt: 1 },
    { id: "cmd-2", workItemId: "w2", type: "execute", attempt: 1 },
    { id: "cmd-1", workItemId: "w1", type: "execute", attempt: 1 },
  ];

  const first = suppressDuplicateCommands(commands, ledger);
  assert.deepEqual(first.accepted.map((command) => command.id), ["cmd-1", "cmd-2"]);
  assert.deepEqual(first.suppressed.map((command) => command.id), ["cmd-1"]);

  // A later poll that redelivers the same batch must yield nothing new.
  const second = suppressDuplicateCommands(commands, ledger);
  assert.deepEqual(second.accepted, []);
  assert.equal(second.suppressed.length, 3);
});

test("a retry of the same work item with a new attempt is not suppressed", () => {
  const ledger = createIdempotencyLedger();
  suppressDuplicateCommands([{ workItemId: "w1", type: "execute", attempt: 1 }], ledger);
  const retry = suppressDuplicateCommands([{ workItemId: "w1", type: "execute", attempt: 2 }], ledger);
  assert.equal(retry.accepted.length, 1);
});

test("malformed commands are suppressed with a reason rather than executed blindly", () => {
  const result = suppressDuplicateCommands([null, {}, { workItemId: "w1" }], createIdempotencyLedger());
  assert.deepEqual(result.accepted, []);
  assert.equal(result.suppressed.length, 3);
  assert.ok(result.reasons.every((reason) => reason.reason === "MALFORMED_COMMAND"));
});
