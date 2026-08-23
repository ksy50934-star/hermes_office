import assert from "node:assert/strict";
import test from "node:test";

import { ServerEnvError, loadServerEnv } from "../api/_lib/serverEnv.js";
import {
  authenticateConnector,
  bearerToken,
  hashConnectorToken,
} from "../api/_lib/connectorAuth.js";
import { authenticateUser } from "../api/_lib/userAuth.js";
import { handleHeartbeat, handlePoll, handleReport } from "../api/_lib/handlers.js";
import { WORK_STATUS } from "../src/bibi/workLifecycle.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "22222222-2222-2222-2222-222222222222";
const NODE = "33333333-3333-3333-3333-333333333333";
const TOKEN = "connector-token-value";

// ---------------------------------------------------------------------------
// Server environment
// ---------------------------------------------------------------------------

test("the server env requires both Supabase values", () => {
  assert.throws(() => loadServerEnv({ SUPABASE_URL: "https://x.supabase.co" }), (error) => error.code === "MISSING_ENV");
  assert.throws(() => loadServerEnv({ SUPABASE_SERVICE_ROLE_KEY: "k" }), (error) => error.code === "MISSING_ENV");
  const env = loadServerEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.equal(env.supabaseUrl, "https://x.supabase.co");
  assert.equal(env.supabaseServiceRoleKey, "k");
});

test("a client-visible alias of a privileged key is fatal on the server too", () => {
  assert.throws(
    () => loadServerEnv({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      VITE_SUPABASE_SERVICE_ROLE_KEY: "k",
    }),
    (error) => error instanceof ServerEnvError && error.code === "PRIVILEGED_KEY_EXPOSED",
  );
});

// ---------------------------------------------------------------------------
// Connector authentication
// ---------------------------------------------------------------------------

function credentialStore(overrides = {}) {
  const credential = {
    id: "cred-1",
    owner_id: OWNER,
    connector_node_id: NODE,
    token_hash: hashConnectorToken(TOKEN),
    revoked_at: null,
    ...overrides,
  };
  return {
    lookups: [],
    async findConnectorCredential(tokenHash) {
      this.lookups.push(tokenHash);
      return tokenHash === credential.token_hash ? credential : null;
    },
  };
}

test("the bearer token is parsed only from the Authorization header", () => {
  assert.equal(bearerToken({ authorization: "Bearer abc" }), "abc");
  assert.equal(bearerToken({ Authorization: "bearer  abc  " }), "abc");
  assert.equal(bearerToken({ authorization: "Basic abc" }), "");
  assert.equal(bearerToken({}), "");
});

test("tokens are looked up by hash, never stored or compared in plaintext", async () => {
  const store = credentialStore();
  const auth = await authenticateConnector({ headers: { authorization: `Bearer ${TOKEN}` }, store });

  assert.equal(auth.ok, true);
  assert.equal(auth.ownerId, OWNER);
  assert.equal(auth.connectorNodeId, NODE);
  assert.deepEqual(store.lookups, [hashConnectorToken(TOKEN)]);
  assert.ok(!store.lookups[0].includes(TOKEN));
  assert.match(store.lookups[0], /^[0-9a-f]{64}$/);
});

test("a missing, wrong or revoked token is refused with 401", async () => {
  const missing = await authenticateConnector({ headers: {}, store: credentialStore() });
  assert.deepEqual([missing.ok, missing.status, missing.code], [false, 401, "MISSING_TOKEN"]);

  const wrong = await authenticateConnector({ headers: { authorization: "Bearer nope" }, store: credentialStore() });
  assert.deepEqual([wrong.ok, wrong.status, wrong.code], [false, 401, "INVALID_TOKEN"]);

  const revoked = await authenticateConnector({
    headers: { authorization: `Bearer ${TOKEN}` },
    store: credentialStore({ revoked_at: "2026-08-01T00:00:00.000Z" }),
  });
  assert.deepEqual([revoked.ok, revoked.status, revoked.code], [false, 401, "REVOKED_TOKEN"]);
});

test("an unverified user JWT is never trusted for its claims", async () => {
  const supabase = { auth: { async getUser() { return { data: null, error: { message: "bad jwt" } }; } } };
  const result = await authenticateUser({ headers: { authorization: "Bearer forged" }, supabase });
  assert.deepEqual([result.ok, result.status, result.code], [false, 401, "INVALID_SESSION"]);

  const verified = { auth: { async getUser() { return { data: { user: { id: OWNER } }, error: null }; } } };
  assert.deepEqual(await authenticateUser({ headers: { authorization: "Bearer real" }, supabase: verified }), {
    ok: true,
    ownerId: OWNER,
  });
});

// ---------------------------------------------------------------------------
// Handler ownership and lifecycle enforcement
// ---------------------------------------------------------------------------

function fakeStore({ workItems = {} } = {}) {
  const calls = { events: [], results: [], evidence: [], saved: [], released: [], heartbeats: [], claims: [] };
  const eventKeys = new Set();
  return {
    calls,
    async recordHeartbeat(payload) {
      calls.heartbeats.push(payload);
    },
    async claimWork(payload) {
      calls.claims.push(payload);
      return [];
    },
    async loadWorkItem({ ownerId, workItemId }) {
      const item = workItems[workItemId];
      // Mirrors the real query: scoped by owner, so another account's row is
      // simply absent rather than forbidden.
      return item && item.ownerId === ownerId ? { ...item } : null;
    },
    async recordEvent({ workItemId, eventId, ...rest }) {
      const key = `${workItemId}:${eventId}`;
      if (eventKeys.has(key)) return { duplicate: true };
      eventKeys.add(key);
      calls.events.push({ workItemId, eventId, ...rest });
      return { duplicate: false };
    },
    async insertResult(payload) {
      calls.results.push(payload);
      return { id: "result-1" };
    },
    async insertEvidence(payload) {
      calls.evidence.push(payload);
    },
    async releaseLease(payload) {
      calls.released.push(payload);
    },
    async saveWorkItem(payload) {
      calls.saved.push(payload);
    },
  };
}

function runningWork(overrides = {}) {
  return {
    id: "work-1",
    ownerId: OWNER,
    clientRequestId: "req-1",
    title: "보고서",
    brief: "",
    status: WORK_STATUS.RUNNING,
    profileId: "bibi-01",
    leaseId: "lease-1",
    nodeId: NODE,
    leaseExpiresAt: "2026-08-24T00:05:00.000Z",
    attempt: 1,
    resultId: null,
    error: null,
    blockedReason: null,
    appliedEventIds: [],
    ...overrides,
  };
}

const AUTH = { ok: true, ownerId: OWNER, connectorNodeId: NODE, credentialId: "cred-1" };

test("a connector cannot report against another account's work item", async () => {
  const store = fakeStore({ workItems: { "work-1": runningWork({ ownerId: OTHER_OWNER }) } });
  const result = await handleReport({
    auth: AUTH,
    body: { id: "e1", type: "succeed", workItemId: "work-1", summary: "done" },
    store,
  });

  assert.equal(result.status, 404);
  assert.equal(result.body.error, "WORK_ITEM_NOT_FOUND");
  assert.deepEqual(store.calls.saved, [], "nothing may be written for a foreign work item");
  assert.deepEqual(store.calls.events, []);
});

test("a successful report stores the result, the evidence and the new status", async () => {
  const store = fakeStore({ workItems: { "work-1": runningWork() } });
  const evidence = [{ kind: "log", label: "실행 로그", sha256: "a".repeat(64), byteSize: 2, inlineExcerpt: "ok" }];
  const result = await handleReport({
    auth: AUTH,
    body: { id: "e1", type: "succeed", workItemId: "work-1", summary: "완료", detail: "", evidence },
    store,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.status, WORK_STATUS.SUCCEEDED);
  assert.equal(store.calls.results.length, 1);
  assert.equal(store.calls.evidence.length, 1);
  assert.equal(store.calls.saved[0].work.resultId, "result-1");
  assert.equal(store.calls.saved[0].work.leaseId, null);
  assert.equal(store.calls.released.length, 1, "a finished work item must release its lease");
});

test("a redelivered report is a duplicate and applies nothing a second time", async () => {
  const store = fakeStore({ workItems: { "work-1": runningWork() } });
  const body = { id: "e1", type: "succeed", workItemId: "work-1", summary: "완료" };

  const first = await handleReport({ auth: AUTH, body, store });
  const second = await handleReport({ auth: AUTH, body, store });

  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(store.calls.results.length, 1, "the result must be written exactly once");
  assert.equal(store.calls.saved.length, 1);
});

test("an illegal transition is refused with 409 instead of corrupting the state", async () => {
  const store = fakeStore({ workItems: { "work-1": runningWork({ status: WORK_STATUS.INTAKE }) } });
  const result = await handleReport({
    auth: AUTH,
    body: { id: "e1", type: "succeed", workItemId: "work-1", summary: "완료" },
    store,
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, "INVALID_TRANSITION");
  assert.deepEqual(store.calls.saved, []);
});

test("a connector may not report an owner-only event", async () => {
  const store = fakeStore({ workItems: { "work-1": runningWork() } });
  for (const type of ["assign", "cancel", "unblock", "lease"]) {
    const result = await handleReport({ auth: AUTH, body: { id: `e-${type}`, type, workItemId: "work-1" }, store });
    assert.equal(result.status, 400, `${type} must be refused`);
    assert.equal(result.body.error, "UNSUPPORTED_EVENT");
  }
  assert.deepEqual(store.calls.saved, []);
});

test("a failure report requires a reason, so a job cannot fail silently", async () => {
  const store = fakeStore({ workItems: { "work-1": runningWork() } });
  const result = await handleReport({ auth: AUTH, body: { id: "e1", type: "fail", workItemId: "work-1" }, store });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "MISSING_REASON");
});

test("a heartbeat keeps the executable physical profiles and drops the rest", async () => {
  const store = fakeStore();
  const result = await handleHeartbeat({
    auth: AUTH,
    body: {
      nodeLabel: "mac",
      // `default` is the CEO runtime and is kept. The literal `bibi-01`
      // directory is the rollback original and must be dropped, not stored as
      // if the CEO were reachable.
      reportedProfileIds: ["default", "bibi-01", "hermes-director", "bibi-18", "bibi-19"],
      localRuntimeReachable: true,
    },
    store,
  });

  assert.deepEqual(result.body.acceptedProfileIds, ["default", "bibi-18"]);
  assert.deepEqual(result.body.droppedProfileIds, ["bibi-01", "hermes-director", "bibi-19"]);
  assert.deepEqual(store.calls.heartbeats[0].reportedProfileIds, ["default", "bibi-18"]);
  assert.equal(store.calls.heartbeats[0].ownerId, OWNER);
});

test("a poll command carries both the role slot and the physical profile", async () => {
  const store = fakeStore();
  store.claimWork = async () => [
    { workItemId: "w1", profileId: "bibi-01", title: "t", brief: "", attempt: 1, leaseId: "l1", leaseExpiresAt: "2026-08-24T00:05:00.000Z" },
    { workItemId: "w2", profileId: "bibi-07", title: "t", brief: "", attempt: 1, leaseId: "l2", leaseExpiresAt: "2026-08-24T00:05:00.000Z" },
  ];
  const result = await handlePoll({ auth: AUTH, body: {}, store, maxBatch: 4 });

  assert.deepEqual(
    result.body.commands.map((command) => [command.profileId, command.executionProfileId]),
    [["bibi-01", "default"], ["bibi-07", "bibi-07"]],
  );
});

test("stored evidence records the physical profile that produced it", async () => {
  const store = fakeStore({ workItems: { "work-1": runningWork({ profileId: "bibi-01" }) } });
  await handleReport({
    auth: AUTH,
    body: {
      id: "e1",
      type: "succeed",
      workItemId: "work-1",
      summary: "완료",
      evidence: [{ kind: "log", label: "l", sha256: "a".repeat(64), byteSize: 1, inlineExcerpt: "x" }],
    },
    store,
  });

  assert.equal(store.calls.evidence[0].executionProfileId, "default");
});

test("polling is scoped to the token's owner and node, and the batch size is capped", async () => {
  const store = fakeStore();
  await handlePoll({ auth: AUTH, body: { max: 999 }, store, maxBatch: 4 });
  assert.equal(store.calls.claims[0].ownerId, OWNER);
  assert.equal(store.calls.claims[0].connectorNodeId, NODE);
  assert.equal(store.calls.claims[0].max, 4);

  await handlePoll({ auth: AUTH, body: { max: 2 }, store, maxBatch: 4 });
  assert.equal(store.calls.claims[1].max, 2);

  await handlePoll({ auth: AUTH, body: {}, store, maxBatch: 4 });
  assert.equal(store.calls.claims[2].max, 4);
});
