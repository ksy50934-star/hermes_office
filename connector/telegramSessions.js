/**
 * Eligible Telegram session discovery, and the connector-side half of binding
 * verification.
 *
 * Onboarding has to offer the owner something real to connect to. The cloud
 * cannot see the Mac, so the only honest source for "which Telegram threads does
 * this profile actually have" is the profile-local `state.db`, read here and
 * reported outbound over the connector's existing authenticated transport.
 *
 * What is reported is deliberately narrow: a session identifier, how the thread
 * is addressed, whether it is still live, how many messages it holds and when it
 * last moved. No body, no title, no excerpt. Discovery answers "does this thread
 * exist and how do I name it", never "what was said in it" — the projection
 * pipeline is the only thing that moves content, and it only runs for a binding
 * the owner asked for and the connector proved.
 *
 * The schema of `sessions` is not ours to dictate, so the Telegram identity
 * columns are discovered rather than assumed. When none of the candidate columns
 * is present the session is reported with an incomplete identity instead of one
 * invented from the session id — a binding built on a guessed identity would be
 * a lie the whole verification path exists to prevent.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { organizationProfileId } from "./runtimeProjection.js";
import { redactSecrets } from "./evidence.js";
import { isSafeHermesSessionId } from "./sessionBinding.js";

const execFileAsync = promisify(execFile);

/** Columns that, if present, name the Telegram chat this session belongs to. */
export const EXTERNAL_CONVERSATION_COLUMNS = Object.freeze([
  "telegram_chat_id", "chat_id", "source_chat_id", "external_conversation_id",
  "external_id", "source_id", "peer_id",
]);

/** Columns that, if present, name the Telegram account the chat belongs to. */
export const CHANNEL_ACCOUNT_COLUMNS = Object.freeze([
  "telegram_user_id", "telegram_account_id", "channel_account_id",
  "source_account_id", "account_id", "owner_chat_id", "user_id",
]);

/** Everything else discovery is allowed to read out of `sessions`. */
const BASE_COLUMNS = Object.freeze([
  "id", "source", "profile_name", "archived", "expiry_finalized", "created_at", "updated_at",
]);

export class TelegramDiscoveryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TelegramDiscoveryError";
    this.code = code;
  }
}

function sqliteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function identifier(value) {
  // Column names come from `pragma table_info`, but they are still interpolated
  // into SQL, so anything that is not a plain identifier is refused rather than
  // quoted around.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value ?? "")) ? String(value) : null;
}

function pickColumn(available, candidates) {
  for (const candidate of candidates) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}

function toIdentityText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text.length > 200) return null;
  return text;
}

function toEpochMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Hermes stores seconds; anything already in milliseconds stays itself.
    return numeric > 1e11 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turn raw `sessions` rows plus per-session message statistics into the records
 * the control plane stores. Exported so the mapping can be exercised without a
 * database.
 */
export function toEligibleSessions({ rows, stats = [], executionProfileId, accountColumn = null, externalColumn = null }) {
  const statsBySession = new Map(
    (Array.isArray(stats) ? stats : []).map((row) => [String(row.session_id), row]),
  );

  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const hermesSessionId = String(row?.id ?? "");
    if (!isSafeHermesSessionId(hermesSessionId)) return [];
    if (row?.source !== "telegram") return [];
    // A session recorded under another profile's name is that profile's, even
    // when it is sitting in this home directory.
    if (row?.profile_name && row.profile_name !== executionProfileId) return [];

    const stat = statsBySession.get(hermesSessionId) ?? {};
    const lastActivityMs = toEpochMs(stat.last_timestamp ?? row?.updated_at ?? row?.created_at);
    const sessionState = Number(row?.archived ?? 0) === 1
      ? "archived"
      : Number(row?.expiry_finalized ?? 0) === 1
        ? "expired"
        : "active";

    return [{
      hermesSessionId,
      executionProfileId,
      channelAccountId: accountColumn ? toIdentityText(row?.[accountColumn]) : null,
      externalConversationId: externalColumn ? toIdentityText(row?.[externalColumn]) : null,
      sessionState,
      messageCount: Math.max(0, Number.parseInt(stat.message_count ?? 0, 10) || 0),
      lastActivityAt: lastActivityMs === null ? null : new Date(lastActivityMs).toISOString(),
    }];
  }).sort((left, right) => String(right.lastActivityAt ?? "").localeCompare(String(left.lastActivityAt ?? "")));
}

export function createSqliteTelegramSessionReader({
  homeForProfile,
  sqliteBin = "sqlite3",
  execFileImpl = execFileAsync,
} = {}) {
  if (typeof homeForProfile !== "function") {
    throw new TelegramDiscoveryError("homeForProfile is required.", "INVALID_READER");
  }

  async function query(dbPath, sql, maxBuffer = 1024 * 1024) {
    const { stdout } = await execFileImpl(sqliteBin, ["-readonly", "-json", dbPath, sql], {
      env: { PATH: process.env.PATH ?? "" },
      timeout: 15_000,
      maxBuffer,
    });
    const text = String(stdout ?? "").trim();
    if (!text) return [];
    return JSON.parse(text);
  }

  return {
    /**
     * @returns {Promise<{sessions: object[], error: string|null, identityColumns: object}>}
     *   `error` is a stable code the UI can explain, never a raw path or a
     *   sqlite message that might carry one.
     */
    async listSessions(executionProfileId) {
      const dbPath = path.join(homeForProfile(executionProfileId), "state.db");

      let columns;
      try {
        columns = await query(dbPath, "pragma table_info(sessions);");
      } catch (error) {
        return {
          sessions: [],
          error: "STATE_DB_UNREADABLE",
          detail: redactSecrets(error?.message ?? String(error)).slice(0, 300),
          identityColumns: { accountColumn: null, externalColumn: null },
        };
      }

      const available = new Set(
        (Array.isArray(columns) ? columns : []).map((column) => identifier(column?.name)).filter(Boolean),
      );
      if (!available.has("id") || !available.has("source")) {
        return {
          sessions: [],
          error: "SESSIONS_TABLE_UNSUPPORTED",
          identityColumns: { accountColumn: null, externalColumn: null },
        };
      }

      const accountColumn = pickColumn(available, CHANNEL_ACCOUNT_COLUMNS);
      const externalColumn = pickColumn(available, EXTERNAL_CONVERSATION_COLUMNS);
      const selected = [...BASE_COLUMNS, accountColumn, externalColumn]
        .filter((column) => column && available.has(column));

      let rows;
      try {
        rows = await query(
          dbPath,
          `select ${selected.join(", ")} from sessions where source = 'telegram' order by id limit 200;`,
        );
      } catch (error) {
        return {
          sessions: [],
          error: "STATE_DB_UNREADABLE",
          detail: redactSecrets(error?.message ?? String(error)).slice(0, 300),
          identityColumns: { accountColumn, externalColumn },
        };
      }

      const ids = (Array.isArray(rows) ? rows : [])
        .map((row) => String(row?.id ?? ""))
        .filter(isSafeHermesSessionId);

      // Counts and timestamps only. This query never selects `content`.
      let stats = [];
      if (ids.length) {
        try {
          stats = await query(
            dbPath,
            "select session_id, count(*) as message_count, max(timestamp) as last_timestamp from messages"
            + ` where session_id in (${ids.map(sqliteLiteral).join(", ")}) and active = 1`
            + " group by session_id;",
          );
        } catch {
          // Statistics are decoration. A session that exists is still offerable
          // without them, so this is not an error the owner needs to see.
          stats = [];
        }
      }

      const sessions = toEligibleSessions({ rows, stats, executionProfileId, accountColumn, externalColumn });
      const error = !accountColumn || !externalColumn
        ? "TELEGRAM_IDENTITY_COLUMNS_MISSING"
        : null;
      return { sessions, error, identityColumns: { accountColumn, externalColumn } };
    },
  };
}

/**
 * Report the eligible sessions of every profile this Mac actually has.
 *
 * A scan that failed is uploaded too, with its reason code and no sessions, so
 * the workspace can say "discovery did not work" instead of silently showing an
 * empty picker that looks like "you have no Telegram threads".
 */
export function createTelegramSessionDiscoveryRunner({
  transport,
  reader,
  listProfileIds,
  intervalMs = 120_000,
  now = () => Date.now(),
  uploadAttempts = 3,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!transport || !reader || typeof listProfileIds !== "function") {
    throw new TelegramDiscoveryError("transport, reader and listProfileIds are required.", "INVALID_RUNNER");
  }
  let lastRunAt = 0;
  return {
    async runOnce({ force = false } = {}) {
      if (!force && now() - lastRunAt < intervalMs) return { skipped: true, scanned: 0, eligible: 0, failed: 0, errors: [] };
      lastRunAt = now();

      let profileIds;
      try {
        profileIds = await listProfileIds();
      } catch {
        return {
          skipped: false, scanned: 0, eligible: 0, failed: 1,
          errors: [{ code: "PROFILE_ENUMERATION_FAILED" }],
        };
      }

      let scanned = 0;
      let eligible = 0;
      let failed = 0;
      const errors = [];
      for (const executionProfileId of profileIds) {
        const scannedAt = new Date(now()).toISOString();
        let result;
        try {
          result = await reader.listSessions(executionProfileId);
        } catch (error) {
          result = {
            sessions: [],
            error: error instanceof TelegramDiscoveryError ? error.code : "SESSION_DISCOVERY_FAILED",
          };
        }

        const payload = {
          organizationProfileId: organizationProfileId(executionProfileId),
          executionProfileId,
          sessions: result.sessions,
          scanError: result.error,
          scannedAt,
        };
        let uploaded = false;
        for (let attempt = 1; attempt <= Math.max(1, uploadAttempts); attempt += 1) {
          try {
            await transport.uploadTelegramSessions(payload);
            uploaded = true;
            break;
          } catch {
            if (attempt < uploadAttempts) await sleep(250 * (2 ** (attempt - 1)));
          }
        }
        if (!uploaded) {
          failed += 1;
          errors.push({ executionProfileId, code: "DISCOVERY_UPLOAD_FAILED" });
          continue;
        }
        scanned += result.sessions.length;
        eligible += result.sessions.filter(
          (session) => session.channelAccountId && session.externalConversationId,
        ).length;
        if (result.error) {
          failed += 1;
          errors.push({ executionProfileId, code: result.error });
        }
      }
      return { skipped: false, scanned, eligible, failed, errors };
    },
  };
}

/**
 * Codes the connector may report for a verification it refused. Each one is a
 * distinct thing the owner can act on, which is why the reason is a code rather
 * than a rendered sentence: the wording belongs to the UI, the fact belongs
 * here.
 */
export const VERIFICATION_FAILURE = Object.freeze({
  PROFILE_UNAVAILABLE: "PROFILE_UNAVAILABLE",
  DISCOVERY_UNAVAILABLE: "DISCOVERY_UNAVAILABLE",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  IDENTITY_INCOMPLETE: "IDENTITY_INCOMPLETE",
});

/**
 * Prove, or refuse to prove, the pending bindings the control plane is holding.
 *
 * Verification is two independent checks, and both have to pass: the Hermes
 * session must exist in that profile's own `state.db` as a live Telegram
 * session, and the Telegram address the owner asked to bind must be the address
 * that session actually carries. The first without the second would let one
 * Telegram thread be bound under another one's identity.
 */
export function createBindingVerificationRunner({
  transport,
  reader,
  sessionVerifier,
  homeForProfile,
  intervalMs = 15_000,
  now = () => Date.now(),
} = {}) {
  if (!transport || !reader || !sessionVerifier || typeof homeForProfile !== "function") {
    throw new TelegramDiscoveryError(
      "transport, reader, sessionVerifier and homeForProfile are required.",
      "INVALID_RUNNER",
    );
  }
  let lastRunAt = 0;

  return {
    async runOnce({ force = false } = {}) {
      if (!force && now() - lastRunAt < intervalMs) return { skipped: true, verified: 0, refused: 0, failed: 0 };
      lastRunAt = now();

      let pending;
      try {
        pending = (await transport.listPendingBindings())?.bindings ?? [];
      } catch {
        return { skipped: false, verified: 0, refused: 0, failed: 1 };
      }

      let verified = 0;
      let refused = 0;
      let failed = 0;

      const discovered = new Map();
      for (const binding of pending) {
        try {
          if (!discovered.has(binding.executionProfileId)) {
            discovered.set(binding.executionProfileId, await reader.listSessions(binding.executionProfileId));
          }
          const scan = discovered.get(binding.executionProfileId);

          const refuse = async (code, detail) => {
            await transport.reportBindingVerification({
              bindingId: binding.bindingId,
              verified: false,
              code,
              detail: detail ?? null,
            });
            refused += 1;
          };

          if (scan.error === "STATE_DB_UNREADABLE" || scan.error === "SESSIONS_TABLE_UNSUPPORTED") {
            await refuse(VERIFICATION_FAILURE.DISCOVERY_UNAVAILABLE, scan.error);
            continue;
          }

          const session = scan.sessions.find((item) => item.hermesSessionId === binding.hermesSessionId);
          if (!session) {
            await refuse(VERIFICATION_FAILURE.SESSION_NOT_FOUND, null);
            continue;
          }
          if (!session.channelAccountId || !session.externalConversationId) {
            await refuse(VERIFICATION_FAILURE.IDENTITY_INCOMPLETE, scan.error ?? null);
            continue;
          }
          if (session.channelAccountId !== binding.channelAccountId
            || session.externalConversationId !== binding.externalConversationId) {
            await refuse(VERIFICATION_FAILURE.IDENTITY_MISMATCH, null);
            continue;
          }

          const proof = await sessionVerifier.verify({
            home: homeForProfile(binding.executionProfileId),
            hermesSessionId: binding.hermesSessionId,
            executionProfileId: binding.executionProfileId,
            channelOrigin: "telegram",
          });
          if (!proof.ok) {
            await refuse(proof.code ?? VERIFICATION_FAILURE.SESSION_NOT_FOUND, null);
            continue;
          }

          await transport.reportBindingVerification({
            bindingId: binding.bindingId,
            verified: true,
            channelAccountId: session.channelAccountId,
            externalConversationId: session.externalConversationId,
            hermesSessionId: session.hermesSessionId,
            executionProfileId: binding.executionProfileId,
            // Evidence is metadata about the proof, never a message.
            evidence: {
              sessionState: session.sessionState,
              messageCount: session.messageCount,
              lastActivityAt: session.lastActivityAt,
              verifiedVia: "profile-local state.db",
            },
          });
          verified += 1;
        } catch {
          failed += 1;
        }
      }

      return { skipped: false, verified, refused, failed };
    },
  };
}
