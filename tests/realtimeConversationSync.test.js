/**
 * Live conversation sync: subscription coverage, burst coalescing, and the
 * canonical merge the timeline is rendered from.
 *
 * The gap this closes is concrete. Before this phase the workspace subscribed to
 * `messages` but not to `projected_messages`, `conversations`,
 * `conversation_bindings` or `projection_checkpoints` — so a Telegram turn the
 * connector projected, a binding a connector verified, and a checkpoint moving
 * all landed in Postgres and changed nothing on screen until the user reloaded.
 *
 * The second half is why the fix is not simply "subscribe and refetch per
 * event". One projection upload is one insert per message, so a batch of two
 * hundred delivers two hundred events. The coalescer is what turns that into one
 * refetch, and the merge is what makes the refetched result stable.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRefetchCoalescer } from "../src/bibi/realtimeCoalescer.js";
import { createWorkspaceSubscription, mergeConversationMessages } from "../src/cloud/workspaceClient.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const ACCESS_TOKEN = "header.owner-payload.signature";

async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function fakeSupabase() {
  const channels = [];
  return {
    channels,
    auth: { async getSession() { return { data: { session: { access_token: ACCESS_TOKEN } } } } },
    realtime: { async setAuth() {} },
    channel(name) {
      const channel = {
        name,
        bindings: [],
        handlers: new Map(),
        on(event, filter, handler) {
          this.bindings.push(filter.table);
          this.handlers.set(filter.table, handler);
          return this;
        },
        subscribe(callback) { this.statusCallback = callback; return this; },
        emit(table, row) { this.handlers.get(table)?.({ new: row, eventType: "INSERT" }); },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel() {},
  };
}

/** A clock the tests advance by hand, so no assertion waits on a real timer. */
function manualClock() {
  let next = 1;
  const timers = new Map();
  return {
    schedule(callback, delay) {
      const handle = next++;
      timers.set(handle, { callback, delay });
      return handle;
    },
    cancel(handle) { timers.delete(handle); },
    /** Fire everything currently scheduled, the way a settled window would. */
    tick() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.callback();
    },
    get size() { return timers.size; },
  };
}

// ---------------------------------------------------------------------------
// Subscription coverage
// ---------------------------------------------------------------------------

test("every table a canonical timeline depends on is subscribed", async () => {
  const supabase = fakeSupabase();

  createWorkspaceSubscription(supabase, {
    onProjectedMessage() {}, onConversation() {}, onConversationBinding() {},
    onProjectionCheckpoint() {}, onTelegramSession() {}, onTelegramSessionScan() {},
  });
  await settle();

  assert.deepEqual(supabase.channels[0].bindings, [
    "projected_messages", "conversations", "conversation_bindings",
    "projection_checkpoints", "bibi_telegram_sessions", "bibi_telegram_session_scans",
  ]);
});

test("a projected Telegram turn reaches its handler with its conversation", async () => {
  const supabase = fakeSupabase();
  const seen = [];
  createWorkspaceSubscription(supabase, { onProjectedMessage: (row) => seen.push(row) });
  await settle();

  supabase.channels[0].emit("projected_messages", { id: "p-1", conversation_id: "c-1", role: "user" });
  assert.deepEqual(seen, [{ id: "p-1", conversation_id: "c-1", role: "user" }]);
});

test("the workspace binds all six and drives each from the open conversation", async () => {
  const workspace = await read("src/BibiWorkspace.jsx");
  const subscription = workspace.slice(
    workspace.indexOf("return subscribeToWorkspace({"),
    workspace.indexOf("// ---- connector health"),
  );

  for (const handler of [
    "onProjectedMessage", "onConversation", "onConversationBinding",
    "onProjectionCheckpoint", "onTelegramSession", "onTelegramSessionScan",
  ]) {
    assert.match(subscription, new RegExp(`${handler}:`), `${handler} must be wired`);
  }
  // Matched against a ref, not against a captured value: the channel is not
  // rebuilt when the selection changes, so a captured id would go stale.
  assert.match(subscription, /row\.conversation_id !== conversationIdRef\.current/);
  // Bursts are collapsed rather than refetched per row.
  assert.match(subscription, /coalesce\(`conversation:\$\{row\.conversation_id\}`/);
  assert.match(subscription, /coalesce\("telegram", refreshTelegramDiscovery\)/);
  // Realtime replays nothing missed while the socket was down.
  assert.match(subscription, /onResync: refresh/);
});

test("a reconnect re-reads the open conversation, not only the snapshot", async () => {
  const workspace = await read("src/BibiWorkspace.jsx");
  const refresh = workspace.slice(
    workspace.indexOf("const refresh = useCallback"),
    workspace.indexOf("// Ending a meeting is a write"),
  );
  assert.match(refresh, /await refreshConversation\(conversationIdRef\.current\)/);
});

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

test("a burst on one conversation produces exactly one refetch", () => {
  const clock = manualClock();
  const coalescer = createRefetchCoalescer({ schedule: clock.schedule, cancel: clock.cancel, windowMs: 120 });
  let refetches = 0;

  for (let index = 0; index < 200; index += 1) {
    coalescer.push("conversation:c-1", () => { refetches += 1; });
  }
  assert.equal(refetches, 0, "nothing runs until the window settles");
  clock.tick();
  assert.equal(refetches, 1);
});

test("two conversations are coalesced separately, never merged", () => {
  const clock = manualClock();
  const coalescer = createRefetchCoalescer({ schedule: clock.schedule, cancel: clock.cancel });
  const ran = [];

  coalescer.push("conversation:c-1", () => ran.push("c-1"));
  coalescer.push("conversation:c-2", () => ran.push("c-2"));
  coalescer.push("conversation:c-1", () => ran.push("c-1"));
  assert.deepEqual(coalescer.pendingKeys().sort(), ["conversation:c-1", "conversation:c-2"]);

  clock.tick();
  assert.deepEqual(ran.sort(), ["c-1", "c-2"]);
});

test("the last refetch pushed inside a window is the one that runs", () => {
  const clock = manualClock();
  const coalescer = createRefetchCoalescer({ schedule: clock.schedule, cancel: clock.cancel });
  const ran = [];

  coalescer.push("k", () => ran.push("stale"));
  coalescer.push("k", () => ran.push("fresh"));
  clock.tick();

  assert.deepEqual(ran, ["fresh"]);
});

test("a continuous stream still flushes rather than starving on its own traffic", () => {
  const clock = manualClock();
  const coalescer = createRefetchCoalescer({ schedule: clock.schedule, cancel: clock.cancel });
  let refetches = 0;

  for (let round = 0; round < 3; round += 1) {
    coalescer.push("k", () => { refetches += 1; });
    coalescer.push("k", () => { refetches += 1; });
    clock.tick();
  }
  assert.equal(refetches, 3, "one refetch per settled window, not one per event");
});

test("flush runs what is queued immediately, which is what a reconnect needs", () => {
  const clock = manualClock();
  const coalescer = createRefetchCoalescer({ schedule: clock.schedule, cancel: clock.cancel });
  let ran = 0;

  coalescer.push("k", () => { ran += 1; });
  coalescer.flush();
  assert.equal(ran, 1);
  assert.deepEqual(coalescer.pendingKeys(), []);
  // The timer that was pending was cancelled rather than left to fire twice.
  clock.tick();
  assert.equal(ran, 1);
});

test("a refetch that throws does not stop the next one from being scheduled", () => {
  const clock = manualClock();
  const coalescer = createRefetchCoalescer({ schedule: clock.schedule, cancel: clock.cancel });
  let ran = 0;

  coalescer.push("k", () => { throw new Error("network"); });
  clock.tick();
  coalescer.push("k", () => { ran += 1; });
  clock.tick();

  assert.equal(ran, 1);
});

test("a rejected refetch is not an unhandled rejection", async () => {
  const clock = manualClock();
  const coalescer = createRefetchCoalescer({ schedule: clock.schedule, cancel: clock.cancel });

  coalescer.push("k", async () => { throw new Error("network"); });
  clock.tick();
  await settle();
});

test("disposal cancels everything pending and refuses new work", () => {
  const clock = manualClock();
  const coalescer = createRefetchCoalescer({ schedule: clock.schedule, cancel: clock.cancel });
  let ran = 0;

  coalescer.push("k", () => { ran += 1; });
  coalescer.dispose();
  clock.tick();
  coalescer.push("k", () => { ran += 1; });
  clock.tick();

  assert.equal(ran, 0);
  assert.equal(clock.size, 0);
});

test("the workspace disposes its coalescer when it unmounts", async () => {
  const workspace = await read("src/BibiWorkspace.jsx");
  assert.match(workspace, /if \(coalescerRef\.current == null\) coalescerRef\.current = createRefetchCoalescer\(\);/);
  assert.match(workspace, /useEffect\(\(\) => \(\) => coalescerRef\.current\?\.dispose\(\), \[\]\);/);
});

// ---------------------------------------------------------------------------
// Canonical merge
// ---------------------------------------------------------------------------

test("a web turn and its projected copy are one message, with the web provenance", () => {
  const timeline = mergeConversationMessages(
    [{ id: "web-1", role: "user", body: "질문", created_at: "2026-08-27T01:00:00.000Z" }],
    [{
      id: "p-1", role: "user", body: "질문", canonical_message_key: "web:web-1",
      origin_channel: "web", channel: "telegram", source_sequence: 4,
      source_timestamp: "2026-08-27T01:00:01.000Z", lifecycle_state: "active",
    }],
  );

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].provenance, "web");
});

test("a replayed projection batch does not duplicate a single turn", () => {
  const projected = Array.from({ length: 5 }, (_, index) => ({
    id: `p-${index}`, role: "assistant", body: "답변",
    canonical_message_key: "telegram:bibi-07:sess-abc:41",
    origin_channel: "telegram", channel: "telegram", source_sequence: 41,
    source_timestamp: "2026-08-27T01:00:02.000Z", lifecycle_state: "active",
  }));

  const timeline = mergeConversationMessages([], projected);
  assert.equal(timeline.length, 1);
});

test("a lifecycle tombstone replaces the message rather than adding to it", () => {
  for (const lifecycle of ["deleted", "archived", "retention"]) {
    const timeline = mergeConversationMessages(
      [{ id: "web-1", role: "user", body: "질문", created_at: "2026-08-27T01:00:00.000Z" }],
      [{
        id: "p-1", role: "user", body: "", canonical_message_key: "web:web-1",
        origin_channel: "web", channel: "telegram", source_sequence: 4,
        source_timestamp: "2026-08-27T01:00:01.000Z", lifecycle_state: lifecycle,
      }],
    );
    assert.deepEqual(timeline, [], `${lifecycle} must remove the message from the visible timeline`);
  }
});

test("ordering is by source time, then sequence, then a fixed tiebreak", () => {
  const sameInstant = "2026-08-27T01:00:00.000Z";
  const rows = [
    { id: "p-b", role: "user", body: "b", canonical_message_key: "telegram:b", source_timestamp: sameInstant, source_sequence: 2, channel: "telegram", origin_channel: "telegram" },
    { id: "p-a", role: "user", body: "a", canonical_message_key: "telegram:a", source_timestamp: sameInstant, source_sequence: 2, channel: "telegram", origin_channel: "telegram" },
    { id: "p-c", role: "user", body: "c", canonical_message_key: "telegram:c", source_timestamp: sameInstant, source_sequence: 1, channel: "telegram", origin_channel: "telegram" },
  ];

  const first = mergeConversationMessages([], rows).map((message) => message.id);
  // The same rows, delivered in a different order by a refetch, render the same.
  const second = mergeConversationMessages([], [...rows].reverse()).map((message) => message.id);

  assert.deepEqual(first, ["p-c", "p-a", "p-b"]);
  assert.deepEqual(second, first);
});

test("a projected row from another conversation cannot enter this timeline", () => {
  const timeline = mergeConversationMessages(
    [{ id: "web-1", conversation_id: "c-1", role: "user", body: "우리 대화", created_at: "2026-08-27T01:00:00.000Z" }],
    [
      { id: "p-1", conversation_id: "c-1", role: "assistant", body: "우리 답변", canonical_message_key: "telegram:1", origin_channel: "telegram", channel: "telegram", source_sequence: 1, source_timestamp: "2026-08-27T01:00:01.000Z" },
      { id: "p-2", conversation_id: "c-2", role: "assistant", body: "남의 답변", canonical_message_key: "telegram:2", origin_channel: "telegram", channel: "telegram", source_sequence: 2, source_timestamp: "2026-08-27T01:00:02.000Z" },
    ],
    { conversationId: "c-1" },
  );

  assert.deepEqual(timeline.map((message) => message.id), ["web-1", "p-1"]);
});

test("the conversation read passes its own id into the merge", async () => {
  const client = await read("src/cloud/workspaceClient.js");
  const loader = client.slice(client.indexOf("export async function loadMessages"), client.indexOf("// Telegram binding"));
  assert.match(loader, /\.eq\("conversation_id", conversationId\)/);
  assert.match(loader, /\{ conversationId \}/);
});
