/**
 * The boundary between the connector and the Hermes install on this Mac.
 *
 * Hermes is driven as a subprocess, not over HTTP. The verified contract is:
 *
 *     hermes chat -q <PROMPT> -Q --source tool --max-turns <N>
 *
 * and a profile is selected **only** by the child's `HERMES_HOME`. There is no
 * `--profile` flag; setting the environment variable is the entire mechanism.
 * CEO비비 (role slot bibi-01) runs from the default home `~/.hermes`; every
 * specialist runs from `<profilesRoot>/<id>`.
 *
 * Safety properties this module is responsible for:
 *
 *  - `execFile` with an argv array and no shell, so a prompt containing shell
 *    metacharacters is data rather than syntax.
 *  - A minimal child environment. `process.env` is *not* forwarded, because it
 *    holds the connector token and the cloud configuration.
 *  - Profile ids matched exactly against the roster, so no path can be
 *    traversed and the rollback `profiles/bibi-01` directory can never be run.
 *  - Bounded output, a timeout with a kill, and redaction of anything the CLI
 *    prints before it becomes a result or evidence.
 *  - Nothing inside a profile directory is ever opened. The only filesystem
 *    access is a `stat` on the home directory to see whether it exists.
 */

import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { EXECUTION_PROFILE_IDS, isExecutionProfileId } from "../src/bibi/roster.js";
import { buildEvidence, redactSecrets } from "./evidence.js";
import { createSqliteSessionVerifier, isSafeHermesSessionId } from "./sessionBinding.js";

export class LocalExecutionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LocalExecutionError";
    this.code = code;
  }
}

/**
 * Environment variables the child is allowed to inherit. Everything else is
 * dropped, which is what keeps `BIBI_CONNECTOR_TOKEN` and the Supabase
 * configuration out of a process the user's own tooling can inspect.
 */
const INHERITED_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "USER", "SHLVL"];

export function createDurableExecutionLedger(filePath) {
  const lockPath = `${filePath}.lock`;

  async function readEntries() {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new LocalExecutionError("BLOCKED: durable execution ledger is unreadable.", "BLOCKED_EXECUTION_LEDGER_UNREADABLE");
    }
  }

  async function mutate(mutator) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      throw new LocalExecutionError("BLOCKED: durable execution ledger is locked.", "BLOCKED_EXECUTION_LEDGER_LOCKED");
    }
    try {
      const entries = await readEntries();
      const value = mutator(entries);
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(entries), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, filePath);
      return value;
    } finally {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }

  return {
    async begin(key) {
      return mutate((entries) => {
        if (entries[key]) return { existing: true, ...entries[key] };
        entries[key] = { state: "executing", updatedAt: new Date().toISOString() };
        return { existing: false, ...entries[key] };
      });
    },
    async complete(key, result) {
      return mutate((entries) => {
        entries[key] = { state: "completed", result, updatedAt: new Date().toISOString() };
      });
    },
    async fail(key, error) {
      return mutate((entries) => {
        entries[key] = {
          state: "failed",
          error: { code: String(error?.code ?? "EXECUTION_FAILED"), message: redactSecrets(error?.message ?? String(error)) },
          updatedAt: new Date().toISOString(),
        };
      });
    },
  };
}

export function buildPrompt(command) {
  const title = String(command?.title ?? "").trim();
  const brief = String(command?.brief ?? "").trim();

  // A chat turn is the user's message verbatim; its title is only a board label
  // and repeating it would put a truncated copy in front of the real question.
  const prompt = command?.kind === "chat"
    ? (brief || title)
    : [title, brief].filter(Boolean).join("\n\n");

  if (!prompt) throw new LocalExecutionError("실행할 지시문이 비어 있습니다.", "EMPTY_PROMPT");
  return prompt;
}

/**
 * Resolve the `HERMES_HOME` for a physical profile. The identifier is matched
 * against the roster rather than sanitised, so traversal is impossible by
 * construction and `bibi-01` is refused even though the directory exists.
 */
export function homeForExecutionProfile(executionProfileId, config) {
  if (!isExecutionProfileId(executionProfileId)) {
    throw new LocalExecutionError(
      `'${executionProfileId}'은(는) 실행 가능한 물리 프로필이 아닙니다.`,
      "INVALID_EXECUTION_PROFILE",
    );
  }
  if (executionProfileId === "default") return config.hermesDefaultHome;
  return path.join(config.hermesProfilesRoot, executionProfileId);
}

function classifyFailure(error, timeoutMs) {
  // execFile reports a timeout as a kill, not as a distinct error code.
  if (error.killed || error.signal === "SIGKILL" || error.code === "ETIMEDOUT") {
    return new LocalExecutionError(
      `로컬 Hermes 실행이 ${timeoutMs}ms 안에 끝나지 않아 중단했습니다.`,
      "EXECUTION_TIMEOUT",
    );
  }
  const detail = redactSecrets(error.stderr || error.message || "").trim().slice(0, 500);
  return new LocalExecutionError(
    `로컬 Hermes 실행이 실패했습니다: ${detail || "알 수 없는 오류"}`,
    "EXECUTION_FAILED",
  );
}

export function createHermesCliExecutor(config, {
  execFileImpl = execFile,
  sessionVerifier = createSqliteSessionVerifier(),
  executionLedger = createDurableExecutionLedger(path.join(config.hermesDefaultHome, "connector-execution-ledger.json")),
} = {}) {
  function run(args, home) {
    return new Promise((resolve, reject) => {
      execFileImpl(
        config.hermesBin,
        args,
        {
          // Profile selection lives entirely in this one variable.
          env: { ...inheritedEnv(), HERMES_HOME: home },
          timeout: config.hermesTimeoutMs,
          maxBuffer: config.hermesMaxOutputBytes,
          killSignal: "SIGKILL",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) reject(classifyFailure(error, config.hermesTimeoutMs));
          else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
  }

  function inheritedEnv() {
    const env = {};
    for (const key of INHERITED_ENV_KEYS) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
  }

  return {
    /**
     * The physical profiles that both belong to the roster and actually have a
     * home directory on this Mac. A profile whose directory is absent is not
     * reported, so the workspace shows it as OFFLINE rather than claiming it.
     */
    async listProfileIds() {
      const checks = await Promise.all(EXECUTION_PROFILE_IDS.map(async (id) => {
        try {
          const home = homeForExecutionProfile(id, config);
          return (await stat(home)).isDirectory() ? id : null;
        } catch {
          // A missing or unreadable home means "not available", not an error.
          return null;
        }
      }));
      return checks.filter(Boolean);
    },

    async execute(command) {
      const home = homeForExecutionProfile(command.executionProfileId, config);
      const prompt = buildPrompt(command);
      const bound = command.continuationStatus === "bound" || Boolean(command.hermesSessionId);
      let args;
      if (bound) {
        if (!isSafeHermesSessionId(command.hermesSessionId)) {
          throw new LocalExecutionError("BLOCKED: Hermes session id is not safe to resume.", "INVALID_RESUME_SESSION_ID");
        }
        if (!command.resumeLeaseId) {
          throw new LocalExecutionError("BLOCKED: no exclusive cloud resume lease was granted.", "BLOCKED_RESUME_LEASE_MISSING");
        }
        if (!String(command.turnIdempotencyKey ?? "").trim()) {
          throw new LocalExecutionError("BLOCKED: no durable turn idempotency key was granted.", "BLOCKED_TURN_IDEMPOTENCY_KEY_MISSING");
        }
        const verification = await sessionVerifier.verify({
          home,
          hermesSessionId: command.hermesSessionId,
          organizationProfileId: command.profileId,
          executionProfileId: command.executionProfileId,
          channelOrigin: command.channelOrigin,
          bindingId: command.bindingId,
        });
        if (!verification?.ok) {
          const code = String(verification?.code ?? "SESSION_UNVERIFIABLE");
          throw new LocalExecutionError(`BLOCKED: bound Hermes session verification failed (${code}).`, `BLOCKED_${code}`);
        }
        args = [
          "chat", "--resume", command.hermesSessionId, "--no-restore-cwd",
          "-q", prompt, "-Q", "--max-turns", String(config.hermesMaxTurns),
        ];
      } else {
        args = [
          "chat", "-q", prompt, "-Q", "--source", "tool",
          "--max-turns", String(config.hermesMaxTurns),
        ];
      }

      if (config.dryRun) {
        return {
          summary: `모의 실행(dry run): ${command.title}`,
          detail: "커넥터가 모의 실행 모드입니다. 실제 로컬 프로필은 이 업무를 수행하지 않았습니다.",
          evidence: [buildEvidence({
            kind: "command",
            label: "모의 실행 기록",
            content: JSON.stringify({ dryRun: true, args, home, ...identity(command) }, null, 2),
          })],
        };
      }

      const turnKey = bound ? String(command.turnIdempotencyKey) : null;
      if (turnKey) {
        const marker = await executionLedger.begin(turnKey);
        if (marker.existing && marker.state === "completed" && marker.result) return marker.result;
        if (marker.existing && marker.state === "failed") {
          throw new LocalExecutionError("BLOCKED: prior execution failed and must be reconciled.", "BLOCKED_TURN_PREVIOUSLY_FAILED");
        }
        if (marker.existing) {
          throw new LocalExecutionError("BLOCKED: prior execution outcome is unknown; refusing a second resume.", "BLOCKED_TURN_OUTCOME_UNKNOWN");
        }
      }

      let stdout;
      let stderr;
      try {
        ({ stdout, stderr } = await run(args, home));
      } catch (error) {
        if (turnKey) await executionLedger.fail(turnKey, error);
        throw error;
      }
      const summary = redactSecrets(stdout).trim();
      if (!summary) {
        throw new LocalExecutionError(
          "로컬 Hermes가 빈 응답을 반환했습니다.",
          "EMPTY_LOCAL_RESULT",
        );
      }

      const evidence = [
        buildEvidence({
          kind: "command",
          label: "Hermes CLI 실행",
          // The invocation is recorded so the owner can see exactly what ran and
          // against which profile, without having to trust the summary.
          content: JSON.stringify({ args, home, ...identity(command) }, null, 2),
        }),
        buildEvidence({ kind: "log", label: "Hermes CLI 표준 출력", content: stdout }),
      ];
      const errorOutput = redactSecrets(stderr).trim();
      if (errorOutput) {
        evidence.push(buildEvidence({ kind: "log", label: "Hermes CLI 표준 오류", content: stderr }));
      }

      const result = { summary, detail: "", evidence };
      if (turnKey) await executionLedger.complete(turnKey, result);
      return result;
    },
  };
}

function identity(command) {
  return {
    workItemId: command.workItemId,
    // Both identities, so evidence names the assigned role slot and the profile
    // that actually produced the output.
    profileId: command.profileId,
    executionProfileId: command.executionProfileId,
    kind: command.kind ?? "work",
  };
}
