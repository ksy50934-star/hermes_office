import assert from "node:assert/strict";
import test from "node:test";

import { LocalExecutionError, createHermesCliExecutor } from "../connector/hermesCliExecutor.js";

const config = Object.freeze({
  hermesBin: "/bin/hermes-fixture",
  hermesDefaultHome: "/tmp/hermes-default",
  hermesProfilesRoot: "/tmp/hermes-default/profiles",
  hermesTimeoutMs: 10_000,
  hermesMaxOutputBytes: 1024 * 1024,
  hermesMaxTurns: 4,
  dryRun: false,
});

function boundCommand(overrides = {}) {
  return {
    id: "command-1",
    workItemId: "work-1",
    kind: "chat",
    profileId: "bibi-07",
    executionProfileId: "bibi-07",
    title: "후속 질문",
    brief: "그 일정 장소도 알려줘",
    bindingId: "binding-1",
    hermesSessionId: "20260824_120000_abcd12",
    channelOrigin: "telegram",
    continuationStatus: "bound",
    resumeLeaseId: "resume-lease-1",
    attempt: 1,
    turnIdempotencyKey: "work-1:1",
    ...overrides,
  };
}

function memoryTurnLedger(initial = new Map()) {
  return {
    async begin(key) {
      const existing = initial.get(key);
      if (existing) return { existing: true, ...existing };
      initial.set(key, { state: "executing" });
      return { existing: false, state: "executing" };
    },
    async complete(key, result) {
      initial.set(key, { state: "completed", result });
    },
    async fail(key, error) {
      initial.set(key, { state: "failed", error });
    },
  };
}

function executor({ verification = { ok: true }, calls = [], executionLedger = memoryTurnLedger() } = {}) {
  return createHermesCliExecutor(config, {
    executionLedger,
    sessionVerifier: { async verify(input) { calls.push({ verify: input }); return verification; } },
    execFileImpl(_bin, args, options, callback) {
      calls.push({ args, options });
      callback(null, "이어진 답변", "");
    },
  });
}

test("a bound web turn verifies the local Telegram session then uses exact --resume argv", async () => {
  const calls = [];
  const result = await executor({ calls }).execute(boundCommand());
  assert.equal(result.summary, "이어진 답변");
  assert.equal(calls[0].verify.hermesSessionId, "20260824_120000_abcd12");
  assert.equal(calls[0].verify.executionProfileId, "bibi-07");
  assert.deepEqual(calls[1].args, [
    "chat", "--resume", "20260824_120000_abcd12", "--no-restore-cwd",
    "-q", "그 일정 장소도 알려줘", "-Q", "--max-turns", "4",
  ]);
  assert.ok(!calls[1].args.includes("--source"));
});

test("resume session id is data in argv and injection-shaped ids are blocked", async () => {
  const calls = [];
  await assert.rejects(
    () => executor({ calls }).execute(boundCommand({ hermesSessionId: "abc; touch /tmp/pwned" })),
    (error) => error instanceof LocalExecutionError && error.code === "INVALID_RESUME_SESSION_ID",
  );
  assert.equal(calls.length, 0);
});

test("missing, wrong-source, archived and profile-mismatched sessions return explicit BLOCKED errors", async () => {
  for (const verification of [
    { ok: false, code: "SESSION_NOT_FOUND" },
    { ok: false, code: "SESSION_SOURCE_MISMATCH" },
    { ok: false, code: "SESSION_ARCHIVED" },
    { ok: false, code: "SESSION_PROFILE_MISMATCH" },
  ]) {
    const calls = [];
    await assert.rejects(
      () => executor({ calls, verification }).execute(boundCommand()),
      (error) => error.code === `BLOCKED_${verification.code}` && /^BLOCKED:/.test(error.message),
    );
    assert.equal(calls.filter((call) => call.args).length, 0, "Hermes must not run when binding cannot be verified");
  }
});

test("a bound turn without the cloud resume lease fails closed", async () => {
  const calls = [];
  await assert.rejects(
    () => executor({ calls }).execute(boundCommand({ resumeLeaseId: null })),
    (error) => error.code === "BLOCKED_RESUME_LEASE_MISSING",
  );
  assert.equal(calls.length, 0);
});

test("a bound turn without the durable turn idempotency key fails closed", async () => {
  const calls = [];
  await assert.rejects(
    () => executor({ calls }).execute(boundCommand({ turnIdempotencyKey: null })),
    (error) => error.code === "BLOCKED_TURN_IDEMPOTENCY_KEY_MISSING",
  );
  assert.equal(calls.length, 0);
});

test("restart after execution started but outcome is unknown never resumes the prompt again", async () => {
  const calls = [];
  const executionLedger = memoryTurnLedger(new Map([["work-1:1", { state: "executing" }]]));
  await assert.rejects(
    () => executor({ calls, executionLedger }).execute(boundCommand()),
    (error) => error.code === "BLOCKED_TURN_OUTCOME_UNKNOWN",
  );
  assert.equal(calls.filter((call) => call.args).length, 0);
});

test("a lost succeed report is reconciled from the durable completion marker without a second resume", async () => {
  const calls = [];
  const cached = { summary: "이미 실행된 답변", detail: "", evidence: [] };
  const executionLedger = memoryTurnLedger(new Map([["work-1:1", { state: "completed", result: cached }]]));
  const result = await executor({ calls, executionLedger }).execute(boundCommand());
  assert.deepEqual(result, cached);
  assert.equal(calls.filter((call) => call.args).length, 0);
});

test("an unbound ordinary work command keeps the existing new-session contract", async () => {
  const calls = [];
  await executor({ calls }).execute({
    ...boundCommand(),
    kind: "work",
    bindingId: null,
    hermesSessionId: null,
    channelOrigin: null,
    continuationStatus: "unbound",
    resumeLeaseId: null,
  });
  assert.deepEqual(calls[0].args, [
    "chat", "-q", "후속 질문\n\n그 일정 장소도 알려줘", "-Q", "--source", "tool", "--max-turns", "4",
  ]);
});
