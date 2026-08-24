/**
 * What the browser is allowed to accuse the connector of, and when.
 *
 * A clean Production sign-in on an account whose connector had never been
 * started rendered two red cards: `BIBI_CONNECTOR_MODE 미설정`, and a profile
 * structure card reporting `default` absent and seventeen more unreported.
 * Every one of those statements was derived from an absence. The browser cannot
 * read the Mac's process environment — it can only read the `connector_nodes`
 * row a connector wrote — so before any connector has checked in there is no
 * evidence to judge, and the surface already reports that, once, as UNKNOWN.
 *
 * The boundary asserted here is therefore a precondition, not a wording change:
 * a real heartbeat is what makes connector mode and profile roster reportable
 * at all. Findings about the browser's own configuration are unaffected, since
 * those it can actually see.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BIBI_PROFILE_IDS } from "../src/bibi/roster.js";
import {
  MISMATCH_CODES,
  SEVERITY,
  describeConnectorProfileMismatch,
  pendingProfileMismatch,
} from "../src/bibi/profileMismatch.js";
import {
  CONNECTOR_DERIVED_CODES,
  RUNTIME_CODES,
  SUPPORTED_CONNECTOR_MODE,
  describeBrowserRuntimeMismatch,
} from "../src/bibi/runtimeEnvironment.js";
import { CONNECTOR_STATE, describeConnectorHealth } from "../src/bibi/connectionState.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

/** The environment the browser can actually assemble for itself. */
const CONFIGURED_BROWSER_ENV = Object.freeze({
  BIBI_CONNECTOR_MODE: "",
  BIBI_CONTROL_PLANE_URL: "https://bibi-workspace-18.example.app",
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_ANON_KEY: "configured",
});

const codes = (report) => report.warnings.map((item) => item.code);

// ---------------------------------------------------------------------------
// Before a heartbeat
// ---------------------------------------------------------------------------

test("a configured browser with no connector heartbeat raises no runtime warning at all", () => {
  const report = describeBrowserRuntimeMismatch(CONFIGURED_BROWSER_ENV, { connectorReported: false });

  assert.deepEqual(report.warnings, [], "an unstarted connector is not a misconfigured one");
  assert.equal(report.ok, true);
  assert.equal(report.blocking, false);
  assert.equal(report.connectorReported, false);
});

test("the connector mode findings are withheld, not merely downgraded", () => {
  const report = describeBrowserRuntimeMismatch(CONFIGURED_BROWSER_ENV, { connectorReported: false });

  // A softened warning is still a red card on a screen where nothing is wrong.
  assert.equal(codes(report).includes(RUNTIME_CODES.CONNECTOR_MODE_UNSET), false);
  assert.equal(codes(report).includes(RUNTIME_CODES.UNSUPPORTED_CONNECTOR_MODE), false);
});

test("every connector-derived code is one the browser cannot observe without a report", () => {
  const environment = {
    ...CONFIGURED_BROWSER_ENV,
    BIBI_CONNECTOR_MODE: "docker-resident",
    HERMES_TARGET: "http://hermes-agent:9119",
    BIBI_CONNECTOR_INBOUND_PORT: "9500",
    BIBI_UPLOAD_LOCAL_STATE: "true",
  };

  const withheld = describeBrowserRuntimeMismatch(environment, { connectorReported: false });
  for (const code of CONNECTOR_DERIVED_CODES) {
    assert.equal(codes(withheld).includes(code), false, `${code} needs a heartbeat first`);
  }
  assert.deepEqual(withheld.warnings, []);
});

test("no profile structure warning is raised before a connector has reported", () => {
  const report = describeConnectorProfileMismatch({ reportedProfileIds: [], connectorReported: false });

  assert.deepEqual(report.warnings, [], "seventeen absences are one unknown, not eighteen faults");
  assert.equal(report.blocking, false);
  assert.equal(report.reported, false);
  assert.equal(codes(report).includes(MISMATCH_CODES.CEO_PROFILE_MISSING), false);
  assert.equal(codes(report).includes(MISMATCH_CODES.MISSING_BIBI_PROFILE), false);
  assert.equal(codes(report).includes(MISMATCH_CODES.ROSTER_UNAVAILABLE), false);
});

test("withholding the warnings does not claim the roster was observed", () => {
  const report = pendingProfileMismatch();

  // The distinction the UI needs: nothing is wrong, and nothing is known.
  assert.deepEqual(report.missing, BIBI_PROFILE_IDS);
  assert.deepEqual(report.resolved, []);
  assert.equal(report.reported, false);
});

test("a stale or absent roster payload is still silent before a heartbeat", () => {
  for (const reportedProfileIds of [null, undefined, [], ["default"]]) {
    const report = describeConnectorProfileMismatch({ reportedProfileIds, connectorReported: false });
    assert.deepEqual(report.warnings, [], `${JSON.stringify(reportedProfileIds)} must stay silent`);
  }
});

// ---------------------------------------------------------------------------
// After a heartbeat
// ---------------------------------------------------------------------------

test("once a connector has reported, a wrong mode is reported again", () => {
  const report = describeBrowserRuntimeMismatch(
    { ...CONFIGURED_BROWSER_ENV, BIBI_CONNECTOR_MODE: "docker-resident" },
    { connectorReported: true },
  );

  assert.deepEqual(codes(report), [RUNTIME_CODES.UNSUPPORTED_CONNECTOR_MODE]);
  assert.equal(report.blocking, true);
  assert.equal(report.connectorReported, true);
});

test("a connector that reported the supported mode is clean", () => {
  const report = describeBrowserRuntimeMismatch(
    { ...CONFIGURED_BROWSER_ENV, BIBI_CONNECTOR_MODE: SUPPORTED_CONNECTOR_MODE },
    { connectorReported: true },
  );

  assert.deepEqual(report.warnings, []);
  assert.equal(report.ok, true);
});

test("a reporting connector with a row but a blank mode is a real finding", () => {
  // This is the case the withholding must not swallow forever: the connector
  // checked in and what it wrote is empty, which is a genuine misconfiguration.
  const report = describeBrowserRuntimeMismatch(CONFIGURED_BROWSER_ENV, { connectorReported: true });

  assert.deepEqual(codes(report), [RUNTIME_CODES.CONNECTOR_MODE_UNSET]);
  assert.equal(report.blocking, true);
});

test("once a connector has reported, a missing CEO profile blocks again", () => {
  const report = describeConnectorProfileMismatch({
    reportedProfileIds: ["bibi-02", "bibi-03"],
    connectorReported: true,
  });

  assert.equal(report.reported, true);
  assert.equal(report.blocking, true);
  assert.ok(codes(report).includes(MISMATCH_CODES.CEO_PROFILE_MISSING));
});

test("a fully reported roster is clean once the heartbeat exists", () => {
  const reportedProfileIds = ["default", ...BIBI_PROFILE_IDS.slice(1)];
  const report = describeConnectorProfileMismatch({ reportedProfileIds, connectorReported: true });

  assert.deepEqual(report.warnings, []);
  assert.equal(report.ok, true);
  assert.equal(report.reported, true);
});

// ---------------------------------------------------------------------------
// The client configuration boundary is untouched
// ---------------------------------------------------------------------------

test("the browser still reports its own incomplete cloud configuration", () => {
  const report = describeBrowserRuntimeMismatch(
    { BIBI_CONNECTOR_MODE: "", BIBI_CONTROL_PLANE_URL: "", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" },
    { connectorReported: false },
  );

  assert.deepEqual(codes(report), [RUNTIME_CODES.CLOUD_CONFIG_INCOMPLETE]);
  assert.equal(report.blocking, false, "an unconfigured client is handled by the setup boundary, not a block");
});

test("a privileged key exposed to the browser is still blocking with no heartbeat", () => {
  const report = describeBrowserRuntimeMismatch(
    { ...CONFIGURED_BROWSER_ENV, VITE_SUPABASE_SERVICE_ROLE_KEY: "leaked" },
    { connectorReported: false },
  );

  // This one the browser can see, and it is about the browser.
  assert.deepEqual(codes(report), [RUNTIME_CODES.SERVICE_ROLE_EXPOSED]);
  assert.equal(report.blocking, true);
});

test("an unreadable environment is still refused rather than assumed fine", () => {
  const report = describeBrowserRuntimeMismatch(null, { connectorReported: false });

  assert.deepEqual(codes(report), [RUNTIME_CODES.ENVIRONMENT_UNAVAILABLE]);
  assert.equal(report.blocking, true);
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("both gates withhold by default, so a forgetful caller cannot accuse", () => {
  assert.deepEqual(describeBrowserRuntimeMismatch(CONFIGURED_BROWSER_ENV).warnings, []);
  assert.deepEqual(describeConnectorProfileMismatch({ reportedProfileIds: [] }).warnings, []);
  assert.deepEqual(describeConnectorProfileMismatch().warnings, []);
});

// ---------------------------------------------------------------------------
// What "reported" means
// ---------------------------------------------------------------------------

test("a heartbeat timestamp is the only thing that makes a connector reported", () => {
  // No row and no timestamp are the same state to the health contract, and both
  // read as UNKNOWN with a null timestamp — which is what the gate keys on.
  for (const lastHeartbeatAt of [null, undefined, "", "not-a-date"]) {
    const health = describeConnectorHealth({ lastHeartbeatAt });
    assert.equal(health.state, CONNECTOR_STATE.UNKNOWN);
    assert.equal(health.lastHeartbeatAt, null, `${String(lastHeartbeatAt)} is not a report`);
  }

  // An old heartbeat is still a report. The connector is offline, not unheard
  // of, and what it last said about itself remains judgeable.
  const stale = describeConnectorHealth({
    lastHeartbeatAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  assert.equal(stale.state, CONNECTOR_STATE.OFFLINE);
  assert.notEqual(stale.lastHeartbeatAt, null);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the workspace derives the gate from the heartbeat and passes it to both reports", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  assert.match(source, /const connectorReported = connector\.health\.lastHeartbeatAt !== null;/);

  // The ungated builders must not be reachable from the component any more:
  // calling either directly is exactly the regression this file exists for.
  assert.doesNotMatch(source, /describeProfileMismatch\(/);
  assert.doesNotMatch(source, /describeRuntimeMismatch\(/);
  assert.match(source, /describeConnectorProfileMismatch\(\{/);
  assert.match(source, /describeBrowserRuntimeMismatch\(/);

  // Both gated calls receive the flag rather than defaulting it silently.
  const mismatchCall = source.slice(source.indexOf("describeConnectorProfileMismatch({"), source.indexOf("const runtime"));
  assert.match(mismatchCall, /connectorReported,/);
  const runtimeCall = source.slice(source.indexOf("describeBrowserRuntimeMismatch("));
  assert.match(runtimeCall.slice(0, 300), /\{ connectorReported \}/);
});

test("the browser never fabricates a connector mode it has not been told", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  // The environment the browser assembles reads the mode only when a heartbeat
  // says the row is a report.
  assert.match(
    source,
    /BIBI_CONNECTOR_MODE: connectorReported \? connectorNode\?\.connector_mode \?\? "" : "",/,
  );
});

test("the neutral connector state is still shown, so withholding is not hiding", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  // Withholding the accusations must not withhold the fact. The badge renders
  // unconditionally from the same health object the gate is derived from.
  assert.match(source, /bibi-connector-\$\{connector\.health\.state\}/);
  assert.match(source, /\{connector\.health\.label\}/);

  const health = describeConnectorHealth({ lastHeartbeatAt: null });
  assert.equal(health.state, CONNECTOR_STATE.UNKNOWN);
  assert.match(health.label, /UNKNOWN/);
  assert.equal(health.canDispatchLive, false, "an unheard-of connector never reads as ready");
});

test("work filed against an unreported connector is still queued, not silently accepted", async () => {
  // The other half of honesty: suppressing the warning must not make the
  // surface behave as though the Mac were online.
  const { describeProfileAvailability } = await import("../src/bibi/connectionState.js");
  const availability = describeProfileAvailability({
    profileId: "bibi-01",
    health: describeConnectorHealth({ lastHeartbeatAt: null }),
    reportedProfileIds: [],
  });

  assert.equal(availability.available, false);
  assert.equal(availability.reason, "CONNECTOR_UNKNOWN");
  assert.equal(availability.dispatch, "queued");
});

test("suppressed findings keep their severity for when they are shown", () => {
  // The gate decides visibility only. A withheld blocking finding must still be
  // blocking once a heartbeat makes it reportable.
  const environment = { ...CONFIGURED_BROWSER_ENV, BIBI_CONNECTOR_MODE: "docker-resident" };
  const shown = describeBrowserRuntimeMismatch(environment, { connectorReported: true });

  assert.equal(shown.warnings[0].severity, SEVERITY.BLOCKING);
  assert.ok(shown.warnings[0].remedy.trim(), "a shown finding still tells the owner what to do");
});
