import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createSqliteTelegramSessionReader,
  createTelegramSessionDiscoveryRunner,
  TelegramDiscoveryError,
} from "../connector/telegramSessions.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Telegram discovery allows WAL coordination while every SQLite query stays query-only", async () => {
  const invocations = [];
  const reader = createSqliteTelegramSessionReader({
    homeForProfile: () => "/safe/default",
    execFileImpl: async (binary, args, options) => {
      invocations.push({ binary, args, options });
      if (args.at(-1).includes("table_info")) {
        return { stdout: JSON.stringify([{ name: "id" }, { name: "source" }]) };
      }
      return { stdout: "[]" };
    },
  });

  const result = await reader.listSessions("default");
  assert.equal(result.error, "TELEGRAM_IDENTITY_COLUMNS_MISSING");
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    const sql = invocation.args.at(-1);
    assert.equal(invocation.binary, "sqlite3");
    assert.deepEqual(invocation.args.slice(0, 3), ["-json", "/safe/default/state.db", sql]);
    assert.doesNotMatch(invocation.args.join(" "), /-readonly/);
    assert.match(sql, /^pragma query_only = on;/i);
  }
});

test("conversation archive uses the same canonical web plus Telegram projection", async () => {
  const source = await read("src/cloud/workspaceClient.js");
  const archive = source.slice(source.indexOf("export async function loadConversationArchive"), source.indexOf("export async function loadDataRoomArtifacts"));
  assert.match(archive, /from\("projected_messages"\)/);
  assert.match(archive, /mergeConversationMessages\(messageRows, projectedRows, \{ conversationId: conversation\.id \}\)/);
  assert.match(archive, /last_message_at: latest/);
});

test("a profile read failure is durably uploaded with a structured reason", async () => {
  const uploads = [];
  const runner = createTelegramSessionDiscoveryRunner({
    listProfileIds: async () => ["bibi-02"],
    reader: { listSessions: async () => { throw new TelegramDiscoveryError("unreadable", "STATE_DB_UNREADABLE"); } },
    transport: { uploadTelegramSessions: async (payload) => uploads.push(payload) },
    now: () => 1_000_000,
    sleep: async () => {},
  });
  const result = await runner.runOnce({ force: true });
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].sessions, []);
  assert.equal(uploads[0].scanError, "STATE_DB_UNREADABLE");
  assert.deepEqual(result.errors, [{ executionProfileId: "bibi-02", code: "STATE_DB_UNREADABLE" }]);
});

test("session discovery upload retries are bounded and report a durable local reason", async () => {
  let attempts = 0;
  const delays = [];
  const runner = createTelegramSessionDiscoveryRunner({
    listProfileIds: async () => ["bibi-02"],
    reader: { listSessions: async () => ({ sessions: [], error: null }) },
    transport: { uploadTelegramSessions: async () => { attempts += 1; throw new Error("offline"); } },
    uploadAttempts: 3,
    sleep: async (milliseconds) => delays.push(milliseconds),
    now: () => 1_000_000,
  });
  const result = await runner.runOnce({ force: true });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 500]);
  assert.deepEqual(result.errors, [{ executionProfileId: "bibi-02", code: "DISCOVERY_UPLOAD_FAILED" }]);
});

test("profile enumeration failure is not confused with an empty Telegram roster", async () => {
  const runner = createTelegramSessionDiscoveryRunner({
    listProfileIds: async () => { throw new Error("offline"); },
    reader: { listSessions: async () => ({ sessions: [], error: null }) },
    transport: { uploadTelegramSessions: async () => {} },
    now: () => 1_000_000,
  });
  const result = await runner.runOnce({ force: true });
  assert.equal(result.failed, 1);
  assert.deepEqual(result.errors, [{ code: "PROFILE_ENUMERATION_FAILED" }]);
});
