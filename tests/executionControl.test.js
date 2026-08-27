import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXECUTION_CONTROL_PURPOSE,
  executionControlActions,
  executionDispatchNotice,
  summarizeConnector,
  summarizeExecutionControl,
  summarizeRuntimeHealth,
  summarizeWorkQueue,
  workStatusLabel,
} from "../src/bibi/executionControl.js";
import { CONNECTOR_STATE, HEARTBEAT_INTERVAL_MS, describeConnectorHealth } from "../src/bibi/connectionState.js";
import { WORK_STATUS } from "../src/bibi/workLifecycle.js";
import { createCloudSystemAdapter } from "../src/bibi/systemAdapter.js";

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const DASHBOARD = new URL("../src/HermesDashboard.jsx", import.meta.url);
const APP = new URL("../src/App.jsx", import.meta.url);

function connectorAt(offsetMs) {
  const lastHeartbeatAt = new Date(NOW - offsetMs).toISOString();
  return {
    node: { label: "sam-mac", last_heartbeat_at: lastHeartbeatAt, connector_mode: "outbound-local-mac" },
    health: describeConnectorHealth({ lastHeartbeatAt, now: NOW }),
    reportedProfileIds: ["default", "bibi-02"],
  };
}

test("connector health is read from the field describeConnectorHealth actually sets", () => {
  // The regression this closes: the console read `connector.health.status`,
  // which is never set, so a connected Mac still rendered UNKNOWN.
  const connector = connectorAt(HEARTBEAT_INTERVAL_MS);
  assert.equal(connector.health.status, undefined, "guard: there is no `status` field");
  assert.equal(connector.health.state, CONNECTOR_STATE.ONLINE);

  const summary = summarizeConnector(connector, { now: NOW });
  assert.equal(summary.state, CONNECTOR_STATE.ONLINE);
  assert.equal(summary.canDispatchLive, true);
  assert.equal(summary.mode, "outbound-local-mac");
  assert.equal(summary.reportedProfiles, 2);
});

test("the system page reports the same connector state, not a permanent unknown", () => {
  const connector = connectorAt(HEARTBEAT_INTERVAL_MS);
  const adapter = createCloudSystemAdapter({ roster: [], runtime: { health: [] }, connector });
  assert.equal(adapter.connection, CONNECTOR_STATE.ONLINE);
  assert.equal(adapter.workspace.services.connector, CONNECTOR_STATE.ONLINE);
});

test("a stale and an absent connector are told apart, and neither reads as online", () => {
  assert.equal(summarizeConnector(connectorAt(HEARTBEAT_INTERVAL_MS * 4), { now: NOW }).state, CONNECTOR_STATE.STALE);
  assert.equal(summarizeConnector(connectorAt(HEARTBEAT_INTERVAL_MS * 20), { now: NOW }).state, CONNECTOR_STATE.OFFLINE);

  const never = summarizeConnector(null, { now: NOW });
  assert.equal(never.state, CONNECTOR_STATE.UNKNOWN);
  assert.equal(never.canDispatchLive, false);
  assert.equal(never.lastHeartbeatAt, null);
});

test("a bare connector node is recomputed from its heartbeat rather than trusted blind", () => {
  const node = { last_heartbeat_at: new Date(NOW - HEARTBEAT_INTERVAL_MS).toISOString() };
  assert.equal(summarizeConnector({ node }, { now: NOW }).state, CONNECTOR_STATE.ONLINE);
});

test("the queue is counted by what the operator can act on", () => {
  const summary = summarizeWorkQueue([
    { status: WORK_STATUS.INTAKE, created_at: "2026-08-26T09:00:00.000Z" },
    { status: WORK_STATUS.ASSIGNED, created_at: "2026-08-26T10:00:00.000Z" },
    { status: WORK_STATUS.LEASED, created_at: "2026-08-26T11:00:00.000Z" },
    { status: WORK_STATUS.RUNNING },
    { status: WORK_STATUS.BLOCKED },
    { status: WORK_STATUS.FAILED },
    { status: WORK_STATUS.SUCCEEDED },
    { status: WORK_STATUS.CANCELLED },
  ]);
  assert.equal(summary.total, 8);
  assert.equal(summary.waiting, 3, "intake, assigned and leased all read as waiting");
  assert.equal(summary.running, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(new Date(summary.oldestWaitingAt).toISOString(), "2026-08-26T09:00:00.000Z");
});

test("an empty queue counts zero rather than reading as healthy activity", () => {
  const summary = summarizeWorkQueue([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.waiting, 0);
  assert.equal(summary.oldestWaitingAt, null);
  assert.deepEqual(summarizeWorkQueue(null), summary);
});

test("every work status the lifecycle can hold has a Korean label", () => {
  for (const status of Object.values(WORK_STATUS)) {
    const label = workStatusLabel(status);
    assert.ok(label && label !== status, `${status} has no label`);
  }
  assert.equal(workStatusLabel("something-new"), "something-new", "an unknown status is shown, not hidden");
});

test("a profile that never reported is counted as missing, never as healthy", () => {
  const runtime = summarizeRuntimeHealth([
    { profile_id: "bibi-01", gateway_status: "running", model: "claude-opus-5", provider: "anthropic", active_sessions: 2, collected_at: "2026-08-26T11:00:00.000Z" },
    { profile_id: "bibi-02", gateway_status: "stopped", health_error: "gateway unreachable", active_sessions: 0, collected_at: "2026-08-26T11:30:00.000Z" },
  ], 18);
  assert.equal(runtime.reporting, 2);
  assert.equal(runtime.expected, 18);
  assert.equal(runtime.missing, 16);
  assert.equal(runtime.gatewayRunning, 1);
  assert.equal(runtime.errors, 1);
  assert.equal(runtime.activeSessions, 2);
  assert.equal(runtime.model, "claude-opus-5");
  assert.equal(runtime.collectedAt, "2026-08-26T11:30:00.000Z", "the freshest collection wins");
});

test("a disconnected Mac is the first thing the operator is told, and work is not lost", () => {
  const control = summarizeExecutionControl({
    connector: connectorAt(HEARTBEAT_INTERVAL_MS * 20),
    workItems: [{ status: WORK_STATUS.ASSIGNED, created_at: "2026-08-26T09:00:00.000Z" }],
    runtime: { health: [] },
    now: NOW,
  });
  assert.equal(control.actions[0].id, "connector-down");
  assert.equal(control.actions[0].tone, "critical");
  assert.match(control.actions[0].detail, /queue에 안전하게 쌓이지만/);
  assert.ok(control.actions.some((action) => action.id === "work-stranded"));
  assert.match(control.dispatchNotice, /queue에 보존/);
});

test("blocked work outranks failed work, because only one of them stops the queue", () => {
  const actions = executionControlActions({
    connector: summarizeConnector(connectorAt(HEARTBEAT_INTERVAL_MS), { now: NOW }),
    work: summarizeWorkQueue([{ status: WORK_STATUS.BLOCKED }, { status: WORK_STATUS.FAILED }]),
    runtime: summarizeRuntimeHealth([], 0),
  });
  const ids = actions.map((action) => action.id);
  assert.ok(ids.indexOf("work-blocked") < ids.indexOf("work-failed"));
  assert.match(actions[0].title, /차단된 업무 1건/);
});

test("a healthy office says so explicitly instead of rendering an empty panel", () => {
  const control = summarizeExecutionControl({
    connector: connectorAt(HEARTBEAT_INTERVAL_MS),
    workItems: [{ status: WORK_STATUS.SUCCEEDED }],
    runtime: { health: [{ profile_id: "bibi-01", gateway_status: "running", collected_at: "2026-08-26T11:00:00.000Z" }] },
    expectedProfiles: 1,
    now: NOW,
  });
  assert.equal(control.actions.length, 1);
  assert.equal(control.actions[0].id, "all-clear");
  assert.equal(control.actions[0].tone, "ok");
  assert.match(control.dispatchNotice, /등록 즉시 실행/);
});

test("every action names the problem and the move that clears it", () => {
  const control = summarizeExecutionControl({
    connector: connectorAt(HEARTBEAT_INTERVAL_MS * 4),
    workItems: [{ status: WORK_STATUS.BLOCKED }, { status: WORK_STATUS.FAILED }],
    runtime: { health: [{ profile_id: "bibi-01", gateway_status: "running", health_error: "x" }] },
    expectedProfiles: 18,
    now: NOW,
  });
  assert.ok(control.actions.length >= 4);
  for (const action of control.actions) {
    assert.ok(action.id && action.title && action.detail, "an action must be actionable");
    assert.ok(["critical", "warning", "ok"].includes(action.tone));
    assert.ok(action.detail.length > 20, `${action.id} does not say what to do`);
  }
});

test("the surface states its purpose in Korean", () => {
  assert.equal(EXECUTION_CONTROL_PURPOSE, summarizeExecutionControl({ now: NOW }).purpose);
  assert.match(EXECUTION_CONTROL_PURPOSE, /[가-힣]/);
  assert.match(EXECUTION_CONTROL_PURPOSE, /실행/);
});

test("filing is always allowed, and the operator is told which of the two happens", () => {
  const online = summarizeConnector(connectorAt(HEARTBEAT_INTERVAL_MS), { now: NOW });
  const offline = summarizeConnector(null, { now: NOW });
  assert.notEqual(executionDispatchNotice(online), executionDispatchNotice(offline));
  assert.match(executionDispatchNotice(online), /즉시 실행/);
  assert.match(executionDispatchNotice(offline), /보존/);
});

/** Comments explain what the old naming was; only shipped strings matter here. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("the Hermes Console naming is gone from the surface and the navigation", async () => {
  const [dashboard, app] = await Promise.all([readFile(DASHBOARD, "utf8"), readFile(APP, "utf8")]);
  const shipped = withoutComments(dashboard);
  const shippedApp = withoutComments(app);
  assert.ok(!shipped.includes("Hermes 실행 콘솔"), "the console title must be gone");
  assert.ok(!shipped.includes("CloudHermesConsole"), "the console component must be gone");
  assert.ok(!shippedApp.includes("Hermes 콘솔"), "the nav entry must be gone");
  assert.ok(!shippedApp.includes("Hermes 운영 콘솔"), "the page title must be gone");
  assert.match(shippedApp, /\["terminal", "실행 관제"/);
  assert.match(shipped, /aria-label="실행 관제"/);
});

test("the surface reads connector state through the summary, never the dead field", async () => {
  const dashboard = await readFile(DASHBOARD, "utf8");
  assert.ok(!/connector\?\.health\?\.status/.test(dashboard));
  assert.match(dashboard, /summarizeExecutionControl/);
  const adapters = await Promise.all([
    readFile(new URL("../src/bibi/systemAdapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/bibi/executionConsoleAdapter.js", import.meta.url), "utf8"),
  ]);
  for (const source of adapters) {
    assert.ok(!/health\?\.status/.test(source), "an adapter still reads the field that does not exist");
  }
});
