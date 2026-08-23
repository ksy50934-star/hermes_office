import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ConnectorConfigError, loadConnectorConfig } from "../connector/config.js";
import {
  LocalExecutionError,
  buildPrompt,
  createHermesCliExecutor,
  homeForExecutionProfile,
} from "../connector/hermesCliExecutor.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Fixtures. These stand in for the real `hermes` binary; the real one is never
// invoked by the test suite.
// ---------------------------------------------------------------------------

/**
 * `.cjs` so Node runs it as CommonJS regardless of this package's "type":
 * "module". The shebang is what lets execFile run it directly.
 */
const FIXTURES = {
  // Reports exactly how it was invoked, so argv and env can be asserted.
  report: `#!/usr/bin/env node
const env = {};
for (const key of Object.keys(process.env)) env[key] = process.env[key];
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env }));
`,
  slow: `#!/usr/bin/env node
setTimeout(() => process.stdout.write("late"), 10000);
`,
  failing: `#!/usr/bin/env node
process.stderr.write("hermes: profile is locked");
process.exit(3);
`,
  leaky: `#!/usr/bin/env node
process.stdout.write("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.sig\\ndone");
`,
  silent: `#!/usr/bin/env node
process.stdout.write("   ");
`,
  chatty: `#!/usr/bin/env node
process.stdout.write("x".repeat(5 * 1024 * 1024));
`,
};

let workspace;

async function fixtureWorkspace() {
  if (workspace) return workspace;
  const root = await mkdtemp(path.join(os.tmpdir(), "bibi-cli-"));

  const bins = {};
  for (const [name, source] of Object.entries(FIXTURES)) {
    const file = path.join(root, `hermes-${name}.cjs`);
    await writeFile(file, source, "utf8");
    await chmod(file, 0o755);
    bins[name] = file;
  }

  // A default home plus a partial set of specialist profile homes, so the
  // "only report what exists" behaviour is observable.
  const defaultHome = path.join(root, "hermes-home");
  const profilesRoot = path.join(defaultHome, "profiles");
  await mkdir(profilesRoot, { recursive: true });
  for (const id of ["bibi-02", "bibi-07", "bibi-18"]) {
    await mkdir(path.join(profilesRoot, id), { recursive: true });
  }
  // The rollback original exists on disk and must still never be offered.
  await mkdir(path.join(profilesRoot, "bibi-01"), { recursive: true });

  workspace = { root, bins, defaultHome, profilesRoot };
  return workspace;
}

async function configFor(binName, overrides = {}) {
  const { bins, defaultHome, profilesRoot } = await fixtureWorkspace();
  return loadConnectorConfig({
    BIBI_CONNECTOR_MODE: "outbound-local-mac",
    BIBI_CONTROL_PLANE_URL: "https://workspace.example.com",
    BIBI_CONNECTOR_TOKEN: "connector-token-must-not-leak",
    BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION: "true",
    BIBI_HERMES_BIN: bins[binName],
    BIBI_HERMES_DEFAULT_HOME: defaultHome,
    BIBI_HERMES_PROFILES_ROOT: profilesRoot,
    ...overrides,
  });
}

function command(overrides = {}) {
  return {
    id: "cmd-1",
    workItemId: "work-1",
    kind: "work",
    attempt: 1,
    profileId: "bibi-02",
    executionProfileId: "bibi-02",
    title: "보고서 초안",
    brief: "지난달 결과를 정리해줘",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

test("live execution fails closed without the binary and both home paths", async () => {
  const { bins, defaultHome, profilesRoot } = await fixtureWorkspace();
  const base = {
    BIBI_CONNECTOR_MODE: "outbound-local-mac",
    BIBI_CONTROL_PLANE_URL: "https://workspace.example.com",
    BIBI_CONNECTOR_TOKEN: "t",
    BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION: "true",
    BIBI_HERMES_BIN: bins.report,
    BIBI_HERMES_DEFAULT_HOME: defaultHome,
    BIBI_HERMES_PROFILES_ROOT: profilesRoot,
  };

  for (const [key, code] of [
    ["BIBI_HERMES_BIN", "MISSING_HERMES_BIN"],
    ["BIBI_HERMES_DEFAULT_HOME", "MISSING_HERMES_DEFAULT_HOME"],
    ["BIBI_HERMES_PROFILES_ROOT", "MISSING_HERMES_PROFILES_ROOT"],
  ]) {
    assert.throws(
      () => loadConnectorConfig({ ...base, [key]: "" }),
      (error) => error instanceof ConnectorConfigError && error.code === code,
      `${key} must be required for live execution`,
    );
  }

  // In dry-run mode the same omissions are fine: nothing will be executed.
  assert.doesNotThrow(() => loadConnectorConfig({
    ...base,
    BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION: "false",
    BIBI_HERMES_BIN: "",
    BIBI_HERMES_DEFAULT_HOME: "",
    BIBI_HERMES_PROFILES_ROOT: "",
  }));
});

test("the obsolete HTTP execution settings are gone from the config surface", async () => {
  const source = await readFile(path.join(projectRoot, "connector", "config.js"), "utf8");
  assert.doesNotMatch(source, /HERMES_LOCAL_URL/);
  assert.doesNotMatch(source, /BIBI_HERMES_EXECUTION_ENDPOINT/);

  const config = await configFor("report");
  assert.equal(config.hermesLocalUrl, undefined);
  assert.equal(config.executionEndpoint, undefined);
  assert.equal(config.hermesMaxTurns, 12);
  assert.ok(config.hermesTimeoutMs > 0);
});

test("turn and timeout limits are configurable and validated", async () => {
  const config = await configFor("report", {
    BIBI_HERMES_MAX_TURNS: "3",
    BIBI_HERMES_TIMEOUT_MS: "45000",
  });
  assert.equal(config.hermesMaxTurns, 3);
  assert.equal(config.hermesTimeoutMs, 45000);

  for (const key of ["BIBI_HERMES_MAX_TURNS", "BIBI_HERMES_TIMEOUT_MS"]) {
    await assert.rejects(
      async () => configFor("report", { [key]: "0" }),
      (error) => error.code === "INVALID_NUMBER",
      `${key} must reject a non-positive value`,
    );
  }
});

// ---------------------------------------------------------------------------
// Profile selection is by HERMES_HOME only
// ---------------------------------------------------------------------------

test("the CEO executes from the default home, never from the rollback directory", async () => {
  const config = await configFor("report");
  const { defaultHome, profilesRoot } = await fixtureWorkspace();

  assert.equal(homeForExecutionProfile("default", config), defaultHome);
  // The rollback original is a real directory here, and still refused.
  assert.throws(
    () => homeForExecutionProfile("bibi-01", config),
    (error) => error instanceof LocalExecutionError && error.code === "INVALID_EXECUTION_PROFILE",
  );
  assert.equal(homeForExecutionProfile("bibi-02", config), path.join(profilesRoot, "bibi-02"));
  assert.equal(homeForExecutionProfile("bibi-18", config), path.join(profilesRoot, "bibi-18"));
});

test("a profile identifier is matched exactly, so no path can be traversed", async () => {
  const config = await configFor("report");
  for (const id of [
    "", "  ", "bibi-19", "bibi-1", "BIBI-02", "hermes-director",
    "../bibi-02", "bibi-02/../bibi-03", "bibi-02/", "/etc", "..", null, undefined, 2,
  ]) {
    assert.throws(
      () => homeForExecutionProfile(id, config),
      (error) => error.code === "INVALID_EXECUTION_PROFILE",
      `${String(id)} must be refused`,
    );
  }
});

test("listProfileIds reports only expected profiles whose home directories exist", async () => {
  const executor = createHermesCliExecutor(await configFor("report"));
  const listed = await executor.listProfileIds();

  assert.deepEqual(listed, ["default", "bibi-02", "bibi-07", "bibi-18"]);
  // Present on disk, but never a runtime.
  assert.ok(!listed.includes("bibi-01"));
  // Absent on disk, so not claimed as available.
  assert.ok(!listed.includes("bibi-03"));
});

test("a missing profiles root yields an empty roster rather than an error", async () => {
  const { bins, defaultHome } = await fixtureWorkspace();
  const config = await configFor("report", {
    BIBI_HERMES_PROFILES_ROOT: path.join(defaultHome, "does-not-exist"),
    BIBI_HERMES_BIN: bins.report,
  });
  assert.deepEqual(await createHermesCliExecutor(config).listProfileIds(), ["default"]);
});

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

async function invoke(binName, commandOverrides = {}, configOverrides = {}) {
  const config = await configFor(binName, configOverrides);
  const executor = createHermesCliExecutor(config);
  return executor.execute(command(commandOverrides));
}

test("the CLI is invoked with the verified argv contract", async () => {
  const result = await invoke("report", {}, { BIBI_HERMES_MAX_TURNS: "5" });
  const observed = JSON.parse(result.summary);

  assert.deepEqual(observed.argv, [
    "chat",
    "-q",
    "보고서 초안\n\n지난달 결과를 정리해줘",
    "-Q",
    "--source",
    "tool",
    "--max-turns",
    "5",
  ]);
});

test("a specialist profile is selected only by HERMES_HOME", async () => {
  const { profilesRoot } = await fixtureWorkspace();
  const result = await invoke("report", { profileId: "bibi-07", executionProfileId: "bibi-07" });
  const observed = JSON.parse(result.summary);

  assert.equal(observed.env.HERMES_HOME, path.join(profilesRoot, "bibi-07"));
  // The profile must never be passed as an argument.
  assert.ok(!observed.argv.includes("--profile"));
  assert.ok(!observed.argv.some((value) => value.includes("bibi-07")));
});

test("the CEO role slot runs with HERMES_HOME set to the default home", async () => {
  const { defaultHome } = await fixtureWorkspace();
  const result = await invoke("report", { profileId: "bibi-01", executionProfileId: "default" });
  const observed = JSON.parse(result.summary);

  assert.equal(observed.env.HERMES_HOME, defaultHome);
  assert.ok(!observed.env.HERMES_HOME.includes("profiles/bibi-01"));
});

test("the child environment carries no workspace or cloud secret", async () => {
  const result = await invoke("report");
  const observed = JSON.parse(result.summary);
  const keys = Object.keys(observed.env);

  for (const key of keys) {
    assert.doesNotMatch(key, /^BIBI_/, `${key} must not reach the child`);
    assert.doesNotMatch(key, /SUPABASE/, `${key} must not reach the child`);
  }
  assert.ok(!JSON.stringify(observed.env).includes("connector-token-must-not-leak"));
  // A usable but minimal environment.
  assert.ok(keys.includes("HERMES_HOME"));
  assert.ok(keys.includes("PATH"));
});

test("a work command and a chat command build different prompts", () => {
  assert.equal(
    buildPrompt(command()),
    "보고서 초안\n\n지난달 결과를 정리해줘",
  );
  // A chat turn is the user's message verbatim; the title is only a label.
  assert.equal(
    buildPrompt(command({ kind: "chat", title: "오늘 일정 정리", brief: "오늘 일정 정리해줘" })),
    "오늘 일정 정리해줘",
  );
  assert.equal(buildPrompt(command({ brief: "" })), "보고서 초안");
  assert.throws(() => buildPrompt(command({ title: "", brief: "" })), (error) => error.code === "EMPTY_PROMPT");
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test("an overrunning CLI is killed and reported as a timeout", async () => {
  await assert.rejects(
    () => invoke("slow", {}, { BIBI_HERMES_TIMEOUT_MS: "300" }),
    (error) => error instanceof LocalExecutionError && error.code === "EXECUTION_TIMEOUT",
  );
});

test("a non-zero exit is reported with its redacted stderr", async () => {
  await assert.rejects(
    () => invoke("failing"),
    (error) => error.code === "EXECUTION_FAILED" && /profile is locked/.test(error.message),
  );
});

test("a missing binary is reported rather than throwing a raw spawn error", async () => {
  const { defaultHome, profilesRoot } = await fixtureWorkspace();
  const config = loadConnectorConfig({
    BIBI_CONNECTOR_MODE: "outbound-local-mac",
    BIBI_CONTROL_PLANE_URL: "https://workspace.example.com",
    BIBI_CONNECTOR_TOKEN: "t",
    BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION: "true",
    BIBI_HERMES_BIN: path.join(defaultHome, "no-such-binary"),
    BIBI_HERMES_DEFAULT_HOME: defaultHome,
    BIBI_HERMES_PROFILES_ROOT: profilesRoot,
  });
  await assert.rejects(
    () => createHermesCliExecutor(config).execute(command()),
    (error) => error instanceof LocalExecutionError && error.code === "EXECUTION_FAILED",
  );
});

test("secrets printed by the CLI never survive into the result or its evidence", async () => {
  const result = await invoke("leaky");
  const serialised = JSON.stringify(result);

  assert.ok(!serialised.includes("eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.sig"));
  assert.match(serialised, /\[redacted\]/);
  assert.ok(result.summary.includes("done"));
});

test("empty CLI output is an error, not a silently successful empty answer", async () => {
  await assert.rejects(
    () => invoke("silent"),
    (error) => error.code === "EMPTY_LOCAL_RESULT",
  );
});

test("runaway output is bounded instead of buffered without limit", async () => {
  await assert.rejects(
    () => invoke("chatty", {}, { BIBI_HERMES_MAX_OUTPUT_BYTES: "4096" }),
    (error) => error instanceof LocalExecutionError && error.code === "EXECUTION_FAILED",
  );
});

test("a successful run produces evidence with the argv and a hash of the output", async () => {
  const result = await invoke("report");
  assert.ok(result.evidence.length >= 2);

  const commandEvidence = result.evidence.find((item) => item.kind === "command");
  assert.ok(commandEvidence, "the invocation itself must be evidence");
  assert.match(commandEvidence.inlineExcerpt, /"--max-turns"/);
  assert.match(commandEvidence.inlineExcerpt, /"executionProfileId": "bibi-02"/);
  assert.match(commandEvidence.inlineExcerpt, /"profileId": "bibi-02"/);

  const logEvidence = result.evidence.find((item) => item.kind === "log");
  assert.match(logEvidence.sha256, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

test("the CLI executor opens no inbound surface and reads no local state", async () => {
  const files = (await readdir(path.join(projectRoot, "connector"))).filter((name) => name.endsWith(".js"));
  assert.ok(files.includes("hermesCliExecutor.js"));
  // The replaced HTTP executor must be gone, not merely unused.
  assert.ok(!files.includes("hermesLocalExecutor.js"));

  const source = await readFile(path.join(projectRoot, "connector", "hermesCliExecutor.js"), "utf8");
  for (const pattern of [
    /createServer\s*\(/,
    /\.listen\s*\(/,
    /node:net|node:http\b|node:https\b/,
    // Profile internals are never opened.
    /state\.db|state\.sqlite|cookies/i,
    /config\.ya?ml/i,
    // No shell, ever: the prompt is user-controlled.
    /\bexec\s*\(/,
    /shell\s*:\s*true/,
  ]) {
    assert.doesNotMatch(source, pattern, `hermesCliExecutor.js must not match ${pattern}`);
  }
  assert.match(source, /execFile/);
});
