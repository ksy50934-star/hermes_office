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
import { stat } from "node:fs/promises";
import path from "node:path";

import { EXECUTION_PROFILE_IDS, isExecutionProfileId } from "../src/bibi/roster.js";
import { buildEvidence, redactSecrets } from "./evidence.js";

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

export function createHermesCliExecutor(config, { execFileImpl = execFile } = {}) {
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
      const args = [
        "chat",
        "-q",
        prompt,
        "-Q",
        "--source",
        "tool",
        "--max-turns",
        String(config.hermesMaxTurns),
      ];

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

      const { stdout, stderr } = await run(args, home);
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

      return { summary, detail: "", evidence };
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
