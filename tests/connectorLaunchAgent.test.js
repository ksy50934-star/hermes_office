import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KEYCHAIN_SERVICES, SECURITY_BIN } from "../connector/keychain.js";
import {
  DEFAULT_THROTTLE_SECONDS,
  LAUNCHCTL_BIN,
  LAUNCH_AGENT_LABEL,
  LaunchAgentError,
  WRAPPER_SHELL,
  assertNoSecretsRendered,
  createLaunchAgentManager,
  HERMES_VENV_BIN_SEGMENTS,
  defaultHermesSettings,
  launchAgentEnvironment,
  launchAgentPaths,
  renderLaunchAgent,
  resolveLaunchAgentSettings,
  shellSingleQuote,
  xmlEscape,
} from "../connector/launchAgent.js";
import { EXIT, runOps } from "../connector/ops.js";

const HOME = "/Users/tester";
const TOKEN = "bibi_TESTTOKENvalue0123456789abcdefghij";
const PASSWORD = "Bibi-Workspace-2026!";
const BELL = String.fromCharCode(0x07);

const SETTINGS = Object.freeze({
  home: HOME,
  nodeLabel: "local-mac",
  controlPlaneUrl: "https://bibi-workspace-18.example.app",
  repoRoot: "/opt/bibi/workspace",
  nodeBin: "/usr/local/bin/node",
  hermesBin: `${HOME}/.hermes/hermes-agent/venv/bin/hermes`,
  hermesDefaultHome: `${HOME}/.hermes`,
  hermesProfilesRoot: `${HOME}/.hermes/profiles`,
  keychainService: KEYCHAIN_SERVICES.connectorToken,
  keychainAccount: "local-mac",
  allowLocalExecution: true,
});

function render(overrides = {}) {
  return renderLaunchAgent({ ...SETTINGS, ...overrides });
}

/** An fs double that records rather than writes; every test starts from this. */
function fakeFs({ present = [], failWrite = null } = {}) {
  const files = new Map();
  const calls = [];
  const existing = new Set(present);

  return {
    files,
    calls,
    names: () => calls.map((call) => call.name),
    async mkdir(target, options) {
      calls.push({ name: "mkdir", target, options });
    },
    async writeFile(target, contents, options) {
      calls.push({ name: "writeFile", target, mode: options?.mode });
      if (failWrite && target === failWrite) throw new Error("disk full");
      files.set(target, contents);
      existing.add(target);
    },
    async chmod(target, mode) {
      calls.push({ name: "chmod", target, mode });
    },
    async rm(target) {
      calls.push({ name: "rm", target });
      files.delete(target);
      existing.delete(target);
    },
    async stat(target) {
      calls.push({ name: "stat", target });
      if (!existing.has(target)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isFile: () => true };
    },
  };
}

function fakeExec({ fail = new Set(), stdout = "" } = {}) {
  const calls = [];
  return {
    calls,
    run: async ({ file, args }) => {
      calls.push({ file, args });
      if (fail.has(args[0])) throw Object.assign(new Error(`${args[0]} failed`), { code: 5 });
      return { stdout };
    },
  };
}

const manager = (overrides = {}) => createLaunchAgentManager({ uid: 501, ...overrides });

// ---------------------------------------------------------------------------
// The no-secrets guarantee
// ---------------------------------------------------------------------------

test("the plist carries the connector's environment contract and no credential", () => {
  const { plist } = render();

  for (const [key, value] of Object.entries(launchAgentEnvironment(resolveLaunchAgentSettings(SETTINGS)))) {
    assert.ok(plist.includes(`<key>${key}</key>`), `plist must set ${key}`);
    assert.ok(plist.includes(`<string>${value}</string>`), `plist must set ${key} to ${value}`);
  }

  assert.match(plist, /<key>BIBI_CONNECTOR_MODE<\/key>\s*<string>outbound-local-mac<\/string>/);
  assert.match(plist, /<key>BIBI_HERMES_DEFAULT_HOME<\/key>\s*<string>\/Users\/tester\/\.hermes<\/string>/);

  // The whole point of the wrapper: the token is not here, in any form.
  assert.equal(plist.includes("BIBI_CONNECTOR_TOKEN"), false);
  assert.equal(plist.includes(TOKEN), false);
  assert.equal(plist.includes(PASSWORD), false);
  // And an inbound port is not something the plist can accidentally introduce.
  assert.equal(plist.includes("BIBI_CONNECTOR_INBOUND_PORT"), false);
  assert.equal(/Sockets|inetdCompatibility/.test(plist), false);
});

test("the wrapper reads the token from the Keychain at start time and execs the connector", () => {
  const { wrapper, settings } = render();

  assert.match(wrapper, /^#!\/bin\/bash\n/);
  assert.match(wrapper, /set -euo pipefail/);
  assert.match(wrapper, /umask 077/);
  assert.ok(wrapper.includes(`${SECURITY_BIN} find-generic-password`), "the token comes from the Keychain");
  assert.ok(wrapper.includes(shellSingleQuote(KEYCHAIN_SERVICES.connectorToken)));
  assert.ok(wrapper.includes(shellSingleQuote("local-mac")));
  assert.ok(
    wrapper.includes(`exec ${shellSingleQuote(settings.nodeBin)} ${shellSingleQuote(path.join(settings.repoRoot, "connector", "index.js"))}`),
    "the wrapper must exec the connector, not fork it",
  );

  // The token is exported into the child and never echoed anywhere.
  assert.match(wrapper, /export BIBI_CONNECTOR_TOKEN/);
  assert.equal(/echo .*\$BIBI_CONNECTOR_TOKEN/.test(wrapper), false);
  assert.equal(/set -x/.test(wrapper), false);
  assert.equal(wrapper.includes(TOKEN), false);
});

test("a secret that reached a rendered artifact is caught rather than written", () => {
  const clean = render();
  assert.equal(assertNoSecretsRendered(clean, [TOKEN, PASSWORD]), true);

  assert.throws(
    () => assertNoSecretsRendered({ plist: `<string>${TOKEN}</string>`, wrapper: "" }, [TOKEN]),
    (error) => error instanceof LaunchAgentError && error.code === "SECRET_IN_PLIST",
  );
  assert.throws(
    () => assertNoSecretsRendered({ plist: "", wrapper: `TOKEN=${PASSWORD}` }, [PASSWORD]),
    (error) => error.code === "SECRET_IN_WRAPPER",
  );
});

// ---------------------------------------------------------------------------
// Restart behaviour and paths
// ---------------------------------------------------------------------------

test("the job runs at load and restarts on a bounded throttle, with both logs named", () => {
  const { plist } = render();

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, new RegExp(`<key>ThrottleInterval</key>\\s*<integer>${DEFAULT_THROTTLE_SECONDS}</integer>`));
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>20<\/integer>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>[^<]*connector\.out\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>[^<]*connector\.err\.log<\/string>/);
  assert.match(plist, new RegExp(`<string>${WRAPPER_SHELL}</string>`));

  assert.match(render({ throttleSeconds: 120 }).plist, /<integer>120<\/integer>/);
});

test("every path the job uses is derived from one home directory", () => {
  const paths = launchAgentPaths({ home: HOME });
  assert.equal(paths.label, LAUNCH_AGENT_LABEL);
  assert.equal(paths.plistPath, `${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`);
  assert.equal(paths.wrapperPath, `${HOME}/Library/Application Support/BibiWorkspace/connector-run.sh`);
  assert.equal(paths.stdoutPath, `${HOME}/Library/Logs/BibiWorkspace/connector.out.log`);
  assert.equal(paths.stderrPath, `${HOME}/Library/Logs/BibiWorkspace/connector.err.log`);
});

test("the Hermes defaults are the verified layout, expressed relative to home", () => {
  const defaults = defaultHermesSettings({}, HOME);
  assert.deepEqual(defaults, {
    hermesBin: `${HOME}/.hermes/hermes-agent/venv/bin/hermes`,
    hermesDefaultHome: `${HOME}/.hermes`,
    hermesProfilesRoot: `${HOME}/.hermes/profiles`,
  });

  // An explicit environment value always wins over the default.
  assert.equal(
    defaultHermesSettings({ BIBI_HERMES_BIN: "/opt/hermes/bin/hermes" }, HOME).hermesBin,
    "/opt/hermes/bin/hermes",
  );
});

test("the default Hermes binary is the one inside the agent virtualenv, not a PATH shim", () => {
  // The conventional `~/.local/bin/hermes` does not exist on the Mac this runs
  // on. Defaulting to it renders and installs a LaunchAgent that fails at the
  // first dispatch instead of at install time, which is the expensive way to
  // find out. The verified binary is the virtualenv's own entry point.
  assert.deepEqual(HERMES_VENV_BIN_SEGMENTS, [".hermes", "hermes-agent", "venv", "bin", "hermes"]);
  assert.equal(
    defaultHermesSettings({}, HOME).hermesBin,
    path.join(HOME, ...HERMES_VENV_BIN_SEGMENTS),
  );
  assert.doesNotMatch(defaultHermesSettings({}, HOME).hermesBin, /\.local\/bin\/hermes$/);

  // It sits under the Hermes home rather than beside it, so the two defaults
  // cannot drift onto different installs.
  assert.ok(
    defaultHermesSettings({}, HOME).hermesBin.startsWith(`${defaultHermesSettings({}, HOME).hermesDefaultHome}/`),
  );
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

test("plist values are XML-escaped and shell values are single-quoted", () => {
  assert.equal(xmlEscape(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
  assert.throws(() => xmlEscape(`bad${BELL}value`), (error) => error.code === "CONTROL_CHARACTER");

  assert.equal(shellSingleQuote("plain"), "'plain'");
  assert.equal(shellSingleQuote("it's"), `'it'\\''s'`);
  assert.equal(shellSingleQuote("a b; rm -rf /"), "'a b; rm -rf /'");

  const { plist } = render({ controlPlaneUrl: "https://example.test/?a=1&b=2" });
  assert.ok(plist.includes("<string>https://example.test/?a=1&amp;b=2</string>"));
  assert.equal(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(plist), false, "no unescaped ampersand");
});

test("the rendered plist parses and the rendered wrapper is valid bash", (t) => {
  if (!existsSync("/usr/bin/plutil") || !existsSync(WRAPPER_SHELL)) {
    t.skip("plutil or bash is unavailable on this host");
    return;
  }

  const directory = mkdtempSync(path.join(os.tmpdir(), "bibi-launchagent-"));
  try {
    // Paths carrying every character the escaping has to survive.
    const { plist, wrapper } = render({
      controlPlaneUrl: "https://example.test/?a=1&b=2",
      keychainAccount: `it's-a-node`,
      repoRoot: "/opt/bibi & co/workspace",
    });

    const plistPath = path.join(directory, "agent.plist");
    const wrapperPath = path.join(directory, "wrapper.sh");
    writeFileSync(plistPath, plist, "utf8");
    writeFileSync(wrapperPath, wrapper, "utf8");

    execFileSync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" });
    execFileSync(WRAPPER_SHELL, ["-n", wrapperPath], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("settings that would produce a broken or unsafe job are refused at render time", () => {
  const cases = [
    [{ repoRoot: "relative/path" }, "RELATIVE_PATH"],
    [{ nodeBin: "node" }, "RELATIVE_PATH"],
    [{ hermesBin: "" }, "MISSING_SETTING"],
    [{ controlPlaneUrl: "http://workspace.example.com" }, "INSECURE_CONTROL_PLANE"],
    [{ controlPlaneUrl: "not a url" }, "INVALID_URL"],
    [{ label: "no spaces allowed" }, "INVALID_LABEL"],
    [{ throttleSeconds: 0 }, "INVALID_THROTTLE"],
    [{ throttleSeconds: 99_999 }, "INVALID_THROTTLE"],
    [{ nodeLabel: "" }, "MISSING_SETTING"],
  ];

  for (const [overrides, code] of cases) {
    assert.throws(
      () => render(overrides),
      (error) => error instanceof LaunchAgentError && error.code === code,
      `expected ${JSON.stringify(overrides)} to fail with ${code}`,
    );
  }

  // Loopback over plain HTTP is how the owner runs the control plane before the
  // first deploy, and stays allowed — exactly as `connector/config.js` has it.
  assert.doesNotThrow(() => render({ controlPlaneUrl: "http://127.0.0.1:5173" }));
});

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

test("install writes the wrapper and the plist with owner-only modes, then bootstraps", async () => {
  const fs = fakeFs();
  const exec = fakeExec();
  const result = await manager({ fs, exec: exec.run }).install(SETTINGS);

  const { settings } = result;
  assert.equal(result.installed, true);
  assert.deepEqual(result.wrote, [settings.wrapperPath, settings.plistPath]);

  const wrapperWrite = fs.calls.find((call) => call.name === "writeFile" && call.target === settings.wrapperPath);
  const plistWrite = fs.calls.find((call) => call.name === "writeFile" && call.target === settings.plistPath);
  assert.equal(wrapperWrite.mode, 0o700);
  assert.equal(plistWrite.mode, 0o600);

  // Bootout first, so `--force` is a re-install rather than a duplicate job.
  assert.deepEqual(exec.calls.map((call) => call.args[0]), ["bootout", "bootstrap"]);
  assert.deepEqual(exec.calls[0].args, ["bootout", `gui/501/${LAUNCH_AGENT_LABEL}`]);
  assert.deepEqual(exec.calls[1].args, ["bootstrap", "gui/501", settings.plistPath]);
  assert.equal(exec.calls[0].file, LAUNCHCTL_BIN);

  // Installing a launcher is not storing a credential.
  assert.equal(exec.calls.some((call) => call.file === SECURITY_BIN), false);
  assert.equal(fs.files.get(settings.plistPath).includes("BIBI_CONNECTOR_TOKEN"), false);
});

test("install refuses to overwrite an existing job unless it is asked to", async () => {
  const { plistPath } = launchAgentPaths({ home: HOME });
  const fs = fakeFs({ present: [plistPath] });
  const exec = fakeExec();

  await assert.rejects(
    manager({ fs, exec: exec.run }).install(SETTINGS),
    (error) => error instanceof LaunchAgentError && error.code === "ALREADY_INSTALLED",
  );
  assert.equal(fs.names().includes("writeFile"), false);
  assert.deepEqual(exec.calls, []);

  const forced = await manager({ fs, exec: exec.run }).install(SETTINGS, { force: true });
  assert.equal(forced.installed, true);
});

test("a failed bootstrap leaves nothing behind, because a plist without its wrapper never recovers", async () => {
  const fs = fakeFs();
  const exec = fakeExec({ fail: new Set(["bootstrap"]) });
  const { plistPath, wrapperPath } = launchAgentPaths({ home: HOME });

  await assert.rejects(
    manager({ fs, exec: exec.run }).install(SETTINGS),
    (error) => error.code === "BOOTSTRAP_FAILED",
  );

  assert.deepEqual(fs.calls.filter((call) => call.name === "rm").map((call) => call.target), [plistPath, wrapperPath]);
  assert.equal(fs.files.has(plistPath), false);
  assert.equal(fs.files.has(wrapperPath), false);
});

// ---------------------------------------------------------------------------
// Inspect and uninstall
// ---------------------------------------------------------------------------

test("inspect reports presence and a few named fields, never launchctl's raw output", async () => {
  const fs = fakeFs({ present: [launchAgentPaths({ home: HOME }).plistPath] });
  const exec = fakeExec({
    stdout: [
      `${LAUNCH_AGENT_LABEL} = {`,
      "\tstate = running",
      "\tpid = 4242",
      "\tlast exit code = 0",
      '\tenvironment = { SOMETHING_SENSITIVE = "do-not-echo-this-value" }',
      "}",
    ].join("\n"),
  });

  const report = await manager({ fs, exec: exec.run }).inspect(SETTINGS);

  assert.equal(report.plistPresent, true);
  assert.equal(report.wrapperPresent, false);
  assert.equal(report.loaded, true);
  assert.equal(report.state, "running");
  assert.equal(report.pid, "4242");
  assert.equal(report.lastExitStatus, "0");
  assert.equal(report.domain, "gui/501");
  assert.equal(JSON.stringify(report).includes("do-not-echo-this-value"), false);

  const notLoaded = await manager({ fs: fakeFs(), exec: fakeExec({ fail: new Set(["print"]) }).run }).inspect(SETTINGS);
  assert.equal(notLoaded.loaded, false);
  assert.equal(notLoaded.state, null);
});

test("uninstall removes the job and its files, keeps the logs and never touches the Keychain", async () => {
  const { plistPath, wrapperPath, stdoutPath, stderrPath } = launchAgentPaths({ home: HOME });
  const fs = fakeFs({ present: [plistPath, wrapperPath, stdoutPath, stderrPath] });
  const exec = fakeExec();

  const result = await manager({ fs, exec: exec.run }).uninstall(SETTINGS);

  assert.equal(result.booted, true);
  assert.deepEqual(result.removed, [plistPath, wrapperPath]);
  assert.deepEqual(result.keptLogs, [stdoutPath, stderrPath]);
  assert.deepEqual(exec.calls.map((call) => call.args[0]), ["bootout"]);

  // Logs survive: they are the only record of why the connector stopped.
  assert.deepEqual(fs.calls.filter((call) => call.name === "rm").map((call) => call.target), [plistPath, wrapperPath]);
  // Revoking a credential is a separate, deliberate act.
  assert.equal(exec.calls.some((call) => call.file === SECURITY_BIN), false);
});

test("uninstalling a job that was never loaded is not an error, but a real failure is", async () => {
  const failing = manager({ fs: fakeFs(), exec: fakeExec({ fail: new Set(["bootout"]) }).run });
  // status 5 is a genuine failure, not launchd's "no such service".
  await assert.rejects(failing.uninstall(SETTINGS), (error) => error.code === "BOOTOUT_FAILED");

  const absent = createLaunchAgentManager({
    uid: 501,
    fs: fakeFs(),
    exec: async ({ args }) => {
      if (args[0] === "bootout") throw Object.assign(new Error("no such service"), { code: 3 });
      return { stdout: "" };
    },
  });
  const result = await absent.uninstall(SETTINGS);
  assert.equal(result.booted, false);
  assert.deepEqual(result.removed, []);
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test("a dry-run install renders the exact artifacts and writes none of them", async () => {
  const fs = fakeFs();
  const exec = fakeExec();
  const dry = createLaunchAgentManager({ uid: 501, fs, exec: exec.run, dryRun: true });

  const result = await dry.install(SETTINGS);

  assert.equal(result.dryRun, true);
  assert.equal(result.installed, false);
  assert.deepEqual(result.wrote, []);
  assert.deepEqual(result.launchctl, []);
  assert.deepEqual(fs.calls, []);
  assert.deepEqual(exec.calls, []);

  // What it renders is byte-for-byte what a live install would have written.
  const live = render();
  assert.equal(result.plist, live.plist);
  assert.equal(result.wrapper, live.wrapper);
});

test("a dry-run inspect and uninstall run neither launchctl nor a stat", async () => {
  const fs = fakeFs({ present: [launchAgentPaths({ home: HOME }).plistPath] });
  const exec = fakeExec();
  const dry = createLaunchAgentManager({ uid: 501, fs, exec: exec.run, dryRun: true });

  const inspected = await dry.inspect(SETTINGS);
  assert.equal(inspected.dryRun, true);
  // Unknown rather than false: a dry run must not claim to know what is installed.
  assert.equal(inspected.plistPresent, null);
  assert.equal(inspected.loaded, null);

  const uninstalled = await dry.uninstall(SETTINGS);
  assert.equal(uninstalled.dryRun, true);
  assert.deepEqual(uninstalled.removed, []);

  assert.deepEqual(fs.calls, []);
  assert.deepEqual(exec.calls, []);
});

// ---------------------------------------------------------------------------
// Through the command line
// ---------------------------------------------------------------------------

test("`launchagent render` prints the artifacts verbatim and installs nothing", async () => {
  const out = [];
  const fs = fakeFs();
  const exec = fakeExec();

  const code = await runOps({
    argv: [
      "launchagent", "render",
      "--node-label", "local-mac",
      "--control-plane-url", "https://bibi-workspace-18.example.app",
      "--node-bin", "/usr/local/bin/node",
      "--allow-local-execution",
    ],
    env: {},
    write: (line) => out.push(line),
    writeError: (line) => out.push(line),
    makeLaunchAgentManager: (options) => createLaunchAgentManager({ ...options, uid: 501, fs, exec: exec.run }),
  });

  assert.equal(code, EXIT.OK);
  const output = out.join("");

  // The `TOKEN=` line in the wrapper must survive redaction intact, or what is
  // printed for review is not what would be installed.
  assert.ok(output.includes(`BIBI_CONNECTOR_TOKEN="$(${SECURITY_BIN} find-generic-password`));
  assert.equal(output.includes("[redacted]"), false);
  assert.match(output, /<key>RunAtLoad<\/key>/);
  assert.deepEqual(fs.calls, []);
  assert.deepEqual(exec.calls, []);
});

test("`launchagent install --dry-run` reports that it touched nothing", async () => {
  const out = [];
  const fs = fakeFs();
  const exec = fakeExec();

  const code = await runOps({
    argv: [
      "launchagent", "install",
      "--node-label", "local-mac",
      "--control-plane-url", "https://bibi-workspace-18.example.app",
      "--node-bin", "/usr/local/bin/node",
      "--dry-run", "--json",
    ],
    env: {},
    write: (line) => out.push(line),
    writeError: (line) => out.push(line),
    makeLaunchAgentManager: (options) => createLaunchAgentManager({ ...options, uid: 501, fs, exec: exec.run }),
  });

  assert.equal(code, EXIT.OK, out.join(""));
  const report = JSON.parse(out.join(""));
  assert.equal(report.status, "dry-run");
  assert.deepEqual(report.touched, []);
  assert.deepEqual(report.wrote, []);
  assert.equal(report.keychain.service, KEYCHAIN_SERVICES.connectorToken);
  assert.deepEqual(fs.calls, []);
  assert.deepEqual(exec.calls, []);
});
