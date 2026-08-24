import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeConversationMessages } from "../src/cloud/workspaceClient.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("cloud timeline merges web and projected Telegram messages by source time with provenance", () => {
  const timeline = mergeConversationMessages(
    [{ id: "web-1", role: "user", body: "web", created_at: "2026-08-24T04:00:02.000Z" }],
    [{ id: "tg-1", role: "assistant", body: "telegram", source_timestamp: "2026-08-24T04:00:01.000Z", source_sequence: 7, channel: "telegram", sync_status: "synced" }],
  );
  assert.deepEqual(timeline.map((message) => message.id), ["tg-1", "web-1"]);
  assert.equal(timeline[0].channel, "telegram");
  assert.equal(timeline[0].provenance, "telegram");
  assert.equal(timeline[0].sync_status, "synced");
  assert.equal(timeline[1].channel, "web");
});

test("a resumed web turn is canonicalized once with its actual web provenance across replay", () => {
  const timeline = mergeConversationMessages(
    [{ id: "web-1", role: "user", body: "같은 질문", client_message_id: "cm-1", created_at: "2026-08-24T04:00:00.000Z" }],
    [
      { id: "local-user-1", role: "user", body: "같은 질문", canonical_message_key: "web:web-1", origin_channel: "web", source_timestamp: "2026-08-24T04:00:01.000Z", source_sequence: 10, channel: "telegram" },
      { id: "local-user-replay", role: "user", body: "같은 질문", canonical_message_key: "web:web-1", origin_channel: "web", source_timestamp: "2026-08-24T04:00:01.000Z", source_sequence: 10, channel: "telegram" },
      { id: "local-assistant-1", role: "assistant", body: "답변", canonical_message_key: "assistant:work-1", origin_channel: "web", source_timestamp: "2026-08-24T04:00:02.000Z", source_sequence: 11, channel: "telegram" },
    ],
  );
  assert.deepEqual(timeline.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(timeline.map((message) => message.body), ["같은 질문", "답변"]);
  assert.deepEqual(timeline.map((message) => message.provenance), ["web", "web"]);
});

test("a projected deletion tombstone removes the canonical message from the visible timeline", () => {
  const timeline = mergeConversationMessages(
    [{ id: "web-1", role: "user", body: "삭제될 질문", created_at: "2026-08-24T04:00:00.000Z" }],
    [{ id: "tomb-1", role: "user", body: "", canonical_message_key: "web:web-1", origin_channel: "web", lifecycle_state: "deleted", source_timestamp: "2026-08-24T04:00:01.000Z", source_sequence: 12, channel: "telegram" }],
  );
  assert.deepEqual(timeline, []);
});

test("workspace client queries canonical provenance and projected messages without production Hermes proxy", async () => {
  const client = await read("src/cloud/workspaceClient.js");
  assert.match(client, /origin_channel, sync_status, sync_error, telegram_mirroring_enabled/);
  assert.match(client, /from\("projected_messages"\)/);
  assert.match(client, /source_timestamp/);
  assert.doesNotMatch(client, /\/hermes\/api\//);
});

test("chat UX visibly separates new and continued conversations and reports honest sync/mirroring", async () => {
  const [workspace, css] = await Promise.all([read("src/BibiWorkspace.jsx"), read("src/bibiWorkspace.css")]);
  assert.match(workspace, /새 대화/);
  assert.match(workspace, /이 대화 계속하기/);
  assert.match(workspace, /Telegram에서 시작/);
  assert.match(workspace, /Telegram 미러링 꺼짐/);
  assert.match(workspace, /sync_status/);
  assert.match(workspace, /origin_channel/);
  assert.match(css, /bibi-conversation-list/);
});

test("mirroring remains unsupported and disabled rather than inventing a delivery contract", async () => {
  const sources = await Promise.all([
    read("src/BibiWorkspace.jsx"),
    read("connector/outboundTransport.js"),
    read("api/_lib/handlers.js"),
  ]);
  const combined = sources.join("\n");
  assert.match(combined, /Telegram 미러링 꺼짐/);
  assert.doesNotMatch(combined, /sendTelegram|mirrorToTelegram|telegram\/send/i);
});
