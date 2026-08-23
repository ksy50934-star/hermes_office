import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_STATE,
  DISPATCH_MODE,
  HEARTBEAT_INTERVAL_MS,
  describeConnectorHealth,
  describeProfileAvailability,
} from "../src/bibi/connectionState.js";
import { BIBI_PROFILE_IDS, EXECUTION_PROFILE_IDS } from "../src/bibi/roster.js";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");

function heartbeatAgo(ms) {
  return new Date(NOW - ms).toISOString();
}

test("a fresh heartbeat is online", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(5_000), now: NOW });
  assert.equal(health.state, CONNECTOR_STATE.ONLINE);
  assert.equal(health.canDispatchLive, true);
  assert.equal(health.ageMs, 5_000);
});

test("a heartbeat that is late but not gone reads as stale, and stale never claims live dispatch", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(HEARTBEAT_INTERVAL_MS * 3), now: NOW });
  assert.equal(health.state, CONNECTOR_STATE.STALE);
  assert.equal(health.canDispatchLive, false);
});

test("a long-gone heartbeat is offline", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(HEARTBEAT_INTERVAL_MS * 20), now: NOW });
  assert.equal(health.state, CONNECTOR_STATE.OFFLINE);
  assert.equal(health.canDispatchLive, false);
  assert.match(health.label, /OFFLINE/);
});

test("no heartbeat at all is UNKNOWN, never online", () => {
  for (const lastHeartbeatAt of [null, undefined, "", "not-a-date", 0]) {
    const health = describeConnectorHealth({ lastHeartbeatAt, now: NOW });
    assert.equal(health.state, CONNECTOR_STATE.UNKNOWN, `${String(lastHeartbeatAt)} must be unknown`);
    assert.equal(health.canDispatchLive, false);
    assert.equal(health.ageMs, null);
  }
});

test("a heartbeat from the future is clamped rather than trusted as fresher than now", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(-60_000), now: NOW });
  assert.equal(health.ageMs, 0);
  assert.equal(health.state, CONNECTOR_STATE.ONLINE);
});

test("an online connector that reports the profile can dispatch live", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(1_000), now: NOW });
  const availability = describeProfileAvailability({
    profileId: "bibi-01",
    health,
    reportedProfileIds: EXECUTION_PROFILE_IDS,
  });
  assert.equal(availability.dispatch, DISPATCH_MODE.LIVE);
  assert.equal(availability.available, true);
  assert.match(availability.label, /온라인|ONLINE/);
});

test("when the Mac is offline every profile queues honestly instead of showing as running", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(HEARTBEAT_INTERVAL_MS * 20), now: NOW });
  for (const profileId of BIBI_PROFILE_IDS) {
    const availability = describeProfileAvailability({ profileId, health, reportedProfileIds: EXECUTION_PROFILE_IDS });
    assert.equal(availability.available, false, `${profileId} must not read as available`);
    assert.equal(availability.dispatch, DISPATCH_MODE.QUEUED);
    assert.match(availability.label, /OFFLINE/);
    assert.match(availability.detail, /대기열|큐/);
  }
});

test("an online Mac with a missing profile queues that profile only", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(1_000), now: NOW });
  const reported = EXECUTION_PROFILE_IDS.filter((id) => id !== "bibi-09");
  const missing = describeProfileAvailability({ profileId: "bibi-09", health, reportedProfileIds: reported });
  assert.equal(missing.available, false);
  assert.equal(missing.dispatch, DISPATCH_MODE.QUEUED);
  assert.equal(missing.reason, "PROFILE_NOT_REPORTED");

  const present = describeProfileAvailability({ profileId: "bibi-10", health, reportedProfileIds: reported });
  assert.equal(present.dispatch, DISPATCH_MODE.LIVE);
});

test("a profile outside the roster is blocked, not queued", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(1_000), now: NOW });
  for (const profileId of ["default", "hermes-director", "bibi-19", ""]) {
    const availability = describeProfileAvailability({ profileId, health, reportedProfileIds: EXECUTION_PROFILE_IDS });
    assert.equal(availability.dispatch, DISPATCH_MODE.BLOCKED, `${profileId} must be blocked`);
    assert.equal(availability.available, false);
  }
});

test("an unknown connector state never reports a profile as available", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: null, now: NOW });
  const availability = describeProfileAvailability({
    profileId: "bibi-01",
    health,
    reportedProfileIds: EXECUTION_PROFILE_IDS,
  });
  assert.equal(availability.available, false);
  assert.equal(availability.dispatch, DISPATCH_MODE.QUEUED);
  assert.equal(availability.reason, "CONNECTOR_UNKNOWN");
});

test("a missing profile report is not treated as a full roster", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(1_000), now: NOW });
  for (const reportedProfileIds of [null, undefined, []]) {
    const availability = describeProfileAvailability({ profileId: "bibi-01", health, reportedProfileIds });
    assert.equal(availability.available, false);
    assert.equal(availability.dispatch, DISPATCH_MODE.QUEUED);
  }
});

test("the CEO role slot is available when the Mac reports its `default` runtime", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(1_000), now: NOW });

  const viaDefault = describeProfileAvailability({
    profileId: "bibi-01",
    health,
    reportedProfileIds: ["default"],
  });
  assert.equal(viaDefault.available, true);
  assert.equal(viaDefault.dispatch, DISPATCH_MODE.LIVE);
  assert.equal(viaDefault.executionProfileId, "default");
});

test("the rollback bibi-01 directory does not make the CEO available", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(1_000), now: NOW });

  // The Mac reports a physical directory literally named bibi-01. That is the
  // rollback original; treating it as the CEO runtime would run the recovery
  // copy as if it were live.
  const availability = describeProfileAvailability({
    profileId: "bibi-01",
    health,
    reportedProfileIds: ["bibi-01"],
  });
  assert.equal(availability.available, false);
  assert.equal(availability.dispatch, DISPATCH_MODE.QUEUED);
  assert.equal(availability.reason, "PROFILE_NOT_REPORTED");
});

test("availability always names the physical profile the work would run on", () => {
  const health = describeConnectorHealth({ lastHeartbeatAt: heartbeatAgo(1_000), now: NOW });
  for (const profileId of BIBI_PROFILE_IDS) {
    const availability = describeProfileAvailability({ profileId, health, reportedProfileIds: EXECUTION_PROFILE_IDS });
    assert.equal(availability.executionProfileId, profileId === "bibi-01" ? "default" : profileId);
  }
});
