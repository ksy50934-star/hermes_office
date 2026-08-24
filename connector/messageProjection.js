import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { isBibiProfileId, toExecutionProfileId } from "../src/bibi/roster.js";
import { redactSecrets, sha256Hex } from "./evidence.js";

const execFileAsync = promisify(execFile);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const LOCAL_PATHS = [
  /(?:^|[\s"'(])\/(?:Users|home|private|var\/folders)\/[A-Za-z0-9._~+@%/-]+/g,
  /(?:^|[\s"'(])[A-Za-z]:\\(?:[^\s"')]+\\?)+/g,
];

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
  return { ...target, organizationProfileId, executionProfileId, hermesSessionId, checkpoint };
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
    const body = redactProjectionContent(row.content);
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
    const lifecycleState = Number(row.active ?? 1) === 0
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
      const sql = [
        "select id, session_id, role, content, timestamp, active, compacted,",
        "tool_call_id, tool_calls, tool_name",
        "from messages",
        `where session_id = '${target.hermesSessionId}'`,
        `and (id > ${target.checkpoint} or active = 0 or compacted = 1)`,
        "order by id asc;",
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
      return projectMessageRows(rows, target);
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
        return { projected: 0, failed: 1, checkpoint: 0, error: error?.message ?? String(error) };
      }
      let projected = 0;
      let failed = 0;
      let checkpoint = 0;
      for (const rawTarget of targetResponse?.targets ?? []) {
        let target;
        try {
          target = validateProjectionTarget(rawTarget);
          const messages = await reader.readMessages(target);
          checkpoint = Math.max(checkpoint, target.checkpoint);
          if (!messages.length) continue;
          const response = await transport.uploadProjection({ target, messages });
          projected += Number(response?.accepted ?? messages.length);
          checkpoint = Math.max(checkpoint, Number(response?.checkpoint ?? target.checkpoint));
        } catch {
          failed += 1;
        }
      }
      return { projected, failed, checkpoint };
    },
  };
}
