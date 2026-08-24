/**
 * The one place operational tooling is allowed to hold a plaintext secret.
 *
 * Provisioning is the only part of this system that ever handles a connector
 * token, a login password and the Supabase service credential in the same
 * process. That makes its output the most dangerous output in the repository:
 * a single stray `console.log(result)` would put a working credential into a
 * terminal scrollback, a shell history file or a CI log.
 *
 * So the tooling never writes to a stream directly. It writes through a guard
 * that knows every secret the run is holding and removes them from the text
 * first. The guard is deliberately literal — it strips the exact byte sequences
 * it was given, not a guess at what a secret looks like — and then applies the
 * connector's shape-based redaction on top, so a secret it was never told about
 * still has a chance of being caught.
 *
 * A secret is never returned by any function here. What is returned instead is
 * a prefix and a fingerprint: enough to tell two credentials apart in a report,
 * never enough to use one.
 */

import { createHash } from "node:crypto";

import { redactSecrets } from "./evidence.js";

export const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Short strings are not registered. A three-character secret would match half
 * the report — including its own field names — and scrub it into noise, which
 * hides the very state the operator is reading the report to check.
 */
const MIN_REGISTERED_SECRET_LENGTH = 8;

/** Long enough to be unambiguous in a report, short enough to be unusable. */
const FINGERPRINT_LENGTH = 16;

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A SHA-256 prefix over a value. Two runs of the same credential produce the
 * same fingerprint, so an operator can confirm that what is in the Keychain is
 * what is in the database without either side revealing the credential.
 */
export function fingerprint(value) {
  const digest = createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
  return `sha256:${digest.slice(0, FINGERPRINT_LENGTH)}`;
}

/** The first four characters, which is how `connector/config.js` labels a token. */
export function secretPrefix(value) {
  return `${String(value ?? "").slice(0, 4)}…`;
}

export function createSecretGuard() {
  const registered = new Set();

  return {
    /**
     * Hand a secret to the guard and get it back unchanged. Returning the value
     * is what lets a caller register at the point of acquisition —
     * `const token = guard.register(generateToken())` — instead of remembering
     * to do it as a separate statement it can forget.
     */
    register(value) {
      const secret = typeof value === "string" ? value : "";
      if (secret.length >= MIN_REGISTERED_SECRET_LENGTH) registered.add(secret);
      return value;
    },

    get size() {
      return registered.size;
    },

    /** Whether `text` still contains a registered secret. Used by the tests. */
    leaks(text) {
      const value = String(text ?? "");
      for (const secret of registered) {
        if (value.includes(secret)) return true;
      }
      return false;
    },

    /**
     * Remove every registered secret, then apply shape-based redaction. Order
     * matters: the literal pass runs first so a secret that happens not to look
     * like one is still removed.
     */
    scrub(text) {
      let value = String(text ?? "");
      for (const secret of registered) {
        value = value.replace(new RegExp(escapeForRegExp(secret), "g"), REDACTION_PLACEHOLDER);
      }
      return redactSecrets(value);
    },
  };
}

/**
 * A writer that cannot emit a registered secret.
 *
 * Every report line, every error message and every rendered artifact preview
 * goes through here. `write` is injected so tests can capture output instead of
 * asserting against a real stream.
 */
export function createSafeWriter({ guard, write, json = false } = {}) {
  const emit = typeof write === "function" ? write : (line) => process.stdout.write(line);
  const scrub = guard ? (text) => guard.scrub(text) : (text) => redactSecrets(text);

  return {
    line(message) {
      emit(`${scrub(message)}\n`);
    },
    /**
     * A rendered artifact — a plist, a shell script — emitted byte for byte.
     *
     * Shape-based redaction cannot be used here and using it was a real bug:
     * the wrapper script legitimately contains the line
     * `BIBI_CONNECTOR_TOKEN="$(/usr/bin/security ...)"`, and the generic
     * `TOKEN=` rule rewrote it into something that would not run. What protects
     * this path instead is the literal check — if a registered secret is
     * present at all, the artifact is scrubbed and the caller is told, because
     * a secret reaching a rendered file is a defect, not a formatting problem.
     *
     * @returns {boolean} true when the artifact was emitted verbatim.
     */
    artifact(text) {
      const value = String(text ?? "");
      if (guard && guard.leaks(value)) {
        emit(`${scrub(value)}\n`);
        return false;
      }
      emit(value.endsWith("\n") ? value : `${value}\n`);
      return true;
    },

    /**
     * Structured output. Serialised first and scrubbed afterwards, so a secret
     * nested anywhere in the object — including in a key — is removed rather
     * than only the places the caller thought to check.
     */
    report(payload) {
      const serialised = json
        ? JSON.stringify(payload, null, 2)
        : Object.entries(payload)
            .map(([key, value]) => `${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)
            .join("\n");
      emit(`${scrub(serialised)}\n`);
    },
  };
}
