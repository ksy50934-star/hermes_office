import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { isBibiProfileId, toExecutionProfileId } from "../src/bibi/roster.js";
import { redactSecrets, sha256Hex } from "./evidence.js";

const execFileAsync = promisify(execFile);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const PROJECTION_BATCH_SIZE = 100;
const LOCAL_PATHS = [
  /(?:^|[\s"'(])\/(?:Users|home|private|var\/folders)\/[A-Za-z0-9._~+@%/-]+/g,
  /(?:^|[\s"'(])[A-Za-z]:\\(?:[^\s"')]+\\?)+/g,
];
const HERMES_COMPACTION_PREFIXES = [
  "[CONTEXT COMPACTION",
  "[CONTEXT SUMMARY]:",
];
const HERMES_INFRASTRUCTURE_PREFIXES = [
  "[Your active task list was preserved across context compression]",
];
const ASYNC_DELEGATION_ENVELOPE = /^\[ASYNC DELEGATION (?:BATCH )?COMPLETE — deleg_[A-Za-z0-9_-]+\]/;
const COMPACTION_END_MARKER = "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---";

export class ProjectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProjectionError";
    this.code = code;
  }
}

export function validateProjectionTarget(target) {
  const organizationProfileId = String(target?.organizationProfileId ?? "");
  const executionProfileId = String(target?.executionProfileId ?? "");
  const expectedExecutionProfile = toExecutionProfileId(organizationProfileId);
  if (!isBibiProfileId(organizationProfileId) || !expectedExecutionProfile) {
    throw new ProjectionError("Unknown organization profile.", "INVALID_ORGANIZATION_PROFILE");
  }
  if (executionProfileId !== expectedExecutionProfile) {
    throw new ProjectionError("Organization/execution profile mismatch.", "PROFILE_MISMATCH");
  }
  if (target?.channel !== "telegram") {
    throw new ProjectionError("Only verified Telegram bindings may be projected.", "UNSUPPORTED_CHANNEL");
  }
  const hermesSessionId = String(target?.hermesSessionId ?? "");
  if (!SESSION_ID.test(hermesSessionId)) {
    throw new ProjectionError("Invalid Hermes session identifier.", "INVALID_SESSION_ID");
  }
  for (const key of ["bindingId", "conversationId"]) {
    if (!String(target?.[key] ?? "").trim()) {
      throw new ProjectionError(`${key} is required.`, "INVALID_TARGET");
    }
  }
  const checkpoint = Number(target?.checkpoint ?? 0);
  if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) {
    throw new ProjectionError("Invalid projection checkpoint.", "INVALID_CHECKPOINT");
  }
  const lifecycleCheckpoint = Number(target?.lifecycleCheckpoint ?? 0);
  const nextLifecycleCheckpoint = Number(target?.nextLifecycleCheckpoint ?? lifecycleCheckpoint);
  if (!Number.isSafeInteger(lifecycleCheckpoint) || lifecycleCheckpoint < 0
    || !Number.isSafeInteger(nextLifecycleCheckpoint) || nextLifecycleCheckpoint < 0) {
    throw new ProjectionError("Invalid lifecycle projection checkpoint.", "INVALID_LIFECYCLE_CHECKPOINT");
  }
  return {
    ...target,
    organizationProfileId,
    executionProfileId,
    hermesSessionId,
    checkpoint,
    lifecycleCheckpoint,
    nextLifecycleCheckpoint,
  };
}

function redactProjectionContent(value) {
  let content = redactSecrets(String(value ?? ""));
  content = content
    .replace(/\b((?:api[_-]?)?(?:key|secret|token|password|credential)\s*[=:]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g, "[redacted]");
  for (const pattern of LOCAL_PATHS) {
    content = content.replace(pattern, (match) => `${match[0] === "/" || /^[A-Za-z]:/.test(match) ? "" : match[0]}[redacted]`);
  }
  return content.trim();
}

function isPlainProjectableMessage(row) {
  return (row?.role === "user" || row?.role === "assistant")
    && !row?.tool_call_id
    && !row?.tool_calls
    && !row?.tool_name
    && typeof row?.content === "string"
    && row.content.trim().length > 0;
}

function normalizeHermesEnvelope(content, displayKind) {
  const value = String(content ?? "").trimStart();
  if (HERMES_COMPACTION_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    const markerIndex = value.indexOf(COMPACTION_END_MARKER);
    const remainder = markerIndex < 0
      ? ""
      : value.slice(markerIndex + COMPACTION_END_MARKER.length).trimStart();
    if (!remainder) return { content: value, envelope: true, infrastructure: true };
    return { ...normalizeHermesEnvelope(remainder, displayKind), envelope: true };
  }
  const infrastructure = displayKind === "hidden"
    || HERMES_INFRASTRUCTURE_PREFIXES.some((prefix) => value.startsWith(prefix))
    || ASYNC_DELEGATION_ENVELOPE.test(value);
  return {
    content: value,
    envelope: infrastructure,
    infrastructure,
  };
}

export function projectMessageRows(rows, rawTarget) {
  const target = validateProjectionTarget(rawTarget);
  const retentionBefore = Date.parse(target.retentionBefore ?? "");
  const ordered = [...(Array.isArray(rows) ? rows : [])]
    .filter(isPlainProjectableMessage)
    .filter((row) => row.session_id === target.hermesSessionId)
    .filter((row) => Number.isSafeInteger(Number(row.id)) && (
      Number(row.id) > target.checkpoint
      || Number(row.active ?? 1) === 0
      || Number(row.compacted ?? 0) === 1
      || normalizeHermesEnvelope(row.content, row.display_kind).envelope
    ))
    .sort((left, right) => Number(left.id) - Number(right.id));

  const seen = new Set();
  const projected = [];
  const usedLinks = new Set();
  let activeCanonicalLink = null;
  for (const row of ordered) {
    const sourceMessageId = Number(row.id);
    if (seen.has(sourceMessageId)) continue;
    seen.add(sourceMessageId);
    const normalizedEnvelope = normalizeHermesEnvelope(row.content, row.display_kind);
    const body = redactProjectionContent(normalizedEnvelope.content);
    if (!body) continue;
    if (row.role === "user") {
      const bodySha256 = sha256Hex(body);
      activeCanonicalLink = (target.canonicalLinks ?? []).find((link) => (
        !usedLinks.has(link.workItemId) && link.bodySha256 === bodySha256
      )) ?? null;
      if (activeCanonicalLink) usedLinks.add(activeCanonicalLink.workItemId);
    }
    const seconds = Number(row.timestamp);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const sourceTimestamp = new Date(seconds * 1000).toISOString();
    const lifecycleState = Number(row.active ?? 1) === 0 || normalizedEnvelope.infrastructure
      ? "deleted"
      : Number(row.compacted ?? 0) === 1
        ? "archived"
        : Number.isFinite(retentionBefore) && seconds * 1000 < retentionBefore
          ? "retention"
          : "active";
    const visibleBody = lifecycleState === "active" ? body : "";
    const canonicalMessageKey = activeCanonicalLink
      ? (row.role === "user"
          ? `web:${activeCanonicalLink.requestMessageId}`
          : `assistant:${activeCanonicalLink.workItemId}`)
      : `telegram:${target.executionProfileId}:${target.hermesSessionId}:${sourceMessageId}`;
    projected.push({
      bindingId: target.bindingId,
      conversationId: target.conversationId,
      organizationProfileId: target.organizationProfileId,
      executionProfileId: target.executionProfileId,
      hermesSessionId: target.hermesSessionId,
      channel: target.channel,
      originChannel: activeCanonicalLink ? "web" : "telegram",
      canonicalMessageKey,
      canonicalTurnId: activeCanonicalLink?.workItemId ?? null,
      lifecycleState,
      sourceMessageId,
      sourceSequence: sourceMessageId,
      sourceTimestamp,
      role: row.role,
      body: visibleBody,
      contentSha256: sha256Hex(visibleBody),
    });
  }
  return projected;
}

export function createSqliteProjectionReader({ homeForProfile, sqliteBin = "sqlite3", execFileImpl = execFileAsync } = {}) {
  if (typeof homeForProfile !== "function") throw new ProjectionError("homeForProfile is required.", "INVALID_READER");
  return {
    async readMessages(rawTarget) {
      const target = validateProjectionTarget(rawTarget);
      const home = homeForProfile(target.executionProfileId);
      const dbPath = path.join(home, "state.db");
      const lifecycleCheckpoint = target.lifecycleCheckpoint;
      const lifecycleEligibility = [
        "active = 0",
        "compacted = 1",
        "ltrim(content) like '[CONTEXT COMPACTION%'",
        "ltrim(content) like '[CONTEXT SUMMARY]:%'",
        "ltrim(content) like '[Your active task list was preserved across context compression]%'",
        "ltrim(content) like '[ASYNC DELEGATION BATCH COMPLETE — deleg%'",
        "ltrim(content) like '[ASYNC DELEGATION COMPLETE — deleg%'",
        "display_kind = 'hidden'",
      ].join(" or ");
      const sql = [
        "select id, session_id, role, content, timestamp, active, compacted,",
        "tool_call_id, tool_calls, tool_name, display_kind",
        "from messages",
        `where session_id = '${target.hermesSessionId}'`,
        "and role in ('user', 'assistant')",
        "and tool_call_id is null and tool_calls is null and tool_name is null",
        "and typeof(content) = 'text' and length(trim(content)) > 0",
        `and (id > ${target.checkpoint} or ((${lifecycleEligibility}) and id <= ${target.checkpoint}))`,
        "order by case",
        `when id > ${target.checkpoint} then 0`,
        `when id > ${lifecycleCheckpoint} then 1`,
        "else 2 end, id asc",
        `limit ${PROJECTION_BATCH_SIZE};`,
      ].join(" ");
      let stdout;
      try {
        ({ stdout } = await execFileImpl(sqliteBin, ["-readonly", "-json", dbPath, sql], {
          env: { PATH: process.env.PATH ?? "" },
          maxBuffer: 2 * 1024 * 1024,
          timeout: 15_000,
        }));
      } catch (error) {
        throw new ProjectionError(`Unable to read committed Hermes messages: ${redactSecrets(error?.message ?? String(error))}`, "STATE_DB_READ_FAILED");
      }
      let rows;
      try {
        rows = String(stdout ?? "").trim() ? JSON.parse(stdout) : [];
      } catch {
        throw new ProjectionError("Hermes state query returned invalid JSON.", "STATE_DB_INVALID_JSON");
      }
      const lifecycleRows = rows.filter((row) => Number(row.id) <= target.checkpoint);
      return {
        messages: projectMessageRows(rows, target),
        nextLifecycleCheckpoint: lifecycleRows.length
          ? Number(lifecycleRows.at(-1).id)
          : target.lifecycleCheckpoint,
      };
    },
  };
}

export function createProjectionRunner({ transport, reader } = {}) {
  if (!transport || !reader) throw new ProjectionError("transport and reader are required.", "INVALID_RUNNER");
  return {
    async runOnce() {
      let targetResponse;
      try {
        targetResponse = await transport.listProjectionTargets();
      } catch (error) {
        return {
          projected: 0,
          failed: 1,
          checkpoint: 0,
          errors: [{ code: error?.code ?? "TARGET_LIST_FAILED" }],
        };
      }
      let projected = 0;
      let failed = 0;
      let checkpoint = 0;
      const errors = [];
      for (const rawTarget of targetResponse?.targets ?? []) {
        let target;
        try {
          target = validateProjectionTarget(rawTarget);
          const batch = await reader.readMessages(target);
          const messages = Array.isArray(batch) ? batch : batch.messages;
          const nextLifecycleCheckpoint = Array.isArray(batch)
            ? target.lifecycleCheckpoint
            : Number(batch.nextLifecycleCheckpoint ?? target.lifecycleCheckpoint);
          checkpoint = Math.max(checkpoint, target.checkpoint);
          if (!messages.length) continue;
          const response = await transport.uploadProjection({
            target: { ...target, nextLifecycleCheckpoint },
            messages,
          });
          projected += Number(response?.accepted ?? messages.length);
          checkpoint = Math.max(checkpoint, Number(response?.checkpoint ?? target.checkpoint));
        } catch (error) {
          failed += 1;
          errors.push({
            bindingId: String(rawTarget?.bindingId ?? "").slice(-8),
            code: error?.code ?? "PROJECTION_TARGET_FAILED",
          });
        }
      }
      return { projected, failed, checkpoint, errors };
    },
  };
}
