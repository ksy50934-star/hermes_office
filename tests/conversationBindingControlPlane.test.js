/**
 * The API half of binding onboarding.
 *
 * Two credentials, two routes, one rule: the owner's route can only ask, and the
 * connector's route is the only one that can answer. These tests drive the
 * handlers against a store double, so what is asserted is the shape of the call
 * that reaches the database — which is where the guard trigger then makes the
 * same rule true a second time.
 *
 * The store double deliberately records every argument. Most of the failures
 * worth catching here are not "the handler returned the wrong status" but "the
 * handler passed something through that it should have refused", and the only
 * way to see that is to look at what it asked the database to do.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  handleBindingVerification,
  handleConversationBinding,
  handlePendingBindings,
  handleTelegramSessionDiscovery,
} from "../api/_lib/handlers.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "22222222-2222-2222-2222-222222222222";
const NODE = "33333333-3333-3333-3333-333333333333";
const CONVERSATION = "44444444-4444-4444-4444-444444444444";
const BINDING = "55555555-5555-5555-5555-555555555555";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function storeDouble(overrides = {}) {
  const calls = [];
  const record = (name) => async (input) => {
    calls.push({ name, input });
    const handler = overrides[name];
    if (typeof handler === "function") return handler(input);
    return handler ?? {};
  };
  return {
    calls,
    requestConversationBinding: record("requestConversationBinding"),
    cancelConversationBinding: record("cancelConversationBinding"),
    verifyConversationBinding: record("verifyConversationBinding"),
    failConversationBinding: record("failConversationBinding"),
    listPendingBindings: record("listPendingBindings"),
    recordTelegramSessionScan: record("recordTelegramSessionScan"),
  };
}

const validRequest = {
  action: "request",
  conversationId: CONVERSATION,
  channel: "telegram",
  channelAccountId: "acct-1",
  externalConversationId: "chat-9",
  hermesSessionId: "sess-abc",
  clientRequestId: "req-1",
};

// ---------------------------------------------------------------------------
// Browser initiation is pending-only
// ---------------------------------------------------------------------------

test("an owner request creates a binding request and never names a state", async () => {
  const store = storeDouble({
    requestConversationBinding: { bindingId: BINDING, bindingState: "pending", duplicate: false, retried: false },
  });

  const result = await handleConversationBinding({ auth: { ownerId: OWNER }, body: validRequest, store });

  assert.equal(result.status, 200);
  assert.equal(result.body.bindingState, "pending");
  const [call] = store.calls;
  assert.equal(call.name, "requestConversationBinding");
  assert.equal(call.input.ownerId, OWNER);
  // Nothing in the argument list can express "verified".
  assert.deepEqual(Object.keys(call.input).sort(), [
    "channel", "channelAccountId", "clientRequestId", "conversationId",
    "externalConversationId", "hermesSessionId", "ownerId",
  ]);
});

test("a browser that asks for a verified binding is not granted one", async () => {
  const store = storeDouble({
    requestConversationBinding: { bindingId: BINDING, bindingState: "pending", duplicate: false },
  });

  await handleConversationBinding({
    auth: { ownerId: OWNER },
    body: {
      ...validRequest,
      bindingState: "verified",
      verified: true,
      verifiedAt: "2026-08-27T00:00:00.000Z",
      verifiedByNodeId: NODE,
    },
    store,
  });

  const [call] = store.calls;
  for (const forbidden of ["bindingState", "verified", "verifiedAt", "verifiedByNodeId"]) {
    assert.equal(call.input[forbidden], undefined, `${forbidden} must not reach the database`);
  }
});

test("the owner route has no verification action at all", async () => {
  const store = storeDouble();
  const result = await handleConversationBinding({
    auth: { ownerId: OWNER },
    body: { ...validRequest, action: "verify" },
    store,
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "UNSUPPORTED_ACTION");
  assert.equal(store.calls.length, 0);
});

test("an incomplete identity is refused rather than half-bound", async () => {
  const store = storeDouble();
  for (const missing of ["channelAccountId", "externalConversationId", "hermesSessionId"]) {
    const result = await handleConversationBinding({
      auth: { ownerId: OWNER },
      body: { ...validRequest, [missing]: "" },
      store,
    });
    assert.equal(result.status, 400, `${missing} must be required`);
    assert.equal(result.body.error, "INCOMPLETE_BINDING_IDENTITY");
  }
  assert.equal(store.calls.length, 0);
});

test("only Telegram bindings can be requested", async () => {
  const store = storeDouble();
  const result = await handleConversationBinding({
    auth: { ownerId: OWNER },
    body: { ...validRequest, channel: "slack" },
    store,
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "UNSUPPORTED_CHANNEL");
  assert.equal(store.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Idempotency, retry and cancel
// ---------------------------------------------------------------------------

test("the same submission twice resolves to the same binding", async () => {
  const seen = new Map();
  const store = storeDouble({
    requestConversationBinding: ({ clientRequestId }) => {
      const duplicate = seen.has(clientRequestId);
      seen.set(clientRequestId, true);
      return { bindingId: BINDING, bindingState: "pending", duplicate, retried: false };
    },
  });

  const first = await handleConversationBinding({ auth: { ownerId: OWNER }, body: validRequest, store });
  const second = await handleConversationBinding({ auth: { ownerId: OWNER }, body: validRequest, store });

  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(first.body.bindingId, second.body.bindingId);
});

test("retry is the same request against the same row", async () => {
  const store = storeDouble({
    requestConversationBinding: { bindingId: BINDING, bindingState: "pending", duplicate: false, retried: true },
  });
  const result = await handleConversationBinding({
    auth: { ownerId: OWNER },
    body: { ...validRequest, action: "retry" },
    store,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.retried, true);
  assert.equal(result.body.bindingState, "pending");
});

test("cancelling is owner scoped and idempotent", async () => {
  const store = storeDouble({
    cancelConversationBinding: { bindingId: BINDING, bindingState: "unbound", alreadyUnbound: true },
  });
  const result = await handleConversationBinding({
    auth: { ownerId: OWNER },
    body: { action: "cancel", bindingId: BINDING },
    store,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.bindingState, "unbound");
  assert.equal(store.calls[0].input.ownerId, OWNER);
});

test("a binding that belongs to another account reads as absent", async () => {
  const store = storeDouble({
    cancelConversationBinding: () => {
      const error = new Error("binding not found for owner");
      error.code = "BINDING_NOT_FOUND";
      throw error;
    },
  });
  const result = await handleConversationBinding({
    auth: { ownerId: OTHER_OWNER },
    body: { action: "cancel", bindingId: BINDING },
    store,
  });
  assert.equal(result.status, 404);
  assert.equal(result.body.error, "BINDING_NOT_FOUND");
});

test("a conflicting Telegram thread is a conflict, not a silent rebind", async () => {
  const store = storeDouble({
    requestConversationBinding: () => {
      const error = new Error("this Telegram conversation is already bound to another conversation");
      error.code = "BINDING_CONFLICT";
      throw error;
    },
  });
  const result = await handleConversationBinding({ auth: { ownerId: OWNER }, body: validRequest, store });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "BINDING_CONFLICT");
});

// ---------------------------------------------------------------------------
// Connector verification
// ---------------------------------------------------------------------------

test("the connector's work list is its own owner's pending bindings only", async () => {
  const store = storeDouble({
    listPendingBindings: [{ bindingId: BINDING, executionProfileId: "bibi-07" }],
  });
  const result = await handlePendingBindings({ auth: { ownerId: OWNER, connectorNodeId: NODE }, store });
  assert.equal(result.status, 200);
  assert.deepEqual(store.calls[0].input, { ownerId: OWNER });
  assert.equal(result.body.bindings.length, 1);
});

test("a verification carries the connector node that proved it", async () => {
  const store = storeDouble({
    verifyConversationBinding: { bindingId: BINDING, bindingState: "verified", duplicate: false },
  });

  const result = await handleBindingVerification({
    auth: { ownerId: OWNER, connectorNodeId: NODE },
    body: {
      bindingId: BINDING,
      verified: true,
      channelAccountId: "acct-1",
      externalConversationId: "chat-9",
      hermesSessionId: "sess-abc",
      executionProfileId: "bibi-07",
      evidence: { sessionState: "active", messageCount: 12, verifiedVia: "profile-local state.db" },
    },
    store,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.bindingState, "verified");
  const [call] = store.calls;
  assert.equal(call.name, "verifyConversationBinding");
  assert.equal(call.input.ownerId, OWNER);
  assert.equal(call.input.connectorNodeId, NODE);
  assert.equal(call.input.executionProfileId, "bibi-07");
});

test("a verification that does not name the identity it proved is refused", async () => {
  const store = storeDouble();
  const base = {
    bindingId: BINDING,
    verified: true,
    channelAccountId: "acct-1",
    externalConversationId: "chat-9",
    hermesSessionId: "sess-abc",
    executionProfileId: "bibi-07",
  };
  for (const missing of ["channelAccountId", "externalConversationId", "hermesSessionId"]) {
    const result = await handleBindingVerification({
      auth: { ownerId: OWNER, connectorNodeId: NODE },
      body: { ...base, [missing]: "" },
      store,
    });
    assert.equal(result.status, 400, `${missing} must be required`);
    assert.equal(result.body.error, "INCOMPLETE_VERIFICATION_IDENTITY");
  }
  assert.equal(store.calls.length, 0);
});

test("a profile that is not one this workspace executes on cannot be verified for", async () => {
  const store = storeDouble();
  for (const profile of ["bibi-01", "unknown", "bibi-99", ""]) {
    const result = await handleBindingVerification({
      auth: { ownerId: OWNER, connectorNodeId: NODE },
      body: {
        bindingId: BINDING,
        verified: true,
        channelAccountId: "acct-1",
        externalConversationId: "chat-9",
        hermesSessionId: "sess-abc",
        executionProfileId: profile,
      },
      store,
    });
    assert.equal(result.status, 400, `${profile} is not an execution profile`);
  }
  assert.equal(store.calls.length, 0);
});

test("a refusal has to carry a reason code, and blocks rather than verifies", async () => {
  const store = storeDouble({
    failConversationBinding: { bindingId: BINDING, bindingState: "blocked" },
  });

  const missingCode = await handleBindingVerification({
    auth: { ownerId: OWNER, connectorNodeId: NODE },
    body: { bindingId: BINDING, verified: false },
    store,
  });
  assert.equal(missingCode.status, 400);
  assert.equal(store.calls.length, 0);

  const refused = await handleBindingVerification({
    auth: { ownerId: OWNER, connectorNodeId: NODE },
    body: { bindingId: BINDING, verified: false, code: "SESSION_NOT_FOUND", detail: "no such session" },
    store,
  });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.verified, false);
  assert.equal(refused.body.bindingState, "blocked");
  assert.equal(store.calls[0].name, "failConversationBinding");
});

test("anything short of an explicit true is a refusal, not a verification", async () => {
  for (const value of [undefined, null, false, "true", 1, {}]) {
    const store = storeDouble({ failConversationBinding: { bindingId: BINDING, bindingState: "blocked" } });
    await handleBindingVerification({
      auth: { ownerId: OWNER, connectorNodeId: NODE },
      body: { bindingId: BINDING, verified: value, code: "SESSION_NOT_FOUND" },
      store,
    });
    assert.equal(store.calls[0]?.name, "failConversationBinding", `${JSON.stringify(value)} must not verify`);
  }
});

test("a rejected verification surfaces the database's refusal rather than a 500", async () => {
  const store = storeDouble({
    verifyConversationBinding: () => {
      const error = new Error("binding verification requires the authenticated connector");
      error.code = "BINDING_VERIFICATION_FORBIDDEN";
      throw error;
    },
  });
  const result = await handleBindingVerification({
    auth: { ownerId: OWNER, connectorNodeId: NODE },
    body: {
      bindingId: BINDING, verified: true, channelAccountId: "a",
      externalConversationId: "b", hermesSessionId: "c", executionProfileId: "bibi-07",
    },
    store,
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "BINDING_VERIFICATION_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("discovery accepts identity and reachability and drops everything else", async () => {
  const store = storeDouble({ recordTelegramSessionScan: { sessionCount: 1, eligibleCount: 1 } });

  const result = await handleTelegramSessionDiscovery({
    auth: { ownerId: OWNER, connectorNodeId: NODE },
    body: {
      organizationProfileId: "bibi-07",
      executionProfileId: "bibi-07",
      scannedAt: "2026-08-27T00:00:00.000Z",
      sessions: [{
        hermesSessionId: "sess-abc",
        channelAccountId: "acct-1",
        externalConversationId: "chat-9",
        sessionState: "active",
        messageCount: 12,
        lastActivityAt: "2026-08-26T23:00:00.000Z",
        // Everything below is content and must not survive the handler.
        body: "비밀 메시지",
        title: "저녁 약속",
        excerpt: "오늘 7시",
        messages: [{ role: "user", body: "비밀" }],
      }],
    },
    store,
  });

  assert.equal(result.status, 200);
  const [session] = store.calls[0].input.sessions;
  assert.deepEqual(Object.keys(session).sort(), [
    "channelAccountId", "externalConversationId", "hermesSessionId",
    "lastActivityAt", "messageCount", "sessionState",
  ]);
  assert.doesNotMatch(JSON.stringify(store.calls[0].input), /비밀|저녁 약속|오늘 7시/);
});

test("a scan that failed is recorded as a failure rather than as an empty result", async () => {
  const store = storeDouble({ recordTelegramSessionScan: { sessionCount: 0, eligibleCount: 0 } });
  await handleTelegramSessionDiscovery({
    auth: { ownerId: OWNER, connectorNodeId: NODE },
    body: {
      organizationProfileId: "bibi-07",
      executionProfileId: "bibi-07",
      sessions: [],
      scanError: "STATE_DB_UNREADABLE",
      scannedAt: "2026-08-27T00:00:00.000Z",
    },
    store,
  });
  assert.equal(store.calls[0].input.scanError, "STATE_DB_UNREADABLE");
  assert.deepEqual(store.calls[0].input.sessions, []);
});

test("discovery for a mismatched profile pair is refused", async () => {
  const store = storeDouble();
  for (const body of [
    { organizationProfileId: "bibi-07", executionProfileId: "bibi-08" },
    { organizationProfileId: "bibi-01", executionProfileId: "bibi-01" },
    { organizationProfileId: "unknown", executionProfileId: "bibi-07" },
  ]) {
    const result = await handleTelegramSessionDiscovery({
      auth: { ownerId: OWNER, connectorNodeId: NODE },
      body: { ...body, sessions: [] },
      store,
    });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.error, "INVALID_DISCOVERY_IDENTITY");
  }
  assert.equal(store.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Route wiring
// ---------------------------------------------------------------------------

test("the owner routes authenticate users and connector routes authenticate connectors", async () => {
  const [dispatcher, wrappers] = await Promise.all([
    read("api/index.js"),
    read("api/_lib/route.js"),
  ]);
  assert.match(wrappers, /export function userRoute[\s\S]*authenticateUser/);
  assert.match(wrappers, /export function connectorRoute[\s\S]*authenticateConnector/);
  assert.match(dispatcher, /\["chat\/binding", userRoute\(handleConversationBinding\)\]/);
  for (const [path, handler] of [
    ["connector/binding/pending", "handlePendingBindings"],
    ["connector/binding/verify", "handleBindingVerification"],
    ["connector/sessions/telegram", "handleTelegramSessionDiscovery"],
  ]) {
    assert.match(
      dispatcher,
      new RegExp(`\\["${path.replaceAll("/", "\\/")}", connectorRoute\\(${handler}\\)\\]`),
      `${path} must be connector authenticated and serve ${handler}`,
    );
  }
});

test("the connector transport has no way to request a binding for the owner", async () => {
  const transport = await read("connector/outboundTransport.js");
  assert.match(transport, /\/api\/connector\/binding\/pending/);
  assert.match(transport, /\/api\/connector\/binding\/verify/);
  assert.match(transport, /\/api\/connector\/sessions\/telegram/);
  // Owner initiation is not the connector's to perform.
  assert.doesNotMatch(transport, /\/api\/chat\/binding/);
});
