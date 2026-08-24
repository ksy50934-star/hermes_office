#!/usr/bin/env node
/**
 * Operational command line for the Bibi Workspace connector.
 *
 *   node connector/ops.js provision   --owner-email <email> --node-label <label>
 *   node connector/ops.js readback    --owner-email <email> --node-label <label>
 *   node connector/ops.js launchagent render|install|inspect|uninstall
 *
 * Three rules shape the interface.
 *
 * **Non-interactive.** Nothing prompts. The owner's email and the node label are
 * explicit, non-secret arguments; the password arrives on stdin or on an
 * inherited file descriptor; the Supabase service credential comes only from
 * the environment. There is deliberately no `--password` flag — a secret in
 * argv is a secret in the shell history and in `ps`.
 *
 * **Nothing is printed that could be used.** Every byte of output goes through
 * the secret guard, so even a message assembled by a dependency cannot carry a
 * token, a password or a service key out of the process.
 *
 * **`--dry-run` touches nothing.** No Keychain call, no Supabase client is even
 * imported, no `launchctl`, no file under `~/Library`. It validates the inputs
 * and renders the artifacts, which is the whole point: the plist and the
 * wrapper can be reviewed before anything is installed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateNewPassword } from "../src/bibi/passwordPolicy.js";
import { KEYCHAIN_SERVICES, createKeychain } from "./keychain.js";
import {
  createLaunchAgentManager,
  defaultHermesSettings,
  renderLaunchAgent,
} from "./launchAgent.js";
import {
  ProvisioningError,
  createSupabaseAdmin,
  keychainCoordinates,
  normaliseNodeLabel,
  normaliseOwnerEmail,
  provisionConnector,
  readbackProvisioning,
} from "./provisioning.js";
import { createSafeWriter, createSecretGuard } from "./secretGuard.js";

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  REFUSED: 3,
  FAILED: 4,
  NEEDS_ATTENTION: 5,
});

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const USAGE = `Bibi Workspace connector operations

  node connector/ops.js provision --owner-email <email> --node-label <label> [options]
  node connector/ops.js readback  --owner-email <email> --node-label <label> [options]
  node connector/ops.js launchagent render   --node-label <label> [options]
  node connector/ops.js launchagent install  --node-label <label> [options]
  node connector/ops.js launchagent inspect  [--label <launchd label>]
  node connector/ops.js launchagent uninstall [--label <launchd label>]

Common options
  --dry-run                 Validate and render only. No Keychain, no Supabase,
                            no launchctl, no file under ~/Library.
  --json                    Emit the report as JSON.

provision
  --password-fd <n>         Read the owner password from an inherited file
                            descriptor. Default 0 (stdin). There is no
                            --password flag, on purpose.
launchagent
  --control-plane-url <url> Defaults to BIBI_CONTROL_PLANE_URL.
  --allow-local-execution   Set BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION=true.
  --hermes-bin <path>       Defaults to BIBI_HERMES_BIN, else
                            ~/.hermes/hermes-agent/venv/bin/hermes.
  --hermes-home <path>      Defaults to BIBI_HERMES_DEFAULT_HOME, else ~/.hermes.
  --hermes-profiles <path>  Defaults to BIBI_HERMES_PROFILES_ROOT, else
                            ~/.hermes/profiles.
  --label <launchd label>   Defaults to com.bibi.workspace.connector.
  --node-bin <path>         Node binary launchd runs. Defaults to the one
                            running this command.
  --throttle-seconds <n>    launchd ThrottleInterval. Default 30.
  --force                   Re-install over an existing plist.

Environment (never passed as arguments)
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required by provision and readback
`;

const FLAGS = new Set(["--dry-run", "--json", "--allow-local-execution", "--force", "--help", "-h"]);
const VALUES = new Set([
  "--owner-email",
  "--node-label",
  "--password-fd",
  "--control-plane-url",
  "--hermes-bin",
  "--hermes-home",
  "--hermes-profiles",
  "--label",
  "--node-bin",
  "--throttle-seconds",
]);

/** A secret in argv is a secret in the shell history. Named, so the refusal explains itself. */
const REFUSED_OPTIONS = new Map([
  ["--password", "비밀번호는 인자로 받지 않습니다. stdin 또는 --password-fd를 사용하세요."],
  ["--service-role-key", "서비스 롤 키는 인자로 받지 않습니다. SUPABASE_SERVICE_ROLE_KEY 환경변수를 사용하세요."],
  ["--token", "커넥터 토큰은 인자로 받지 않습니다. provision이 생성해 Keychain에 저장합니다."],
]);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArguments(argv = []) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name] = argument.split("=", 1);

    if (REFUSED_OPTIONS.has(name)) throw new UsageError(REFUSED_OPTIONS.get(name));

    if (FLAGS.has(argument)) {
      options[argument.replace(/^--?/, "")] = true;
      continue;
    }
    if (VALUES.has(name)) {
      const inline = argument.includes("=") ? argument.slice(name.length + 1) : null;
      const value = inline ?? argv[++index];
      if (value === undefined) throw new UsageError(`${name}에 값이 필요합니다.`);
      options[name.replace(/^--/, "")] = value;
      continue;
    }
    if (argument.startsWith("-")) throw new UsageError(`알 수 없는 옵션입니다: ${argument}`);
    positional.push(argument);
  }

  return {
    command: positional[0] ?? "",
    subcommand: positional[1] ?? "",
    extra: positional.slice(2),
    options,
  };
}

/**
 * Read a secret from an inherited descriptor. `readFileSync` on a numeric fd
 * consumes a pipe as well as a file, so `--password-fd 3` and a here-string on
 * stdin both work without the secret ever being an argument.
 */
export function readSecretFromDescriptor(fd, { readFile = readFileSync, isTTY = null } = {}) {
  const descriptor = Number(fd);
  if (!Number.isInteger(descriptor) || descriptor < 0) {
    throw new UsageError(`--password-fd는 0 이상의 정수여야 합니다: ${fd}`);
  }
  if (descriptor === 0 && isTTY === true) {
    throw new UsageError("이 명령은 대화형으로 입력받지 않습니다. 비밀번호를 파이프로 넣거나 --password-fd를 쓰세요.");
  }
  let raw;
  try {
    raw = readFile(descriptor, "utf8");
  } catch {
    throw new UsageError(`파일 서술자 ${descriptor}에서 비밀번호를 읽지 못했습니다.`);
  }
  // Exactly one trailing newline is stripped — the one a here-string or `echo`
  // adds. Anything else is part of what the owner chose.
  return String(raw).replace(/\r?\n$/, "");
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name}이(가) 필요합니다.`);
  return value.trim();
}

function launchAgentInput(options, env) {
  const hermes = defaultHermesSettings(env);
  const nodeLabel = normaliseNodeLabel(requireOption(options, "node-label"));
  return {
    nodeLabel,
    label: options.label,
    controlPlaneUrl: options["control-plane-url"] || env.BIBI_CONTROL_PLANE_URL,
    repoRoot: PROJECT_ROOT,
    nodeBin: options["node-bin"] || process.execPath,
    hermesBin: options["hermes-bin"] || hermes.hermesBin,
    hermesDefaultHome: options["hermes-home"] || hermes.hermesDefaultHome,
    hermesProfilesRoot: options["hermes-profiles"] || hermes.hermesProfilesRoot,
    keychainService: KEYCHAIN_SERVICES.connectorToken,
    keychainAccount: nodeLabel,
    allowLocalExecution: options["allow-local-execution"] === true,
    ...(options["throttle-seconds"] ? { throttleSeconds: Number(options["throttle-seconds"]) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandProvision({ options, env, writer, guard, dryRun, createAdmin, makeKeychain }) {
  const ownerEmail = normaliseOwnerEmail(requireOption(options, "owner-email"));
  const nodeLabel = normaliseNodeLabel(requireOption(options, "node-label"));
  const coordinates = keychainCoordinates({ ownerEmail, nodeLabel });

  if (dryRun) {
    // Nothing is read from a descriptor either: a dry run must not consume the
    // owner's password just to tell them the plan.
    writer.report({
      status: "dry-run",
      wouldCreate: ["authUser", "connectorNode", "connectorCredential", "keychainToken", "keychainPassword"],
      ownerEmail,
      nodeLabel,
      keychain: coordinates,
      passwordSource: options["password-fd"] ? `fd ${options["password-fd"]}` : "stdin (fd 0)",
      supabaseUrl: env.SUPABASE_URL ? "present" : "absent",
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ? "present" : "absent",
      touched: [],
    });
    return EXIT.OK;
  }

  const password = guard.register(
    readSecretFromDescriptor(options["password-fd"] ?? 0, { isTTY: process.stdin.isTTY === true }),
  );
  const check = validateNewPassword({ password, confirm: password, email: ownerEmail });
  if (!check.valid) {
    // Codes only. The messages are safe, but the codes are what a script acts on.
    throw new UsageError(`비밀번호가 정책을 통과하지 못했습니다: ${check.problems.map((p) => p.code).join(", ")}`);
  }

  const admin = await createAdmin(env, guard);
  const keychain = makeKeychain({ dryRun: false });
  const report = await provisionConnector({ admin, keychain, guard, ownerEmail, nodeLabel, password });
  writer.report(report);
  return EXIT.OK;
}

async function commandReadback({ options, env, writer, guard, dryRun, createAdmin, makeKeychain }) {
  const ownerEmail = normaliseOwnerEmail(requireOption(options, "owner-email"));
  const nodeLabel = normaliseNodeLabel(requireOption(options, "node-label"));

  if (dryRun) {
    writer.report({
      status: "dry-run",
      wouldRead: ["authUser", "connectorNode", "connectorCredential", "keychainToken", "keychainPassword"],
      ownerEmail,
      nodeLabel,
      keychain: keychainCoordinates({ ownerEmail, nodeLabel }),
      touched: [],
    });
    return EXIT.OK;
  }

  const admin = await createAdmin(env, guard);
  const keychain = makeKeychain({ dryRun: false });
  writer.report(await readbackProvisioning({ admin, keychain, ownerEmail, nodeLabel }));
  return EXIT.OK;
}

async function commandLaunchAgent({ subcommand, options, env, writer, dryRun, makeLaunchAgentManager }) {
  const manager = makeLaunchAgentManager({ dryRun });

  if (subcommand === "render") {
    const rendered = renderLaunchAgent(launchAgentInput(options, env));
    // Emitted verbatim: these are the exact bytes `install` would write, and
    // reviewing them is the entire purpose of `render`.
    writer.line(`# ${rendered.settings.plistPath}`);
    writer.artifact(rendered.plist);
    writer.line(`# ${rendered.settings.wrapperPath}`);
    writer.artifact(rendered.wrapper);
    return EXIT.OK;
  }

  if (subcommand === "install") {
    const result = await manager.install(launchAgentInput(options, env), { force: options.force === true });
    writer.report({
      status: result.dryRun ? "dry-run" : "installed",
      label: result.settings.label,
      plistPath: result.settings.plistPath,
      wrapperPath: result.settings.wrapperPath,
      stdoutPath: result.settings.stdoutPath,
      stderrPath: result.settings.stderrPath,
      keychain: { service: result.settings.keychainService, account: result.settings.keychainAccount },
      wrote: result.wrote,
      launchctl: result.launchctl,
      touched: result.dryRun ? [] : result.wrote,
    });
    return EXIT.OK;
  }

  if (subcommand === "inspect") {
    // Inspect needs a label, not a full render, so the node-specific settings
    // fall back to placeholders that only have to pass validation.
    writer.report(await manager.inspect(inspectionInput(options, env)));
    return EXIT.OK;
  }

  if (subcommand === "uninstall") {
    const result = await manager.uninstall(inspectionInput(options, env));
    writer.report({
      status: result.dryRun ? "dry-run" : "uninstalled",
      label: result.label,
      booted: result.booted ?? false,
      removed: result.removed,
      keptLogs: result.keptLogs ?? [],
      keychain: "untouched",
    });
    return EXIT.OK;
  }

  throw new UsageError(`알 수 없는 launchagent 하위 명령입니다: ${subcommand || "(없음)"}`);
}

/**
 * `inspect` and `uninstall` identify a job by its launchd label alone. The rest
 * of the settings still have to resolve, so they take safe local defaults
 * rather than becoming required arguments for a read.
 */
function inspectionInput(options, env) {
  const hermes = defaultHermesSettings(env);
  return {
    nodeLabel: options["node-label"] || "local-mac",
    label: options.label,
    controlPlaneUrl: options["control-plane-url"] || env.BIBI_CONTROL_PLANE_URL || "https://127.0.0.1",
    repoRoot: PROJECT_ROOT,
    nodeBin: options["node-bin"] || process.execPath,
    hermesBin: options["hermes-bin"] || hermes.hermesBin,
    hermesDefaultHome: options["hermes-home"] || hermes.hermesDefaultHome,
    hermesProfilesRoot: options["hermes-profiles"] || hermes.hermesProfilesRoot,
    keychainService: KEYCHAIN_SERVICES.connectorToken,
    keychainAccount: options["node-label"] || "local-mac",
  };
}

/**
 * Built lazily and only on a live path, so a dry run never even loads the
 * Supabase client. The service key is registered with the guard the moment it
 * is read and is not returned.
 */
async function defaultCreateAdmin(env, guard) {
  const { loadServerEnv } = await import("../api/_lib/serverEnv.js");
  const { createServiceRoleClient } = await import("../api/_lib/store.js");
  const { supabaseServiceRoleKey } = loadServerEnv(env);
  guard.register(supabaseServiceRoleKey);
  return createSupabaseAdmin(createServiceRoleClient(env));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runOps({
  argv = [],
  env = process.env,
  write,
  writeError,
  createAdmin = defaultCreateAdmin,
  makeKeychain = createKeychain,
  makeLaunchAgentManager = createLaunchAgentManager,
} = {}) {
  const guard = createSecretGuard();
  const emitError = typeof writeError === "function" ? writeError : (line) => process.stderr.write(line);
  let writer = createSafeWriter({ guard, write });

  try {
    const parsed = parseArguments(argv);
    const dryRun = parsed.options["dry-run"] === true;
    writer = createSafeWriter({ guard, write, json: parsed.options.json === true });

    if (!parsed.command || parsed.options.help === true || parsed.options.h === true) {
      writer.line(USAGE);
      return parsed.command ? EXIT.OK : EXIT.USAGE;
    }

    const context = { ...parsed, env, writer, guard, dryRun, createAdmin, makeKeychain, makeLaunchAgentManager };
    if (parsed.command === "provision") return await commandProvision(context);
    if (parsed.command === "readback") return await commandReadback(context);
    if (parsed.command === "launchagent") return await commandLaunchAgent(context);
    throw new UsageError(`알 수 없는 명령입니다: ${parsed.command}`);
  } catch (error) {
    // The guard scrubs the message: an error raised deep inside a dependency
    // can quote the value that caused it.
    const message = guard.scrub(String(error?.message ?? error));
    emitError(`${message}\n`);

    if (error instanceof UsageError) return EXIT.USAGE;
    if (error?.code === "PARTIAL_STATE") {
      writer.report(error.detail?.state ?? { status: "refused" });
      return EXIT.REFUSED;
    }
    if (error?.code === "ALREADY_INSTALLED") return EXIT.REFUSED;
    if (error?.code === "PROVISION_FAILED_ROLLBACK_INCOMPLETE") {
      writer.report({ status: "rollback-incomplete", rollback: error.detail?.rollback ?? null });
      return EXIT.NEEDS_ATTENTION;
    }
    if (error instanceof ProvisioningError && error.code === "PROVISION_FAILED_ROLLED_BACK") {
      writer.report({ status: "rolled-back", rollback: error.detail?.rollback ?? null });
      return EXIT.FAILED;
    }
    return EXIT.FAILED;
  }
}

// Only when invoked directly, so the tests can import this module safely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runOps({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
