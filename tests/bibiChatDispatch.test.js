import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleChatSend, handlePoll, handleReport } from "../api/_lib/handlers.js";
import { applyWorkEvent, WORK_STATUS } from "../src/bibi/workLifecycle.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "22222222-2222-2222-2222-222222222222";
const NODE = "33333333-3333-3333-3333-333333333333";
const AUTH = { ok: true, ownerId: OWNER, connectorNodeId: NODE };

// ---------------------------------------------------------------------------
// A fake store that reproduces the database's uniqueness guarantees, so the
// idempotency claims here are about behaviour rather than about mocks.
// ---------------------------------------------------------------------------

function chatStore({ conversations = { "conv-1": { ownerId: OWNER, profileId: "bibi-01" } } } = {}) {
  const messages = [];
  const workItems = new Map();
  const events = new Set();
  const calls = { assistant: [], claims: [], saved: [] };
  let sequence = 0;

  const findMessage = (conversationId, clientMessageId) =>
    messages.find((m) => m.conversationId === conversationId && m.clientMessageId === clientMessageId);

  return {
    messages,
    workItems,
    calls,

    // Mirrors bibi_send_chat_message: one atomic unit, idempotent per turn.
    async sendChatMessage({ ownerId, conversationId, clientMessageId, body }) {
      const conversation = conversations[conversationId];
      if (!conversation || conversation.ownerId !== ownerId) {
        const error = new Error("conversation not found for owner");
        error.code = "CONVERSATION_NOT_FOUND";
        throw error;
      }

      const existing = findMessage(conversationId, clientMessageId);
      if (existing) {
        const command = [...workItems.values()]
          .find((item) => item.clientRequestId === `chat:${clientMessageId}`);
        return { duplicate: true, messageId: existing.id, workItemId: command?.id ?? null };
      }

      sequence += 1;
      const message = {
        id: `msg-${sequence}`,
        ownerId,
        conversationId,
        clientMessageId,
        profileId: conversation.profileId,
        role: "user",
        body,
      };
      messages.push(message);

      const workItem = {
        id: `work-${sequence}`,
        ownerId,
        kind: "chat",
        conversationId,
        requestMessageId: message.id,
        profileId: conversation.profileId,
        clientRequestId: `chat:${clientMessageId}`,
        title: body.slice(0, 80),
        brief: body,
        status: WORK_STATUS.ASSIGNED,
        attempt: 0,
        leaseId: null,
        nodeId: null,
        leaseExpiresAt: null,
        resultId: null,
        error: null,
        blockedReason: null,
        appliedEventIds: [],
      };
      workItems.set(workItem.id, workItem);
      return { duplicate: false, messageId: message.id, workItemId: workItem.id };
    },

    // Mirrors bibi_record_assistant_message: one reply per chat work item.
    async insertAssistantMessage({ ownerId, workItemId, body }) {
      calls.assistant.push({ ownerId, workItemId, body });
      const work = workItems.get(workItemId);
      if (!work || work.ownerId !== ownerId || work.kind !== "chat") {
        throw new Error("not a chat work item for this owner");
      }
      const clientMessageId = `assistant:${workItemId}`;
      const existing = findMessage(work.conversationId, clientMessageId);
      if (existing) return { duplicate: true, messageId: existing.id };

      sequence += 1;
      const message = {
        id: `msg-${sequence}`,
        ownerId,
        conversationId: work.conversationId,
        clientMessageId,
        profileId: work.profileId,
        role: "assistant",
        body,
      };
      messages.push(message);
      return { duplicate: false, messageId: message.id };
    },

    async claimWork(payload) {
      calls.claims.push(payload);
      return [...workItems.values()]
        .filter((item) => item.status === WORK_STATUS.ASSIGNED)
        .slice(0, payload.max)
        .map((item) => ({
          workItemId: item.id,
          profileId: item.profileId,
          kind: item.kind,
          conversationId: item.conversationId,
          title: item.title,
          brief: item.brief,
          attempt: item.attempt + 1,
          leaseId: `lease-${item.id}`,
          leaseExpiresAt: "2026-08-24T00:05:00.000Z",
        }));
    },

    async loadWorkItem({ ownerId, workItemId }) {
      const item = workItems.get(workItemId);
      return item && item.ownerId === ownerId ? { ...item } : null;
    },
    async applyReportAtomically({
      ownerId, connectorNodeId, workItemId, eventId, type, attempt,
      turnIdempotencyKey, summary, error, reason, at,
    }) {
      const item = workItems.get(workItemId);
      if (!item || item.ownerId !== ownerId) {
        const failure = new Error("work item not found for owner");
        failure.code = "WORK_ITEM_NOT_FOUND";
        throw failure;
      }
      const eventKey = `${workItemId}:${eventId}`;
      if (events.has(eventKey)) return { duplicate: true, status: item.status, resultId: item.resultId };
      if (item.nodeId !== connectorNodeId || item.attempt !== attempt || item.turnIdempotencyKey !== turnIdempotencyKey) {
        const failure = new Error("report identity mismatch");
        failure.code = "REPORT_IDENTITY_MISMATCH";
        throw failure;
      }

      let resultId = null;
      if (type === "succeed") {
        resultId = `result-${workItemId}`;
        if (item.kind === "chat" && item.continuationStatus !== "bound") {
          await this.insertAssistantMessage({ ownerId, workItemId, body: summary });
        }
      }
      try {
        const next = applyWorkEvent(item, {
          id: eventId,
          type,
          resultId,
          error,
          reason,
          at,
        });
        events.add(eventKey);
        workItems.set(workItemId, next);
        calls.saved.push(next);
        return { duplicate: false, status: next.status, resultId };
      } catch (cause) {
        cause.code = cause.code === "MISSING_REASON" ? "MISSING_REASON" : "INVALID_TRANSITION";
        throw cause;
      }
    },
    async recordEvent({ workItemId, eventId }) {
      const key = `${workItemId}:${eventId}`;
      if (events.has(key)) return { duplicate: true };
      events.add(key);
      return { duplicate: false };
    },
    async insertResult() {
      return { id: "result-1" };
    },
    async insertEvidence() {},
    async releaseLease() {},
    async saveWorkItem({ work }) {
      calls.saved.push(work);
      workItems.set(work.id, { ...workItems.get(work.id), ...work });
    },
    async recordHeartbeat() {},
  };
}

function running(store, workItemId) {
  const item = store.workItems.get(workItemId);
  store.workItems.set(workItemId, {
    ...item,
    status: WORK_STATUS.RUNNING,
    attempt: 1,
    nodeId: NODE,
    turnIdempotencyKey: `${workItemId}:1`,
  });
}

function connectorReport(workItemId, type, overrides = {}) {
  return {
    id: `${workItemId}:1:${type}`,
    type,
    workItemId,
    attempt: 1,
    turnIdempotencyKey: `${workItemId}:1`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sending a chat turn
// ---------------------------------------------------------------------------

test("a user message atomically becomes a durable, assigned chat command", async () => {
  const store = chatStore();
  const result = await handleChatSend({
    auth: { ok: true, ownerId: OWNER },
    body: { conversationId: "conv-1", clientMessageId: "cm-1", body: "오늘 일정 정리해줘" },
    store,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, false);
  assert.ok(result.body.messageId);
  assert.ok(result.body.workItemId);

  // Exactly one user turn and exactly one command, both durable before anything
  // tries to run.
  assert.equal(store.messages.length, 1);
  assert.equal(store.messages[0].role, "user");
  assert.equal(store.workItems.size, 1);

  const command = store.workItems.get(result.body.workItemId);
  assert.equal(command.kind, "chat");
  assert.equal(command.status, WORK_STATUS.ASSIGNED, "a chat turn is assigned immediately");
  assert.equal(command.conversationId, "conv-1");
  assert.equal(command.requestMessageId, result.body.messageId);
  assert.equal(command.profileId, "bibi-01");
});

test("an empty message is refused before anything durable is written", async () => {
  const store = chatStore();
  for (const body of ["", "   ", null, undefined]) {
    const result = await handleChatSend({
      auth: { ok: true, ownerId: OWNER },
      body: { conversationId: "conv-1", clientMessageId: "cm-x", body },
      store,
    });
    assert.equal(result.status, 400, `${String(body)} must be refused`);
    assert.equal(result.body.error, "EMPTY_MESSAGE");
  }
  assert.equal(store.messages.length, 0);
  assert.equal(store.workItems.size, 0);
});

test("a missing conversation or client message id is refused", async () => {
  const store = chatStore();
  for (const body of [
    { clientMessageId: "cm-1", body: "hi" },
    { conversationId: "conv-1", body: "hi" },
  ]) {
    const result = await handleChatSend({ auth: { ok: true, ownerId: OWNER }, body, store });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "INVALID_REQUEST");
  }
});

test("another account's conversation is not reachable", async () => {
  const store = chatStore();
  const result = await handleChatSend({
    auth: { ok: true, ownerId: OTHER_OWNER },
    body: { conversationId: "conv-1", clientMessageId: "cm-1", body: "hi" },
    store,
  });
  assert.equal(result.status, 404);
  assert.equal(store.messages.length, 0);
});

test("a resent turn creates neither a second message nor a second command", async () => {
  const store = chatStore();
  const body = { conversationId: "conv-1", clientMessageId: "cm-1", body: "같은 메시지" };

  const first = await handleChatSend({ auth: { ok: true, ownerId: OWNER }, body, store });
  const second = await handleChatSend({ auth: { ok: true, ownerId: OWNER }, body, store });

  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.messageId, first.body.messageId);
  assert.equal(second.body.workItemId, first.body.workItemId);
  assert.equal(store.messages.length, 1, "the user turn must exist exactly once");
  assert.equal(store.workItems.size, 1, "the chat command must exist exactly once");
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test("a chat command is leased like any other work, and says it is a chat turn", async () => {
  const store = chatStore();
  await handleChatSend({
    auth: { ok: true, ownerId: OWNER },
    body: { conversationId: "conv-1", clientMessageId: "cm-1", body: "무슨 일정 있어?" },
    store,
  });

  const poll = await handlePoll({ auth: AUTH, body: {}, store, maxBatch: 4 });
  assert.equal(poll.body.commands.length, 1);

  const command = poll.body.commands[0];
  assert.equal(command.kind, "chat");
  assert.equal(command.conversationId, "conv-1");
  assert.equal(command.profileId, "bibi-01");
  // The CEO still executes on the default profile.
  assert.equal(command.executionProfileId, "default");
  assert.ok(command.leaseId, "a chat turn is leased, not fire-and-forget");
});

// ---------------------------------------------------------------------------
// Assistant write-back
// ---------------------------------------------------------------------------

async function sendAndRun(store, clientMessageId = "cm-1") {
  const sent = await handleChatSend({
    auth: { ok: true, ownerId: OWNER },
    body: { conversationId: "conv-1", clientMessageId, body: "질문" },
    store,
  });
  running(store, sent.body.workItemId);
  return sent.body.workItemId;
}

test("a successful chat command writes the assistant reply into the same conversation", async () => {
  const store = chatStore();
  const workItemId = await sendAndRun(store);

  const report = await handleReport({
    auth: AUTH,
    body: connectorReport(workItemId, "succeed", { summary: "오늘 일정은 두 건입니다." }),
    store,
  });

  assert.equal(report.status, 200);
  const assistant = store.messages.filter((message) => message.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].conversationId, "conv-1");
  assert.equal(assistant[0].body, "오늘 일정은 두 건입니다.");
  assert.equal(assistant[0].profileId, "bibi-01");
});

test("a redelivered success report does not post the reply twice", async () => {
  const store = chatStore();
  const workItemId = await sendAndRun(store);
  const body = connectorReport(workItemId, "succeed", { summary: "답변" });

  const first = await handleReport({ auth: AUTH, body, store });
  const second = await handleReport({ auth: AUTH, body, store });

  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(store.messages.filter((message) => message.role === "assistant").length, 1);
});

test("a bound resumed turn relies on the projected Hermes reply instead of duplicating it", async () => {
  const store = chatStore();
  const workItemId = await sendAndRun(store);
  store.workItems.set(workItemId, {
    ...store.workItems.get(workItemId),
    continuationStatus: "bound",
    bindingId: "binding-1",
    hermesSessionId: "session-1",
  });

  const report = await handleReport({
    auth: AUTH,
    body: connectorReport(workItemId, "succeed", { id: "bound-success", summary: "projection에서 올 답변" }),
    store,
  });

  assert.equal(report.status, 200);
  assert.deepEqual(store.calls.assistant, []);
  assert.equal(store.messages.filter((message) => message.role === "assistant").length, 0);
});

test("an assistant reply is written at most once even if the event id differs", async () => {
  const store = chatStore();
  const workItemId = await sendAndRun(store);

  await handleReport({
    auth: AUTH,
    body: connectorReport(workItemId, "succeed", { id: "evt-a", summary: "답변" }),
    store,
  });
  // A second success under a different event id is refused by the lifecycle
  // (the item is already terminal), so no second reply can appear.
  const second = await handleReport({
    auth: AUTH,
    body: connectorReport(workItemId, "succeed", { id: "evt-b", summary: "다른 답변" }),
    store,
  });

  assert.equal(second.status, 409);
  assert.equal(store.messages.filter((message) => message.role === "assistant").length, 1);
});

test("an ordinary work item never writes into a conversation", async () => {
  const store = chatStore();
  store.workItems.set("work-plain", {
    id: "work-plain",
    ownerId: OWNER,
    kind: "work",
    conversationId: null,
    profileId: "bibi-02",
    clientRequestId: "req-1",
    title: "보고서",
    brief: "",
    status: WORK_STATUS.RUNNING,
    attempt: 1,
    leaseId: "l",
    nodeId: NODE,
    leaseExpiresAt: null,
    resultId: null,
    error: null,
    blockedReason: null,
    turnIdempotencyKey: "work-plain:1",
    appliedEventIds: [],
  });

  await handleReport({
    auth: AUTH,
    body: connectorReport("work-plain", "succeed", { id: "e1", summary: "완료" }),
    store,
  });

  assert.deepEqual(store.calls.assistant, []);
  assert.equal(store.messages.length, 0);
});

test("a failed chat turn reports its failure without inventing a reply", async () => {
  const store = chatStore();
  const workItemId = await sendAndRun(store);

  const report = await handleReport({
    auth: AUTH,
    body: connectorReport(workItemId, "fail", { id: "e1", error: "로컬 실행 시간 초과" }),
    store,
  });

  assert.equal(report.body.status, WORK_STATUS.FAILED);
  assert.equal(store.messages.filter((message) => message.role === "assistant").length, 0);
});

// ---------------------------------------------------------------------------
// Schema and separation of concerns
// ---------------------------------------------------------------------------

async function migrationSql() {
  const dir = path.join(projectRoot, "supabase", "migrations");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const parts = await Promise.all(files.map((name) => readFile(path.join(dir, name), "utf8")));
  return parts.join("\n");
}

test("chat commands are distinguishable from ordinary work in the schema", async () => {
  const sql = await migrationSql();
  assert.match(sql, /add column if not exists kind text not null default 'work'/);
  assert.match(sql, /check \(kind in \('work', 'chat'\)\)/);
  assert.match(sql, /add column if not exists conversation_id uuid/);
  assert.match(sql, /add column if not exists request_message_id uuid/);
  // A chat command without a conversation would have nowhere to reply.
  assert.match(sql, /kind <> 'chat' or conversation_id is not null/);
});

test("the atomic send and the assistant write-back are database functions", async () => {
  const sql = await migrationSql();
  assert.match(sql, /create or replace function public\.bibi_send_chat_message/);
  assert.match(sql, /create or replace function public\.bibi_record_assistant_message/);

  // Both bypass RLS by design, so neither may be callable from a browser.
  for (const fn of ["bibi_send_chat_message", "bibi_record_assistant_message"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}[^;]*from anon`), `${fn} anon`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}[^;]*from authenticated`), `${fn} authenticated`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}[^;]*to service_role`), `${fn} grant`);
  }
});

test("the browser can no longer insert a message directly", async () => {
  const sql = await migrationSql();
  // A direct insert would produce a user turn that never became a command,
  // which is exactly the storage-only behaviour this release removes. Match
  // whole statements: a lazy scan would run past the semicolon into the next
  // policy and report a false positive.
  const messagePolicies = [...sql.matchAll(/create policy\s+"[^"]+"\s+on public\.messages[^;]*;/gi)]
    .map((match) => match[0]);
  assert.ok(messagePolicies.length > 0, "messages must still be readable");
  for (const policy of messagePolicies) {
    assert.doesNotMatch(policy, /for insert/i, `messages must not be client-insertable: ${policy}`);
    assert.doesNotMatch(policy, /for update/i);
  }
  assert.match(sql, /create policy "messages_select_own" on public\.messages/);
});

test("the work board query excludes chat dispatch", async () => {
  const client = await readFile(path.join(projectRoot, "src", "cloud", "workspaceClient.js"), "utf8");
  const board = client.slice(client.indexOf("export async function loadWorkItems"));
  assert.match(board.slice(0, 600), /\.eq\("kind", "work"\)/);
});

test("the browser sends a chat turn through the API, not straight to the table", async () => {
  const client = await readFile(path.join(projectRoot, "src", "cloud", "workspaceClient.js"), "utf8");
  const send = client.slice(
    client.indexOf("export async function sendUserMessage"),
    client.indexOf("export async function loadWorkItems"),
  );
  assert.match(send, /\/api\/chat\/send/);
  assert.doesNotMatch(send, /\.from\("messages"\)/);
});

test("the chat send route exists and authenticates the signed-in user", async () => {
  const [dispatcher, wrappers] = await Promise.all([
    readFile(path.join(projectRoot, "api", "index.js"), "utf8"),
    readFile(path.join(projectRoot, "api", "_lib", "route.js"), "utf8"),
  ]);
  assert.match(dispatcher, /\["chat\/send", userRoute\(handleChatSend\)\]/);
  assert.match(wrappers, /authenticateUser/);
  assert.match(wrappers, /METHOD_NOT_ALLOWED/);
});

// ---------------------------------------------------------------------------
// Migration 005 replaces bibi_claim_work in place
// ---------------------------------------------------------------------------

async function migrationFile(name) {
  const dir = path.join(projectRoot, "supabase", "migrations");
  const files = (await readdir(dir)).filter((entry) => entry.includes(name));
  assert.equal(files.length, 1, `expected exactly one migration matching ${name}, got ${files.join(", ")}`);
  return readFile(path.join(dir, files[0]), "utf8");
}

/** The column list of the `returns table (...)` clause of bibi_claim_work. */
function claimReturnColumns(sql) {
  // Anchored on the definition, not on any mention: 005 also names the function
  // in its drop and in its grants.
  const start = sql.search(/create (?:or replace )?function public\.bibi_claim_work/i);
  assert.ok(start >= 0, "bibi_claim_work must be defined");
  const clause = sql.slice(start).match(/returns table\s*\(([\s\S]*?)\)\s*language/i);
  assert.ok(clause, "bibi_claim_work must return a table");
  return clause[1]
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
}

test("the chat-aware claim really is a different row type from the one 004 created", async () => {
  // If these ever matched, the drop below would be pointless ceremony. They do
  // not: this difference is exactly what PostgreSQL refuses to apply in place.
  const before = claimReturnColumns(await migrationFile("_bibi_claim_work.sql"));
  const after = claimReturnColumns(await migrationFile("_bibi_chat_execution.sql"));

  assert.notDeepEqual(after, before, "005 must change the claim's OUT row type, or it need not touch it");
  assert.ok(after.includes("kind"), "the claim must carry the chat marker");
  assert.ok(after.includes("conversation_id"), "the claim must carry the conversation to reply into");
  for (const column of before) {
    assert.ok(after.includes(column), `${column} must survive the replacement`);
  }
});

test("migration 005 drops the exact claim signature before recreating it", async () => {
  const sql = await migrationFile("_bibi_chat_execution.sql");

  // `create or replace` alone fails with 42P13 on every database where 004 was
  // already applied, which aborts the whole migration. Only a drop of the exact
  // four-argument signature clears the old OUT row type.
  const drop = sql.match(
    /drop function if exists public\.bibi_claim_work\s*\(\s*uuid\s*,\s*uuid\s*,\s*integer\s*,\s*integer\s*\)\s*;/i,
  );
  assert.ok(drop, "005 must drop public.bibi_claim_work(uuid, uuid, integer, integer) by its exact signature");

  // An unqualified `drop function bibi_claim_work` would be ambiguous the
  // moment a second overload exists, and `cascade` would silently take
  // dependents with it.
  assert.doesNotMatch(sql, /drop function[^;]*bibi_claim_work[^;]*cascade/i);

  const create = sql.search(/create (?:or replace )?function public\.bibi_claim_work/i);
  assert.ok(create >= 0, "005 must recreate the claim");
  assert.ok(
    drop.index < create,
    "the drop must precede the replacement, otherwise the create still hits the old row type",
  );
});

test("the recreated claim keeps its service-role-only privileges", async () => {
  const sql = await migrationFile("_bibi_chat_execution.sql");
  const create = sql.search(/create (?:or replace )?function public\.bibi_claim_work/i);

  // A dropped function takes its grants with it and comes back with the default
  // `execute` to public. Without these statements the recreated security
  // definer function would be callable from a browser session and would hand it
  // every owner's work queue.
  const signature = "public\\.bibi_claim_work\\s*\\(\\s*uuid\\s*,\\s*uuid\\s*,\\s*integer\\s*,\\s*integer\\s*\\)";
  for (const role of ["public", "anon", "authenticated"]) {
    const revoke = sql.search(new RegExp(`revoke all on function ${signature} from ${role}\\s*;`, "i"));
    assert.ok(revoke >= 0, `005 must revoke the recreated claim from ${role}`);
    assert.ok(revoke > create, `the revoke from ${role} must come after the recreated definition`);
  }

  const grant = sql.search(new RegExp(`grant execute on function ${signature} to service_role\\s*;`, "i"));
  assert.ok(grant >= 0, "005 must grant execute on the recreated claim to service_role");
  assert.ok(grant > create, "the grant must come after the recreated definition");
});
