/**
 * The macOS LaunchAgent that keeps the connector running.
 *
 * A LaunchAgent plist is a world-readable file in the user's home directory
 * that survives backups, Time Machine snapshots and support screenshots. So the
 * rule this module exists to enforce is simple and absolute: **no secret is
 * ever written into the plist.** The plist carries the connector's non-secret
 * environment contract and nothing else; the token is fetched from the Keychain
 * by the wrapper script, at start time, into the child's environment only.
 *
 * That split is why there are two rendered artifacts:
 *
 *   wrapper  a shell script that reads the token from the Keychain and execs
 *            the connector. It contains a service name and an account name,
 *            which are labels, not secrets.
 *   plist    the launchd job. Program arguments, environment, log paths,
 *            RunAtLoad and a throttled KeepAlive.
 *
 * Restart behaviour is bounded on purpose. `KeepAlive` alone will restart a job
 * that fails instantly, forever, as fast as the machine allows;
 * `ThrottleInterval` is what turns that into a slow retry the owner can notice
 * in a log instead of a spin they notice in a fan.
 *
 * Nothing here installs anything by itself. `render` produces text, `install`
 * writes and bootstraps, and both refuse to act at all under `dryRun`.
 */

import { execFile } from "node:child_process";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LAUNCH_AGENT_LABEL = "com.bibi.workspace.connector";
export const LAUNCHCTL_BIN = "/bin/launchctl";
export const WRAPPER_SHELL = "/bin/bash";

/** launchd's own bound on how fast it will restart a job that keeps dying. */
export const DEFAULT_THROTTLE_SECONDS = 30;
const MIN_THROTTLE_SECONDS = 10;
const MAX_THROTTLE_SECONDS = 3_600;

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export class LaunchAgentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LaunchAgentError";
    this.code = code;
  }
}

/**
 * The Hermes locations verified on this Mac, expressed relative to the home
 * directory rather than baked in as one operator's absolute paths. On the Mac
 * this was written for these resolve to
 * `~/.hermes/hermes-agent/venv/bin/hermes`, `~/.hermes` and `~/.hermes/profiles`.
 *
 * The binary lives inside the agent's own virtualenv, which is where the
 * installer puts it and where the verified executable actually is. It is not on
 * PATH and there is no `~/.local/bin/hermes` shim to fall back to, so guessing
 * the conventional location produces a LaunchAgent that renders and installs
 * cleanly and then fails at the first dispatch. An explicit environment value
 * always wins.
 */
export const HERMES_VENV_BIN_SEGMENTS = Object.freeze([".hermes", "hermes-agent", "venv", "bin", "hermes"]);

export function defaultHermesSettings(env = process.env, home = os.homedir()) {
  const value = (key) => String(env?.[key] ?? "").trim();
  return {
    hermesBin: value("BIBI_HERMES_BIN") || path.join(home, ...HERMES_VENV_BIN_SEGMENTS),
    hermesDefaultHome: value("BIBI_HERMES_DEFAULT_HOME") || path.join(home, ".hermes"),
    hermesProfilesRoot: value("BIBI_HERMES_PROFILES_ROOT") || path.join(home, ".hermes", "profiles"),
  };
}

export function launchAgentPaths({ home = os.homedir(), label = LAUNCH_AGENT_LABEL } = {}) {
  const supportDirectory = path.join(home, "Library", "Application Support", "BibiWorkspace");
  const logDirectory = path.join(home, "Library", "Logs", "BibiWorkspace");
  return {
    label,
    supportDirectory,
    logDirectory,
    plistPath: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    wrapperPath: path.join(supportDirectory, "connector-run.sh"),
    stdoutPath: path.join(logDirectory, "connector.out.log"),
    stderrPath: path.join(logDirectory, "connector.err.log"),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function hasControlCharacter(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new LaunchAgentError(`${field}이(가) 필요합니다.`, "MISSING_SETTING");
  if (hasControlCharacter(text)) {
    throw new LaunchAgentError(`${field}에 제어 문자를 쓸 수 없습니다.`, "CONTROL_CHARACTER");
  }
  return text;
}

function absolutePath(value, field) {
  const text = requiredText(value, field);
  if (!path.isAbsolute(text)) {
    throw new LaunchAgentError(`${field}은(는) 절대 경로여야 합니다: ${text}`, "RELATIVE_PATH");
  }
  return text;
}

function controlPlaneUrl(value) {
  const text = requiredText(value, "controlPlaneUrl");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new LaunchAgentError(`controlPlaneUrl이 올바른 URL이 아닙니다: ${text}`, "INVALID_URL");
  }
  // The same rule the connector enforces at startup, applied here so a bad
  // value is caught while rendering rather than after the job is installed.
  if (url.protocol !== "https:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new LaunchAgentError(`controlPlaneUrl은 https여야 합니다: ${text}`, "INSECURE_CONTROL_PLANE");
  }
  return text.replace(/\/+$/, "");
}

/**
 * Normalise everything the two renderers read, so `render`, `install` and the
 * tests all agree on what a setting means.
 */
export function resolveLaunchAgentSettings(input = {}) {
  const home = input.home || os.homedir();
  const label = requiredText(input.label || LAUNCH_AGENT_LABEL, "label");
  if (!LABEL_PATTERN.test(label)) {
    throw new LaunchAgentError(`LaunchAgent 라벨 형식이 올바르지 않습니다: ${label}`, "INVALID_LABEL");
  }

  const throttleSeconds = Number(input.throttleSeconds ?? DEFAULT_THROTTLE_SECONDS);
  if (!Number.isInteger(throttleSeconds) || throttleSeconds < MIN_THROTTLE_SECONDS || throttleSeconds > MAX_THROTTLE_SECONDS) {
    throw new LaunchAgentError(
      `throttleSeconds는 ${MIN_THROTTLE_SECONDS}~${MAX_THROTTLE_SECONDS} 사이의 정수여야 합니다.`,
      "INVALID_THROTTLE",
    );
  }

  return {
    ...launchAgentPaths({ home, label }),
    home,
    nodeLabel: requiredText(input.nodeLabel, "nodeLabel"),
    controlPlaneUrl: controlPlaneUrl(input.controlPlaneUrl),
    repoRoot: absolutePath(input.repoRoot, "repoRoot"),
    nodeBin: absolutePath(input.nodeBin, "nodeBin"),
    hermesBin: absolutePath(input.hermesBin, "hermesBin"),
    hermesDefaultHome: absolutePath(input.hermesDefaultHome, "hermesDefaultHome"),
    hermesProfilesRoot: absolutePath(input.hermesProfilesRoot, "hermesProfilesRoot"),
    keychainService: requiredText(input.keychainService, "keychainService"),
    keychainAccount: requiredText(input.keychainAccount, "keychainAccount"),
    allowLocalExecution: input.allowLocalExecution === true,
    throttleSeconds,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * `'` is closed, escaped and reopened — the only way to put a single quote
 * inside a single-quoted shell word. Every interpolated value in the wrapper
 * goes through this, so a path with a space or a quote is still one argument.
 */
export function shellSingleQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

/** All five predefined XML entities, so the output is valid in any context. */
export function xmlEscape(value) {
  const text = String(value ?? "");
  if (hasControlCharacter(text.replace(/[\n\t\r]/g, ""))) {
    throw new LaunchAgentError("plist 값에 제어 문자를 쓸 수 없습니다.", "CONTROL_CHARACTER");
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The environment launchd hands the connector. Every value here is a label, a
 * path or a URL; none of them is a credential. `BIBI_CONNECTOR_TOKEN` is
 * conspicuously absent and is supplied by the wrapper at start time.
 */
export function launchAgentEnvironment(settings) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
    BIBI_CONNECTOR_MODE: "outbound-local-mac",
    BIBI_CONTROL_PLANE_URL: settings.controlPlaneUrl,
    BIBI_CONNECTOR_NODE_LABEL: settings.nodeLabel,
    BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION: settings.allowLocalExecution ? "true" : "false",
    BIBI_HERMES_BIN: settings.hermesBin,
    BIBI_HERMES_DEFAULT_HOME: settings.hermesDefaultHome,
    BIBI_HERMES_PROFILES_ROOT: settings.hermesProfilesRoot,
  };
}

export function renderWrapperScript(input) {
  const settings = input?.label && input?.plistPath ? input : resolveLaunchAgentSettings(input);
  const connectorEntry = path.join(settings.repoRoot, "connector", "index.js");

  return `#!/bin/bash
# Bibi Workspace connector launcher.
#
# Rendered by \`node connector/ops.js launchagent render|install\`. Do not edit
# by hand; re-render instead.
#
# This file holds NO secret. The connector token lives in the macOS Keychain and
# is read here, at start time, into this process's environment only. It is never
# echoed, never written to the log paths in the plist, and never stored on disk.
set -euo pipefail
umask 077

if ! BIBI_CONNECTOR_TOKEN="$(/usr/bin/security find-generic-password -s ${shellSingleQuote(settings.keychainService)} -a ${shellSingleQuote(settings.keychainAccount)} -w)"; then
  echo "bibi-connector: Keychain에서 커넥터 토큰을 읽지 못했습니다 (${settings.keychainService} / ${settings.keychainAccount})." >&2
  echo "bibi-connector: 'node connector/ops.js provision'을 먼저 실행하세요." >&2
  exit 78
fi
export BIBI_CONNECTOR_TOKEN

# The connector opens no port, so there is nothing to bind and nothing to
# forward. It dials out and exits on SIGTERM; launchd restarts it.
exec ${shellSingleQuote(settings.nodeBin)} ${shellSingleQuote(connectorEntry)}
`;
}

export function renderLaunchAgentPlist(input) {
  const settings = input?.label && input?.plistPath ? input : resolveLaunchAgentSettings(input);
  const environment = launchAgentEnvironment(settings);

  const environmentEntries = Object.entries(environment)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(settings.label)}</string>

    <!-- The wrapper is what reads the Keychain. Nothing secret is in this file. -->
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(WRAPPER_SHELL)}</string>
      <string>${xmlEscape(settings.wrapperPath)}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
${environmentEntries}
    </dict>

    <key>WorkingDirectory</key>
    <string>${xmlEscape(settings.repoRoot)}</string>

    <key>RunAtLoad</key>
    <true/>

    <!-- KeepAlive on its own restarts a job that fails instantly, forever.
         ThrottleInterval is the bound that turns that into a slow retry. -->
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${settings.throttleSeconds}</integer>
    <key>ExitTimeOut</key>
    <integer>20</integer>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>${xmlEscape(settings.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(settings.stderrPath)}</string>
  </dict>
</plist>
`;
}

export function renderLaunchAgent(input) {
  const settings = resolveLaunchAgentSettings(input);
  return {
    settings,
    plist: renderLaunchAgentPlist(settings),
    wrapper: renderWrapperScript(settings),
  };
}

/**
 * The guarantee, checked rather than asserted in a comment: no value the caller
 * marked secret appears in either rendered artifact.
 */
export function assertNoSecretsRendered({ plist, wrapper }, secrets = []) {
  for (const secret of secrets) {
    const value = String(secret ?? "");
    if (value.length < 8) continue;
    if (plist.includes(value)) throw new LaunchAgentError("plist에 비밀 값이 포함되었습니다.", "SECRET_IN_PLIST");
    if (wrapper.includes(value)) throw new LaunchAgentError("래퍼 스크립트에 비밀 값이 포함되었습니다.", "SECRET_IN_WRAPPER");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Install / inspect / uninstall
// ---------------------------------------------------------------------------

const LAUNCHCTL_NOT_LOADED = new Set([3, 113]);

/**
 * @param {object} options
 * @param {object} [options.fs]   `node:fs/promises`-shaped, injected for tests
 * @param {Function} [options.exec] `({file, args}) => Promise<{stdout}>`
 * @param {boolean} [options.dryRun] Renders only. Writes nothing, runs nothing.
 * @param {number} [options.uid]  the launchd `gui/<uid>` domain
 */
export function createLaunchAgentManager({ fs = fsPromises, exec, dryRun = false, uid } = {}) {
  const domainUid = Number.isInteger(uid) ? uid : (typeof process.getuid === "function" ? process.getuid() : 0);
  const run = typeof exec === "function"
    ? exec
    : ({ file, args }) => execFileAsync(file, args, { encoding: "utf8" });

  const serviceTarget = (label) => `gui/${domainUid}/${label}`;

  async function launchctl(args) {
    try {
      const { stdout = "" } = (await run({ file: LAUNCHCTL_BIN, args })) ?? {};
      return { ok: true, stdout: String(stdout) };
    } catch (error) {
      const status = Number(error?.code);
      return { ok: false, status, notLoaded: LAUNCHCTL_NOT_LOADED.has(status) };
    }
  }

  async function exists(target) {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  return {
    dryRun,
    domain: `gui/${domainUid}`,

    render(input) {
      return renderLaunchAgent(input);
    },

    async install(input, { force = false } = {}) {
      const rendered = renderLaunchAgent(input);
      const { settings } = rendered;

      if (dryRun) {
        return {
          dryRun: true,
          installed: false,
          wrote: [],
          launchctl: [],
          settings,
          plist: rendered.plist,
          wrapper: rendered.wrapper,
        };
      }

      if (!force && (await exists(settings.plistPath))) {
        throw new LaunchAgentError(
          `이미 설치되어 있습니다: ${settings.plistPath}. 다시 쓰려면 --force를 지정하세요.`,
          "ALREADY_INSTALLED",
        );
      }

      const wrote = [];
      try {
        await fs.mkdir(path.dirname(settings.plistPath), { recursive: true });
        await fs.mkdir(settings.supportDirectory, { recursive: true });
        await fs.mkdir(settings.logDirectory, { recursive: true });

        // The wrapper is executable and owner-only; the plist is owner-only
        // even though it holds nothing secret, because there is no reason for
        // it to be readable by anything else.
        await fs.writeFile(settings.wrapperPath, rendered.wrapper, { mode: 0o700 });
        wrote.push(settings.wrapperPath);
        await fs.chmod(settings.wrapperPath, 0o700);

        await fs.writeFile(settings.plistPath, rendered.plist, { mode: 0o600 });
        wrote.push(settings.plistPath);
        await fs.chmod(settings.plistPath, 0o600);

        // Replace any previous registration before bootstrapping the new one,
        // so `--force` is a re-install rather than a duplicate.
        await launchctl(["bootout", serviceTarget(settings.label)]);
        const bootstrap = await launchctl(["bootstrap", `gui/${domainUid}`, settings.plistPath]);
        if (!bootstrap.ok) {
          throw new LaunchAgentError(
            `launchctl bootstrap이 실패했습니다(status ${bootstrap.status}).`,
            "BOOTSTRAP_FAILED",
          );
        }

        return {
          dryRun: false,
          installed: true,
          wrote,
          launchctl: ["bootout", "bootstrap"],
          settings,
          plist: rendered.plist,
          wrapper: rendered.wrapper,
        };
      } catch (error) {
        // Leave nothing half-written: a plist without its wrapper is a job that
        // fails on every restart forever.
        for (const target of [...wrote].reverse()) {
          try {
            await fs.rm(target, { force: true });
          } catch {
            // Reported through `install` failing; nothing further to do here.
          }
        }
        throw error;
      }
    },

    async inspect(input) {
      const settings = resolveLaunchAgentSettings(input);
      if (dryRun) {
        return {
          dryRun: true,
          label: settings.label,
          plistPath: settings.plistPath,
          wrapperPath: settings.wrapperPath,
          plistPresent: null,
          wrapperPresent: null,
          loaded: null,
        };
      }

      const [plistPresent, wrapperPresent] = await Promise.all([
        exists(settings.plistPath),
        exists(settings.wrapperPath),
      ]);
      const printed = await launchctl(["print", serviceTarget(settings.label)]);

      // Only a few named fields are lifted out of `launchctl print`; its raw
      // output is never returned, so nothing it happens to include can be
      // printed by a caller that forgets to scrub.
      const stdout = printed.ok ? printed.stdout : "";
      const field = (name) => {
        const match = stdout.match(new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, "m"));
        return match ? match[1] : null;
      };

      return {
        dryRun: false,
        label: settings.label,
        domain: `gui/${domainUid}`,
        plistPath: settings.plistPath,
        wrapperPath: settings.wrapperPath,
        stdoutPath: settings.stdoutPath,
        stderrPath: settings.stderrPath,
        plistPresent,
        wrapperPresent,
        loaded: printed.ok,
        state: field("state"),
        pid: field("pid"),
        lastExitStatus: field("last exit code"),
      };
    },

    /**
     * Remove the job and its two rendered files. Logs are left in place — they
     * are the only record of why the connector stopped — and the Keychain is
     * never touched, because uninstalling a launcher is not revoking a
     * credential.
     */
    async uninstall(input) {
      const settings = resolveLaunchAgentSettings(input);
      if (dryRun) {
        return { dryRun: true, removed: [], booted: false, label: settings.label };
      }

      const bootout = await launchctl(["bootout", serviceTarget(settings.label)]);
      if (!bootout.ok && !bootout.notLoaded) {
        throw new LaunchAgentError(
          `launchctl bootout이 실패했습니다(status ${bootout.status}).`,
          "BOOTOUT_FAILED",
        );
      }

      const removed = [];
      for (const target of [settings.plistPath, settings.wrapperPath]) {
        if (await exists(target)) {
          await fs.rm(target, { force: true });
          removed.push(target);
        }
      }

      return {
        dryRun: false,
        label: settings.label,
        booted: bootout.ok,
        removed,
        keptLogs: [settings.stdoutPath, settings.stderrPath],
      };
    },
  };
}
