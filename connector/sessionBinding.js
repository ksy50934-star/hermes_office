import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { redactSecrets } from "./evidence.js";

const execFileAsync = promisify(execFile);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function isSafeHermesSessionId(value) {
  return SESSION_ID.test(String(value ?? ""));
}

export function createSqliteSessionVerifier({ sqliteBin = "sqlite3", execFileImpl = execFileAsync } = {}) {
  return {
    async verify({ home, hermesSessionId, executionProfileId, channelOrigin }) {
      if (!isSafeHermesSessionId(hermesSessionId)) return { ok: false, code: "INVALID_SESSION_ID" };
      if (channelOrigin !== "telegram") return { ok: false, code: "SESSION_SOURCE_MISMATCH" };
      const dbPath = path.join(home, "state.db");
      const sql = [
        "select id, source, profile_name, expiry_finalized, archived",
        "from sessions",
        `where id = '${hermesSessionId}' limit 1;`,
      ].join(" ");
      let stdout;
      try {
        ({ stdout } = await execFileImpl(sqliteBin, ["-readonly", "-json", dbPath, sql], {
          env: { PATH: process.env.PATH ?? "" },
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        }));
      } catch (error) {
        return { ok: false, code: "SESSION_UNVERIFIABLE", detail: redactSecrets(error?.message ?? String(error)) };
      }
      let rows;
      try {
        rows = String(stdout ?? "").trim() ? JSON.parse(stdout) : [];
      } catch {
        return { ok: false, code: "SESSION_UNVERIFIABLE" };
      }
      const session = rows[0];
      if (!session) return { ok: false, code: "SESSION_NOT_FOUND" };
      if (session.source !== "telegram") return { ok: false, code: "SESSION_SOURCE_MISMATCH" };
      if (Number(session.archived) === 1) return { ok: false, code: "SESSION_ARCHIVED" };
      if (Number(session.expiry_finalized) === 1) return { ok: false, code: "SESSION_EXPIRED" };
      if (session.profile_name && session.profile_name !== executionProfileId) {
        return { ok: false, code: "SESSION_PROFILE_MISMATCH" };
      }
      return { ok: true };
    },
  };
}
