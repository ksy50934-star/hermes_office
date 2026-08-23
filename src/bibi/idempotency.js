/**
 * Idempotency primitives shared by the control plane and the local connector.
 *
 * Both hops are at-least-once. The browser retries an intake after a dropped
 * response, and the connector re-polls a command batch after a reconnect. The
 * ledger turns both into exactly-once effects, and it does so by *key*, so a
 * genuine retry (a new attempt number) still gets through.
 */

/**
 * A NUL separator, because it cannot appear in an owner id or a request id.
 * With a printable separator, `("a:b", "c")` and `("a", "b:c")` would collide.
 */
const SEPARATOR = "\u0000";

function requiredPart(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label}가 필요합니다.`);
  return text;
}

export function workIntakeKey({ ownerId, clientRequestId } = {}) {
  return [
    requiredPart(ownerId, "소유자 ID"),
    requiredPart(clientRequestId, "클라이언트 요청 ID"),
  ].join(SEPARATOR);
}

export function commandDedupeKey(command) {
  if (!command || typeof command !== "object") return null;
  const explicit = typeof command.id === "string" ? command.id.trim() : "";
  if (explicit) return explicit;
  const workItemId = typeof command.workItemId === "string" ? command.workItemId.trim() : "";
  const type = typeof command.type === "string" ? command.type.trim() : "";
  const attempt = Number.isInteger(command.attempt) ? command.attempt : null;
  if (!workItemId || !type || attempt === null) return null;
  return [workItemId, type, String(attempt)].join(SEPARATOR);
}

/**
 * A bounded least-recently-used ledger. Bounded because the connector is a
 * long-lived process on a laptop: an unbounded map would grow for the lifetime
 * of the session.
 */
export function createIdempotencyLedger({ maxEntries = 500 } = {}) {
  const entries = new Map();

  function touch(key) {
    const value = entries.get(key);
    entries.delete(key);
    entries.set(key, value);
    return value;
  }

  return {
    get size() {
      return entries.size;
    },
    has(key) {
      return entries.has(key);
    },
    /**
     * Run `factory` for a new key, or replay the stored value for a repeat.
     * A throwing factory records nothing, so a transient failure stays retryable.
     */
    resolve(key, factory) {
      if (entries.has(key)) return { duplicate: true, value: touch(key) };
      const value = factory();
      entries.set(key, value);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      return { duplicate: false, value };
    },
    remember(key, value) {
      return this.resolve(key, () => value);
    },
  };
}

/**
 * Split a delivered command batch into the commands that must run and the ones
 * already handled. Malformed commands are suppressed with a reason instead of
 * being passed through to an executor that cannot validate them.
 */
export function suppressDuplicateCommands(commands, ledger) {
  const accepted = [];
  const suppressed = [];
  const reasons = [];

  for (const command of Array.isArray(commands) ? commands : []) {
    const key = commandDedupeKey(command);
    if (!key) {
      suppressed.push(command);
      reasons.push({ command, reason: "MALFORMED_COMMAND" });
      continue;
    }
    if (ledger.has(key)) {
      suppressed.push(command);
      reasons.push({ command, reason: "ALREADY_DELIVERED", key });
      continue;
    }
    ledger.remember(key, { acceptedAt: null });
    accepted.push(command);
  }

  return { accepted, suppressed, reasons };
}
