/**
 * Ordering contract for the workspace realtime subscription.
 *
 * The bug these guard against is silent by construction: a channel that joins
 * before the socket has the owner's JWT authenticates as `anon`, matches no row
 * under RLS, and then reports SUBSCRIBED and delivers nothing forever. A live
 * two-account run received zero owner events in that state and one owner event
 * with zero cross-account leakage once `realtime.setAuth` was called before
 * subscribe. Nothing about the failure is observable from the channel's own
 * status, so the order is asserted directly.
 *
 * The second half is disposal. Establishing the subscription is asynchronous
 * and unsubscribing is not, so a React effect can — and on a fast sign-out
 * does — tear down while the handshake is still in flight. Every point where
 * the work could resume after that is exercised here.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWorkspaceSubscription } from "../src/cloud/workspaceClient.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

const ACCESS_TOKEN = "header.owner-payload.signature";

/** Let every queued microtask run, which is how far the handshake gets. */
async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/**
 * A Supabase double that records the order of everything the subscription does
 * to it. `gate` lets a test hold the handshake open at `setAuth` and dispose
 * mid-flight.
 */
function fakeSupabase({ session = { access_token: ACCESS_TOKEN }, getSessionError = null, gate = null } = {}) {
  const calls = [];
  const channels = [];

  const makeChannel = (name) => {
    const channel = {
      name,
      bindings: [],
      handlers: new Map(),
      subscribed: false,
      removed: false,
      on(event, filter, handler) {
        calls.push(`on:${filter.table}`);
        this.bindings.push(filter.table);
        this.handlers.set(filter.table, handler);
        return this;
      },
      subscribe(callback) {
        calls.push("subscribe");
        this.subscribed = true;
        this.statusCallback = callback;
        return this;
      },
      /** Deliver a row the way postgres_changes would. */
      emit(table, row) {
        this.handlers.get(table)?.({ new: row, eventType: "INSERT" });
      },
    };
    channels.push(channel);
    return channel;
  };

  return {
    calls,
    channels,
    auth: {
      async getSession() {
        calls.push("getSession");
        if (getSessionError) throw getSessionError;
        return { data: { session } };
      },
    },
    realtime: {
      token: null,
      async setAuth(token) {
        calls.push("setAuth");
        this.token = token;
        if (gate) await gate.promise;
      },
    },
    channel(name) {
      calls.push("channel");
      return makeChannel(name);
    },
    removeChannel(channel) {
      calls.push("removeChannel");
      channel.removed = true;
    },
  };
}

function openGate() {
  let release = () => {};
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("the realtime JWT is set before the channel is created, never after", async () => {
  const supabase = fakeSupabase();

  createWorkspaceSubscription(supabase, { onWorkItem() {} });
  await settle();

  const setAuthAt = supabase.calls.indexOf("setAuth");
  const channelAt = supabase.calls.indexOf("channel");
  const subscribeAt = supabase.calls.indexOf("subscribe");

  assert.notEqual(setAuthAt, -1, "the socket must be given the owner's token");
  assert.notEqual(channelAt, -1, "a channel must be created");
  assert.ok(setAuthAt < channelAt, "a channel created before setAuth joins as anon and receives nothing");
  assert.ok(channelAt < subscribeAt, "bindings are attached before the join");

  assert.deepEqual(
    supabase.calls.slice(0, 3),
    ["getSession", "setAuth", "channel"],
    "session, then socket auth, then channel",
  );
});

test("the token handed to the socket is the current session's access token", async () => {
  const supabase = fakeSupabase({ session: { access_token: ACCESS_TOKEN } });

  createWorkspaceSubscription(supabase, { onWorkItem() {} });
  await settle();

  assert.equal(supabase.realtime.token, ACCESS_TOKEN);
});

test("every table the workspace renders is bound, and bound before subscribe", async () => {
  const supabase = fakeSupabase();

  createWorkspaceSubscription(supabase, {
    onWorkItem() {}, onWorkEvent() {}, onMessage() {}, onConnector() {},
  });
  await settle();

  assert.deepEqual(
    supabase.channels[0].bindings,
    ["work_items", "work_events", "messages", "connector_nodes"],
  );
  assert.ok(
    supabase.calls.lastIndexOf("on:connector_nodes") < supabase.calls.indexOf("subscribe"),
    "a binding added after the join misses everything until the next one",
  );
});

test("a handler that was not supplied is not bound at all", async () => {
  const supabase = fakeSupabase();

  createWorkspaceSubscription(supabase, { onMessage() {} });
  await settle();

  assert.deepEqual(supabase.channels[0].bindings, ["messages"]);
});

// ---------------------------------------------------------------------------
// No session
// ---------------------------------------------------------------------------

test("with no session there is no token, so nothing is subscribed to", async () => {
  const supabase = fakeSupabase({ session: null });

  const unsubscribe = createWorkspaceSubscription(supabase, { onWorkItem() {} });
  await settle();

  assert.equal(supabase.calls.includes("setAuth"), false, "there is no token to set");
  assert.equal(supabase.calls.includes("channel"), false, "an anonymous join would receive nothing anyway");
  assert.deepEqual(supabase.channels, []);

  // The disposer is still safe to call, because the caller cannot know which
  // of these two paths it got.
  assert.doesNotThrow(() => unsubscribe());
});

test("a session that carries no access token is treated as no session", async () => {
  const supabase = fakeSupabase({ session: { user: { id: "owner" } } });

  createWorkspaceSubscription(supabase, { onWorkItem() {} });
  await settle();

  assert.equal(supabase.calls.includes("channel"), false);
});

test("a session lookup that throws subscribes to nothing rather than joining anonymously", async () => {
  const supabase = fakeSupabase({ getSessionError: new Error("network") });

  const unsubscribe = createWorkspaceSubscription(supabase, { onWorkItem() {} });
  await settle();

  assert.equal(supabase.calls.includes("channel"), false);
  assert.doesNotThrow(() => unsubscribe());
});

test("an unconfigured client yields a disposer and no work", () => {
  const unsubscribe = createWorkspaceSubscription(null, { onWorkItem() {} });
  assert.equal(typeof unsubscribe, "function");
  assert.doesNotThrow(() => unsubscribe());
});

// ---------------------------------------------------------------------------
// Disposal races
// ---------------------------------------------------------------------------

test("the disposer is returned immediately, before the handshake has run", () => {
  const supabase = fakeSupabase();

  const unsubscribe = createWorkspaceSubscription(supabase, { onWorkItem() {} });

  // Synchronously after the call: nothing has been awaited yet, so no channel
  // can exist. The disposer still has to be callable right here.
  assert.equal(typeof unsubscribe, "function");
  assert.deepEqual(supabase.channels, []);
  assert.doesNotThrow(() => unsubscribe());
});

test("disposing before the session resolves never creates a channel", async () => {
  const supabase = fakeSupabase();

  const unsubscribe = createWorkspaceSubscription(supabase, { onWorkItem() {} });
  unsubscribe();
  await settle();

  assert.equal(supabase.calls.includes("channel"), false, "a late subscription after disposal is a leak");
  assert.deepEqual(supabase.channels, []);
});

test("disposing while setAuth is in flight leaves no channel behind", async () => {
  const gate = openGate();
  const supabase = fakeSupabase({ gate });

  const unsubscribe = createWorkspaceSubscription(supabase, { onWorkItem() {} });
  await settle();

  // The handshake is parked inside setAuth, which is exactly where a fast
  // sign-out lands.
  assert.equal(supabase.calls.includes("setAuth"), true);
  assert.equal(supabase.calls.includes("channel"), false);

  unsubscribe();
  gate.release();
  await settle();

  assert.equal(supabase.calls.includes("channel"), false, "the join must not resume after disposal");
  assert.deepEqual(supabase.channels, []);
});

test("disposing after the channel is joined removes it exactly once", async () => {
  const supabase = fakeSupabase();

  const unsubscribe = createWorkspaceSubscription(supabase, { onWorkItem() {} });
  await settle();

  assert.equal(supabase.channels.length, 1);
  unsubscribe();
  assert.equal(supabase.channels[0].removed, true);

  // Repeated disposal is what a double-invoked effect cleanup does; it must not
  // remove a channel a later subscription owns.
  unsubscribe();
  assert.equal(supabase.calls.filter((call) => call === "removeChannel").length, 1);
});

test("a row delivered after disposal is dropped rather than handed to the caller", async () => {
  const supabase = fakeSupabase();
  const received = [];

  const unsubscribe = createWorkspaceSubscription(supabase, {
    onWorkItem: (row) => received.push(row),
  });
  await settle();

  supabase.channels[0].emit("work_items", { id: "before" });
  assert.deepEqual(received, [{ id: "before" }]);

  unsubscribe();
  // In flight when the channel was removed: the socket does not un-send it.
  supabase.channels[0].emit("work_items", { id: "after" });
  assert.deepEqual(received, [{ id: "before" }], "a disposed caller must not be written into");
});

// ---------------------------------------------------------------------------
// Resync
// ---------------------------------------------------------------------------

test("the first SUBSCRIBED is the initial join, and only later ones are resyncs", async () => {
  const supabase = fakeSupabase();
  let resyncs = 0;

  createWorkspaceSubscription(supabase, { onWorkItem() {}, onResync: () => { resyncs += 1; } });
  await settle();

  const channel = supabase.channels[0];
  channel.statusCallback("SUBSCRIBED");
  assert.equal(resyncs, 0, "the initial join is not a resync; the caller has just fetched");

  channel.statusCallback("CHANNEL_ERROR");
  assert.equal(resyncs, 0, "only a completed rejoin means rows may have been missed");

  channel.statusCallback("SUBSCRIBED");
  assert.equal(resyncs, 1, "a reconnect replays nothing, so the caller must refetch");
});

test("a resync that lands after disposal is suppressed", async () => {
  const supabase = fakeSupabase();
  let resyncs = 0;

  const unsubscribe = createWorkspaceSubscription(supabase, {
    onWorkItem() {}, onResync: () => { resyncs += 1; },
  });
  await settle();

  const channel = supabase.channels[0];
  channel.statusCallback("SUBSCRIBED");
  unsubscribe();
  channel.statusCallback("SUBSCRIBED");

  assert.equal(resyncs, 0, "a refetch triggered into a torn-down caller is a leak");
});

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

test("the browser binding supplies the real client and adds no second ordering", async () => {
  const source = await read("src/cloud/workspaceClient.js");

  // One implementation, one order. If `subscribeToWorkspace` grew its own
  // channel creation again, everything above would still pass while the app
  // regressed.
  assert.match(source, /export function subscribeToWorkspace\(handlers = \{\}\) \{\s*return createWorkspaceSubscription\(getSupabaseClient\(\), handlers\);\s*\}/);
  assert.equal((source.match(/supabase\.channel\(/g) ?? []).length, 1);
  assert.equal((source.match(/realtime\.setAuth\(/g) ?? []).length, 1);

  const setAuthAt = source.indexOf("realtime.setAuth(");
  const channelAt = source.indexOf("supabase.channel(");
  assert.ok(setAuthAt < channelAt, "the source order is the wire order");
});
