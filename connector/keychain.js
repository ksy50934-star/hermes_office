/**
 * macOS Keychain storage for the two secrets the owner actually has to keep.
 *
 * The database stores only the SHA-256 hash of the connector token, which means
 * the plaintext exists in exactly one place after provisioning: the login
 * keychain of the Mac that runs the connector. The login password is kept
 * beside it for the same reason — the workspace has no registration path, so a
 * forgotten password is a locked-out owner rather than an inconvenience.
 *
 * Three properties matter here and all three are enforced rather than documented:
 *
 *  1. `security` is invoked with an argv array and never through a shell, so a
 *     service name or an account containing shell metacharacters is data.
 *  2. Nothing written to a log, a report or an error goes through the raw
 *     command. `describeCommand` is the only loggable form, and it replaces the
 *     secret argument with a placeholder.
 *  3. Each item's access control list is decided by its service rather than by
 *     its caller, so the connector token is readable by exactly one executable
 *     and the owner's password by none. See `KEYCHAIN_TRUSTED_APPLICATIONS`.
 *
 * One exposure is real and is not hidden: `security add-generic-password` takes
 * the secret as a command-line argument, so for the duration of that call the
 * secret is present in this process's own argv. macOS does not let one user
 * read another user's process arguments, so the window is same-user-or-root;
 * it is still a window, and it is why provisioning is a one-shot command rather
 * than something a wrapper runs on every start.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { REDACTION_PLACEHOLDER } from "./secretGuard.js";

const execFileAsync = promisify(execFile);

/** Absolute so the tool cannot be shadowed by a directory earlier on PATH. */
export const SECURITY_BIN = "/usr/bin/security";

/**
 * The documented, stable naming. Changing either value orphans an existing
 * Keychain item rather than migrating it, so they are frozen and referenced by
 * name everywhere — including inside the rendered LaunchAgent wrapper.
 *
 *   connectorToken  service `com.bibi.workspace.connector-token`
 *                   account <node label>, so several nodes can coexist.
 *   ownerLogin      service `com.bibi.workspace.owner-login`
 *                   account <owner email>.
 */
export const KEYCHAIN_SERVICES = Object.freeze({
  connectorToken: "com.bibi.workspace.connector-token",
  ownerLogin: "com.bibi.workspace.owner-login",
});

export const KEYCHAIN_ITEM_KIND = "Bibi Workspace";

/**
 * Per-service access control, and the reason it is per-service.
 *
 * `security add-generic-password` decides at write time which executables may
 * read the item without an interactive prompt. Three shapes are possible and
 * only one of them is correct here:
 *
 *   -A                  every application on the Mac reads it silently. Never
 *                       used, and asserted against: it would hand the connector
 *                       token to anything that asks.
 *   -T ""               nothing is pre-trusted. Every read raises a GUI prompt,
 *                       which for a LaunchAgent running with no session means
 *                       the read blocks until it times out rather than failing.
 *   -T /usr/bin/security exactly one executable is pre-trusted, and it is the
 *                       one the rendered wrapper actually execs.
 *
 * So the two items are written differently on purpose:
 *
 *   connectorToken  `-T /usr/bin/security`, because the LaunchAgent wrapper has
 *                   to read it noninteractively at every start. This is the
 *                   narrowest grant that makes a headless read possible.
 *   ownerLogin      `-T ""`, because nothing automated ever reads it. It is a
 *                   record for the human, and a prompt on access is the point.
 */
export const KEYCHAIN_TRUSTED_APPLICATIONS = Object.freeze({
  [KEYCHAIN_SERVICES.connectorToken]: Object.freeze([SECURITY_BIN]),
  [KEYCHAIN_SERVICES.ownerLogin]: Object.freeze([]),
});

/**
 * An unknown service gets no trusted application. A new item defaults to the
 * closed grant and has to be added above deliberately, rather than inheriting
 * the connector token's access because it was written by the same code.
 */
export function trustedApplicationsFor(service) {
  return [...(KEYCHAIN_TRUSTED_APPLICATIONS[service] ?? [])];
}

/** `security` exits 44 for "the item is not there", which is an answer. */
const SECURITY_ITEM_NOT_FOUND = 44;

export class KeychainError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "KeychainError";
    this.code = code;
  }
}

/**
 * Written as a code-point scan rather than a regular expression so the control
 * characters it rejects never have to appear in this file.
 */
function hasControlCharacter(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reject anything that could be read as an option rather than a value, or that
 * could not survive a round trip through the Keychain intact. `execFile` makes
 * shell injection impossible, but a leading `-` is still argument injection.
 */
function attribute(value, field) {
  const text = String(value ?? "");
  if (!text.trim()) throw new KeychainError(`${field}이(가) 비어 있습니다.`, "MISSING_ATTRIBUTE");
  if (text.length > 255) throw new KeychainError(`${field}이(가) 너무 깁니다(최대 255자).`, "ATTRIBUTE_TOO_LONG");
  if (hasControlCharacter(text)) {
    throw new KeychainError(`${field}에 제어 문자를 쓸 수 없습니다.`, "ATTRIBUTE_CONTROL_CHARACTER");
  }
  if (text.startsWith("-")) {
    throw new KeychainError(`${field}은(는) '-'로 시작할 수 없습니다. 옵션으로 해석됩니다.`, "ATTRIBUTE_LOOKS_LIKE_OPTION");
  }
  return text;
}

/**
 * A control character in a secret is a transcription accident — a stray newline
 * from a here-doc, a NUL from a badly written pipe — and storing it produces a
 * credential that will never match again. It is refused rather than stored.
 */
function secretValue(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) throw new KeychainError("저장할 비밀 값이 비어 있습니다.", "MISSING_SECRET");
  if (hasControlCharacter(text)) {
    throw new KeychainError("비밀 값에 제어 문자를 쓸 수 없습니다.", "SECRET_CONTROL_CHARACTER");
  }
  return text;
}

/**
 * A trusted application is an absolute path to an executable that will be
 * allowed to read the item without a prompt. It is validated like an attribute
 * and then some: it goes into an ACL, so a relative path (resolved against
 * whatever directory `security` happened to run in) or a value that reads as an
 * option would both widen access in a way that is invisible afterwards.
 */
function trustedApplication(value) {
  const text = String(value ?? "");
  if (!text) throw new KeychainError("신뢰할 애플리케이션 경로가 비어 있습니다.", "MISSING_TRUSTED_APPLICATION");
  if (hasControlCharacter(text)) {
    throw new KeychainError("신뢰할 애플리케이션 경로에 제어 문자를 쓸 수 없습니다.", "TRUSTED_APPLICATION_CONTROL_CHARACTER");
  }
  if (!text.startsWith("/")) {
    throw new KeychainError(
      `신뢰할 애플리케이션은 절대 경로여야 합니다: ${text}`,
      "TRUSTED_APPLICATION_NOT_ABSOLUTE",
    );
  }
  return text;
}

/**
 * `-U` updates in place instead of failing on a duplicate, which is what makes
 * a re-run of provisioning converge rather than half-fail.
 *
 * The `-T` arguments are the item's access control list and are chosen by
 * service, not by caller — see `KEYCHAIN_TRUSTED_APPLICATIONS`. An empty list
 * still emits one `-T ""`, because omitting `-T` entirely is not the closed
 * grant: it falls back to trusting the creating process. `-A` is never emitted
 * and cannot be reached from here; there is no option that produces it.
 */
export function buildAddItemCommand({
  service,
  account,
  secret,
  comment = "",
  trustedApplications = trustedApplicationsFor(service),
} = {}) {
  const args = [
    "add-generic-password",
    "-s", attribute(service, "service"),
    "-a", attribute(account, "account"),
    "-D", KEYCHAIN_ITEM_KIND,
    "-U",
  ];

  const trusted = (Array.isArray(trustedApplications) ? trustedApplications : [])
    .map((value) => trustedApplication(value));
  if (trusted.length === 0) args.push("-T", "");
  else for (const application of trusted) args.push("-T", application);

  if (comment) args.push("-j", attribute(comment, "comment"));
  // Last, and recorded, so `describeCommand` can blank exactly this element.
  const secretArgIndex = args.push("-w", secretValue(secret)) - 1;
  return { file: SECURITY_BIN, args, secretArgIndex, trustedApplications: trusted };
}

export function buildFindItemCommand({ service, account, withSecret = false } = {}) {
  const args = [
    "find-generic-password",
    "-s", attribute(service, "service"),
    "-a", attribute(account, "account"),
  ];
  // `-w` prints the secret on stdout. Only the wrapper script asks for it.
  if (withSecret) args.push("-w");
  return { file: SECURITY_BIN, args, secretArgIndex: -1 };
}

export function buildDeleteItemCommand({ service, account } = {}) {
  return {
    file: SECURITY_BIN,
    args: [
      "delete-generic-password",
      "-s", attribute(service, "service"),
      "-a", attribute(account, "account"),
    ],
    secretArgIndex: -1,
  };
}

/**
 * The only form of a Keychain command that may be printed. The secret argument
 * is replaced positionally, so this does not depend on recognising the shape of
 * whatever value happened to be passed.
 */
export function describeCommand(command) {
  const args = (command?.args ?? []).map((value, index) =>
    index === command.secretArgIndex ? REDACTION_PLACEHOLDER : value,
  );
  return `${command?.file ?? ""} ${args.join(" ")}`.trim();
}

/**
 * @param {object} options
 * @param {(command: {file: string, args: string[]}) => Promise<{stdout: string}>} [options.exec]
 * @param {boolean} [options.dryRun] When true nothing is executed at all — not
 *   even a read — so a dry run can neither prompt for Keychain access nor
 *   reveal whether an item exists.
 */
export function createKeychain({ exec, dryRun = false } = {}) {
  const run = typeof exec === "function"
    ? exec
    : ({ file, args }) => execFileAsync(file, args, { encoding: "utf8" });

  async function attempt(command) {
    try {
      const { stdout = "" } = (await run(command)) ?? {};
      return { ok: true, stdout: String(stdout) };
    } catch (error) {
      const status = Number(error?.code);
      return { ok: false, notFound: status === SECURITY_ITEM_NOT_FOUND, status };
    }
  }

  return {
    dryRun,

    async addItem({ service, account, secret, comment }) {
      const command = buildAddItemCommand({ service, account, secret, comment });
      if (dryRun) return { skipped: true, service, account, command: describeCommand(command) };
      const result = await attempt(command);
      if (!result.ok) {
        throw new KeychainError(
          `Keychain 항목을 저장하지 못했습니다(${service}/${account}).`,
          "KEYCHAIN_WRITE_FAILED",
        );
      }
      return { skipped: false, service, account, command: describeCommand(command) };
    },

    /** Existence only. The secret is never read to answer this. */
    async hasItem({ service, account }) {
      const command = buildFindItemCommand({ service, account, withSecret: false });
      if (dryRun) return { skipped: true, present: null, command: describeCommand(command) };
      const result = await attempt(command);
      if (!result.ok && !result.notFound) {
        throw new KeychainError(
          `Keychain 항목을 조회하지 못했습니다(${service}/${account}).`,
          "KEYCHAIN_READ_FAILED",
        );
      }
      return { skipped: false, present: result.ok, command: describeCommand(command) };
    },

    async deleteItem({ service, account }) {
      const command = buildDeleteItemCommand({ service, account });
      if (dryRun) return { skipped: true, removed: null, command: describeCommand(command) };
      const result = await attempt(command);
      if (!result.ok && !result.notFound) {
        throw new KeychainError(
          `Keychain 항목을 삭제하지 못했습니다(${service}/${account}).`,
          "KEYCHAIN_DELETE_FAILED",
        );
      }
      return { skipped: false, removed: result.ok, command: describeCommand(command) };
    },
  };
}
