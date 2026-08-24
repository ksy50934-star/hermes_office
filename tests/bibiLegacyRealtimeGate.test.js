/**
 * The Bibi Workspace must never mint a legacy Hermes WebSocket ticket.
 *
 * The office chat runtime is rendered once and hidden rather than unmounted, so
 * before this gate a plain page load on the Bibi/CEO surface opened the legacy
 * gateway in the background and got `405` back from
 * `POST /hermes/api/auth/ws-ticket` — that surface is served by the cloud
 * deployment, which has no Hermes gateway behind it.
 *
 * These tests drive the real `HermesGateway` through the real gate with the
 * network stubbed, so what they assert is the request itself: whether a
 * ws-ticket POST leaves the page for a given view.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HermesGateway } from "../src/gateway.js";
import { isBibiSurface } from "../src/bibi/surface.js";
import { startLegacyRealtime } from "../src/legacyRealtime.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

const WS_TICKET_PATH = "/hermes/api/auth/ws-ticket";

function eventTargetShim(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = { type }) {
      [...(listeners.get(type) ?? [])].forEach((listener) => listener(event));
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/**
 * Install just enough browser surface for `HermesGateway.connect()` to run, and
 * record every request so a test can ask what actually went out on the wire.
 */
function installBrowser() {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
  };
  const requests = [];
  const sockets = [];

  globalThis.window = eventTargetShim({
    location: { protocol: "https:", host: "bibi.example.com" },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  });
  globalThis.document = eventTargetShim();
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: String(options.method ?? "GET").toUpperCase() });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ticket: "ticket-abc" }),
      text: async () => "",
    };
  };
  globalThis.WebSocket = class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.closed = null;
      sockets.push(this);
      this.events = eventTargetShim();
      // The gateway registers its "open" listener immediately after
      // construction, so hand the open event back on the next microtask.
      queueMicrotask(() => this.events.dispatch("open"));
    }

    addEventListener(type, listener) {
      this.events.addEventListener(type, listener);
    }

    close(code) {
      this.closed = code ?? 1000;
    }
  };

  return {
    requests,
    sockets,
    ticketPosts: () => requests.filter((item) => item.method === "POST" && item.url.endsWith(WS_TICKET_PATH)),
    restore() {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.fetch = saved.fetch;
      globalThis.WebSocket = saved.WebSocket;
    },
  };
}

/** Let the connect() promise chain settle without a wall-clock wait. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the Bibi surface makes no ws-ticket request at all", async (t) => {
  const browser = installBrowser();
  t.after(() => browser.restore());

  const gateway = new HermesGateway();
  let reconnects = 0;
  const stop = startLegacyRealtime({
    enabled: !isBibiSurface("ceo"),
    gateway,
    onConnectFailure: () => {},
    reconnect: () => { reconnects += 1; },
  });
  await settle();

  assert.deepEqual(browser.requests, [], "the Bibi surface must not talk to the legacy Hermes API");
  assert.equal(browser.sockets.length, 0, "no legacy WebSocket may be opened");
  assert.equal(gateway.state, "idle");

  // Regaining focus or coming back online is the other way a ticket got minted.
  globalThis.window.dispatch("online");
  globalThis.document.dispatch("visibilitychange");
  await settle();

  assert.equal(reconnects, 0, "reconnect triggers must not be armed on the Bibi surface");
  assert.deepEqual(browser.ticketPosts(), []);
  stop();
});

test("a non-Bibi surface still mints its ticket and opens the gateway", async (t) => {
  const browser = installBrowser();
  t.after(() => browser.restore());

  const gateway = new HermesGateway();
  let reconnects = 0;
  const failures = [];
  const stop = startLegacyRealtime({
    enabled: !isBibiSurface("terminal"),
    gateway,
    onConnectFailure: (error) => failures.push(error),
    reconnect: () => { reconnects += 1; },
  });
  await settle();

  assert.deepEqual(failures, [], "the legacy connect path must still succeed off the Bibi surface");
  assert.deepEqual(browser.ticketPosts(), [{ url: WS_TICKET_PATH, method: "POST" }]);
  assert.equal(gateway.state, "open");
  assert.equal(browser.sockets.length, 1);
  assert.match(browser.sockets[0].url, /^wss:\/\/bibi\.example\.com\/hermes\/api\/ws\?ticket=ticket-abc$/);

  globalThis.window.dispatch("online");
  assert.equal(reconnects, 1, "reconnect triggers stay armed off the Bibi surface");
  globalThis.document.dispatch("visibilitychange");
  assert.equal(reconnects, 2);

  stop();
  globalThis.window.dispatch("online");
  globalThis.document.dispatch("visibilitychange");
  assert.equal(reconnects, 2, "teardown must release the reconnect triggers");
});

test("the gate is wired from the active view down to the chat runtime", async () => {
  const [app, profileChat] = await Promise.all([read("src/App.jsx"), read("src/ProfileChat.jsx")]);

  // App owns the answer to "is the Bibi surface active", and hands it down.
  assert.match(app, /const bibiSurface = isBibiSurface\(view\);/);
  assert.match(app, /legacyRealtime=\{!bibiSurface\}/);

  // ProfileChat keeps the effect unconditional and gates the request inside it.
  assert.match(profileChat, /import \{ startLegacyRealtime \} from "\.\/legacyRealtime\.js";/);
  assert.match(profileChat, /startLegacyRealtime\(\{\s*enabled: legacyRealtime,/);
  assert.match(profileChat, /if \(stopped \|\| !legacyRealtime\) return;/);
  assert.match(profileChat, /\}, \[legacyRealtime, onActivityChange,/);
  assert.equal(
    /useEffect\(\(\) => \{\s*const gateway = new HermesGateway\(\);/.test(profileChat),
    true,
    "the gateway effect must still run on every view so the gate lives inside it",
  );
});

test("legacy gateway consumers are not mounted behind any Bibi owner-data view", async () => {
  const app = await read("src/App.jsx");

  assert.match(app, /\{!bibiSurface && view === "meeting" && activeMeetings\.length > 0 && \(/);
  assert.match(app, /\{view === "terminal" && \(/);
  assert.match(app, /\{!bibiSurface && \(\s*<section[\s\S]*?persistent-chat-runtime/);
});
