import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ConnectorConfigError, loadConnectorConfig } from "../connector/config.js";
import {
  EvidenceError,
  assertNoLocalStateSource,
  buildEvidence,
  redactSecrets,
  sha256Hex,
} from "../connector/evidence.js";
import { createLeaseRunner } from "../connector/leaseRunner.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const connectorDir = path.join(projectRoot, "connector");

const BASE_ENV = Object.freeze({
  BIBI_CONNECTOR_MODE: "outbound-local-mac",
  BIBI_CONTROL_PLANE_URL: "https://workspace.example.com",
  BIBI_CONNECTOR_TOKEN: "bibi_connector_secret_value_do_not_log",
  BIBI_CONNECTOR_NODE_LABEL: "sam-macbook",
});

// ---------------------------------------------------------------------------
// Outbound-only topology
// ---------------------------------------------------------------------------

test("no connector source opens a listening socket", async () => {
  const files = (await readdir(connectorDir)).filter((name) => name.endsWith(".js"));
  assert.ok(files.length >= 4, `expected connector modules, found: ${files.join(", ")}`);

  for (const name of files) {
    const source = await readFile(path.join(connectorDir, name), "utf8");
    for (const pattern of [
      /createServer\s*\(/,
      /\.listen\s*\(/,
      /new\s+(?:net\.)?Server\s*\(/,
      /WebSocketServer/,
      /node:net|node:http\b|node:https\b/,
    ]) {
      assert.doesNotMatch(source, pattern, `connector/${name} must not expose an inbound surface (${pattern})`);
    }
  }
});

test("a configured inbound port is refused outright", () => {
  assert.throws(
    () => loadConnectorConfig({ ...BASE_ENV, BIBI_CONNECTOR_INBOUND_PORT: "8080" }),
    (error) => error instanceof ConnectorConfigError && error.code === "INBOUND_PORT_CONFIGURED",
  );
});

test("the control plane URL must be https unless it is loopback", () => {
  assert.throws(
    () => loadConnectorConfig({ ...BASE_ENV, BIBI_CONTROL_PLANE_URL: "http://workspace.example.com" }),
    (error) => error.code === "INSECURE_CONTROL_PLANE",
  );
  assert.equal(
    loadConnectorConfig({ ...BASE_ENV, BIBI_CONTROL_PLANE_URL: "http://127.0.0.1:3000" }).controlPlaneUrl,
    "http://127.0.0.1:3000",
  );
});

test("Hermes is reached as a local subprocess, not over any network address", () => {
  // The HTTP execution path is gone: there is no local URL to point at a
  // remote host, which is what previously made a VPS regression expressible.
  const config = loadConnectorConfig(BASE_ENV);
  assert.equal(config.hermesLocalUrl, undefined);
  assert.equal(config.executionEndpoint, undefined);
  assert.equal(typeof config.hermesBin, "string");
  assert.equal(typeof config.hermesMaxTurns, "number");
});

test("a missing token or an unsupported mode fails closed", () => {
  assert.throws(() => loadConnectorConfig({ ...BASE_ENV, BIBI_CONNECTOR_TOKEN: "" }), (error) => error.code === "MISSING_TOKEN");
  assert.throws(() => loadConnectorConfig({ ...BASE_ENV, BIBI_CONNECTOR_MODE: "vps" }), (error) => error.code === "UNSUPPORTED_MODE");
  assert.throws(() => loadConnectorConfig({ ...BASE_ENV, BIBI_CONTROL_PLANE_URL: "" }), (error) => error.code === "MISSING_CONTROL_PLANE");
});

test("local execution is opt-in, so an unconfigured connector never drives a real profile", () => {
  assert.equal(loadConnectorConfig(BASE_ENV).dryRun, true);
  // Opting in without naming the binary and the profile homes fails at startup
  // rather than at the first command.
  assert.throws(
    () => loadConnectorConfig({ ...BASE_ENV, BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION: "true" }),
    (error) => error.code === "MISSING_HERMES_BIN",
  );
  assert.equal(
    loadConnectorConfig({
      ...BASE_ENV,
      BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION: "true",
      BIBI_HERMES_BIN: "/usr/local/bin/hermes",
      BIBI_HERMES_DEFAULT_HOME: "/Users/someone/.hermes",
      BIBI_HERMES_PROFILES_ROOT: "/Users/someone/.hermes/profiles",
    }).dryRun,
    false,
  );
});

test("the token never appears in a serialised or logged config", () => {
  const config = loadConnectorConfig(BASE_ENV);
  assert.equal(config.token, BASE_ENV.BIBI_CONNECTOR_TOKEN);
  const serialised = JSON.stringify(config);
  assert.ok(!serialised.includes(BASE_ENV.BIBI_CONNECTOR_TOKEN), "JSON.stringify must not leak the token");
  assert.ok(!`${config}`.includes(BASE_ENV.BIBI_CONNECTOR_TOKEN));
  assert.match(serialised, /"tokenPrefix"/);
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test("evidence carries a verifiable content hash and size", () => {
  const evidence = buildEvidence({ kind: "log", label: "실행 로그", content: "hello" });
  assert.equal(evidence.sha256, sha256Hex("hello"));
  assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.byteSize, 5);
  assert.equal(evidence.inlineExcerpt, "hello");
});

test("evidence excerpts are truncated so a large artifact cannot be smuggled inline", () => {
  const evidence = buildEvidence({ kind: "log", label: "big", content: "x".repeat(10_000) });
  assert.ok(evidence.inlineExcerpt.length < 5_000);
  assert.equal(evidence.byteSize, 10_000);
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.sha256, sha256Hex("x".repeat(10_000)), "the hash covers the whole artifact, not the excerpt");
});

test("secrets are redacted out of anything the connector uploads", () => {
  const raw = [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "SUPABASE_SERVICE_ROLE_KEY=test-secret-value",
    "Cookie: sb-access-token=abcdef123456; other=1",
    "normal log line",
  ].join("\n");
  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes("eyJhbGciOiJIUzI1NiJ9.payload.signature"));
  assert.ok(!redacted.includes("test-secret-value"));
  assert.ok(!redacted.includes("abcdef123456"));
  assert.ok(redacted.includes("normal log line"));
  assert.match(redacted, /\[redacted\]/);
});

test("evidence content is redacted before it becomes an excerpt", () => {
  const evidence = buildEvidence({ kind: "log", label: "l", content: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.a.b" });
  assert.ok(!evidence.inlineExcerpt.includes("eyJhbGciOiJIUzI1NiJ9.a.b"));
});

test("raw local profile state, credentials and cookies can never become evidence", () => {
  for (const source of [
    "/Users/someone/.hermes/profiles/bibi-01/state.db",
    "/Users/someone/.hermes/profiles/bibi-01/state.sqlite",
    "/Users/someone/Library/Cookies/Cookies.binarycookies",
    "/Users/someone/.config/hermes/credentials.json",
    "/Users/someone/.ssh/id_ed25519",
    "/Users/someone/.hermes/profiles/bibi-02/cookies.sqlite",
  ]) {
    assert.throws(
      () => assertNoLocalStateSource(source),
      (error) => error instanceof EvidenceError && error.code === "LOCAL_STATE_SOURCE",
      `${source} must be refused`,
    );
  }
  assert.doesNotThrow(() => assertNoLocalStateSource("/Users/someone/bibi-work/outputs/report.md"));
});

test("evidence rejects an unknown kind rather than storing it unclassified", () => {
  assert.throws(() => buildEvidence({ kind: "raw-state", label: "l", content: "x" }), (error) => error.code === "INVALID_KIND");
});

// ---------------------------------------------------------------------------
// Lease runner
// ---------------------------------------------------------------------------

function command(overrides = {}) {
  return {
    id: "cmd-1",
    workItemId: "work-1",
    type: "execute",
    attempt: 1,
    profileId: "bibi-01",
    title: "보고서 초안",
    brief: "정리해줘",
    leaseId: "lease-1",
    leaseExpiresAt: "2026-08-24T00:05:00.000Z",
    ...overrides,
  };
}

function createFakeTransport({ batches = [[]], failPoll = false } = {}) {
  const calls = { heartbeat: [], poll: 0, report: [], renew: [] };
  return {
    calls,
    async heartbeat(payload) {
      calls.heartbeat.push(payload);
      return { ok: true };
    },
    async poll() {
      calls.poll += 1;
      if (failPoll) throw new Error("network unreachable");
      return { commands: batches[Math.min(calls.poll - 1, batches.length - 1)] ?? [] };
    },
    async report(event) {
      calls.report.push(event);
      return { ok: true, duplicate: false };
    },
    async renewLease(payload) {
      calls.renew.push(payload);
      return { leaseExpiresAt: "2026-08-24T00:10:00.000Z" };
    },
  };
}

function createFakeExecutor({ profileIds = ["default"], result, error } = {}) {
  const calls = [];
  return {
    calls,
    async listProfileIds() {
      return profileIds;
    },
    async execute(received) {
      calls.push(received);
      if (error) throw error;
      return result ?? { summary: "완료", detail: "", evidence: [buildEvidence({ kind: "log", label: "실행 로그", content: "ok" })] };
    },
  };
}

function runnerFor(transport, executor, overrides = {}) {
  return createLeaseRunner({
    config: loadConnectorConfig(BASE_ENV),
    transport,
    executor,
    now: () => Date.parse("2026-08-24T00:00:00.000Z"),
    ...overrides,
  });
}

test("a successful cycle heartbeats, starts, executes and reports a result with evidence", async () => {
  const transport = createFakeTransport({ batches: [[command()]] });
  const executor = createFakeExecutor();
  const summary = await runnerFor(transport, executor).runOnce();

  assert.equal(summary.online, true);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 0);

  assert.deepEqual(transport.calls.heartbeat[0].reportedProfileIds, ["default"]);
  assert.deepEqual(transport.calls.report.map((event) => event.type), ["start", "succeed"]);

  const succeed = transport.calls.report[1];
  assert.equal(succeed.workItemId, "work-1");
  assert.equal(succeed.summary, "완료");
  assert.equal(succeed.evidence.length, 1);
  assert.match(succeed.evidence[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(executor.calls.length, 1);
});

test("every reported event carries a stable id derived from the command, so a resend is idempotent", async () => {
  const transport = createFakeTransport({ batches: [[command()]] });
  await runnerFor(transport, createFakeExecutor()).runOnce();

  const ids = transport.calls.report.map((event) => event.id);
  assert.deepEqual(ids, ["cmd-1:start", "cmd-1:succeed"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("a command redelivered on a later poll is suppressed and never executed twice", async () => {
  const transport = createFakeTransport({ batches: [[command()], [command()]] });
  const executor = createFakeExecutor();
  const runner = runnerFor(transport, executor);

  const first = await runner.runOnce();
  const second = await runner.runOnce();

  assert.equal(first.accepted, 1);
  assert.equal(second.accepted, 0);
  assert.equal(second.suppressed, 1);
  assert.equal(executor.calls.length, 1, "the local profile must run the work exactly once");
});

test("a genuine retry with a new attempt is executed again", async () => {
  const transport = createFakeTransport({
    batches: [[command()], [command({ id: "cmd-2", attempt: 2, leaseId: "lease-2" })]],
  });
  const executor = createFakeExecutor();
  const runner = runnerFor(transport, executor);
  await runner.runOnce();
  const second = await runner.runOnce();

  assert.equal(second.accepted, 1);
  assert.equal(executor.calls.length, 2);
});

test("an execution failure is reported as a failure, not swallowed", async () => {
  const transport = createFakeTransport({ batches: [[command()]] });
  const executor = createFakeExecutor({ error: new Error("로컬 프로필 응답 없음") });
  const summary = await runnerFor(transport, executor).runOnce();

  assert.equal(summary.failed, 1);
  assert.equal(summary.succeeded, 0);
  const fail = transport.calls.report.at(-1);
  assert.equal(fail.type, "fail");
  assert.equal(fail.id, "cmd-1:fail");
  assert.equal(fail.error, "로컬 프로필 응답 없음");
});

test("work for a profile the Mac is not reporting is released back to the queue, not failed", async () => {
  const transport = createFakeTransport({ batches: [[command({ profileId: "bibi-07" })]] });
  const executor = createFakeExecutor({ profileIds: ["default"] });
  const summary = await runnerFor(transport, executor).runOnce();

  assert.equal(executor.calls.length, 0, "an absent profile must not be substituted by another one");
  assert.equal(summary.released, 1);
  assert.equal(summary.failed, 0);
  const release = transport.calls.report.at(-1);
  assert.equal(release.type, "release");
  assert.match(release.reason, /프로필/);
});

test("a command for an identifier outside the roster is refused", async () => {
  const transport = createFakeTransport({ batches: [[command({ profileId: "default" })]] });
  const executor = createFakeExecutor();
  const summary = await runnerFor(transport, executor).runOnce();

  assert.equal(executor.calls.length, 0);
  assert.equal(summary.failed, 1);
  assert.match(transport.calls.report.at(-1).error, /bibi/);
});

test("an unreachable control plane leaves the connector offline instead of throwing", async () => {
  const transport = createFakeTransport({ failPoll: true });
  const summary = await runnerFor(transport, createFakeExecutor()).runOnce();

  assert.equal(summary.online, false);
  assert.match(summary.error, /network unreachable/);
  assert.equal(summary.accepted, 0);
});

test("a long execution renews its lease before the lease expires", async () => {
  const transport = createFakeTransport({ batches: [[command()]] });
  const timers = [];
  const executor = createFakeExecutor();
  const runner = runnerFor(transport, executor, {
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });

  await runner.runOnce();
  assert.equal(timers.length, 1, "a renewal timer must be armed for the duration of the execution");
  // Half the remaining lease window is the renewal point: early enough to
  // survive one lost request, late enough not to spam the control plane.
  assert.ok(timers[0].ms > 0 && timers[0].ms < 5 * 60 * 1000);

  await timers[0].fn();
  assert.deepEqual(transport.calls.renew, [{ leaseId: "lease-1", workItemId: "work-1" }]);
});

test("the runner reports the profiles it actually saw, and an empty roster stays empty", async () => {
  const transport = createFakeTransport();
  await runnerFor(transport, createFakeExecutor({ profileIds: [] })).runOnce();
  assert.deepEqual(transport.calls.heartbeat[0].reportedProfileIds, []);
});

test("a local Hermes that cannot be listed reports an empty roster rather than guessing", async () => {
  const transport = createFakeTransport();
  const executor = {
    async listProfileIds() { throw new Error("connection refused"); },
    async execute() { throw new Error("unreachable"); },
  };
  const summary = await runnerFor(transport, executor).runOnce();

  assert.deepEqual(transport.calls.heartbeat[0].reportedProfileIds, []);
  assert.equal(transport.calls.heartbeat[0].localRuntimeReachable, false);
  assert.equal(summary.localRuntimeReachable, false);
});

test("a CEO command runs on the default profile and reports both identities", async () => {
  const transport = createFakeTransport({ batches: [[command({ profileId: "bibi-01" })]] });
  const executor = createFakeExecutor({ profileIds: ["default"] });
  const summary = await runnerFor(transport, executor).runOnce();

  assert.equal(summary.succeeded, 1);
  // The executor is handed the physical profile it must actually drive.
  assert.equal(executor.calls[0].executionProfileId, "default");
  assert.equal(executor.calls[0].profileId, "bibi-01");

  // Both identities survive into the report, so evidence can be traced to the
  // role slot the user assigned and the profile that really ran it.
  const succeed = transport.calls.report.at(-1);
  assert.equal(succeed.profileId, "bibi-01");
  assert.equal(succeed.executionProfileId, "default");
});

test("a specialist command runs on its own profile", async () => {
  const transport = createFakeTransport({ batches: [[command({ profileId: "bibi-07" })]] });
  const executor = createFakeExecutor({ profileIds: ["bibi-07"] });
  await runnerFor(transport, executor).runOnce();

  assert.equal(executor.calls[0].executionProfileId, "bibi-07");
  assert.equal(transport.calls.report.at(-1).executionProfileId, "bibi-07");
});

test("the rollback bibi-01 directory is never selected as the CEO runtime", async () => {
  // The Mac reports the rollback original but not the real `default` profile.
  const transport = createFakeTransport({ batches: [[command({ profileId: "bibi-01" })]] });
  const executor = createFakeExecutor({ profileIds: ["bibi-01"] });
  const summary = await runnerFor(transport, executor).runOnce();

  assert.equal(executor.calls.length, 0, "the rollback copy must never be executed");
  assert.equal(summary.released, 1);
  assert.equal(summary.failed, 0);
  const release = transport.calls.report.at(-1);
  assert.equal(release.type, "release");
  assert.match(release.reason, /default/);
});

test("the connector drops physical identifiers it must not run", async () => {
  const transport = createFakeTransport();
  const executor = createFakeExecutor({ profileIds: ["default", "bibi-01", "hermes-director", "bibi-19", "bibi-05"] });
  await runnerFor(transport, executor).runOnce();

  assert.deepEqual(transport.calls.heartbeat[0].reportedProfileIds, ["default", "bibi-05"]);
});
