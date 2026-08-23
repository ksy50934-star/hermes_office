import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_CODES,
  SUPPORTED_CONNECTOR_MODE,
  describeRuntimeMismatch,
  runtimeSummaryText,
} from "../src/bibi/runtimeEnvironment.js";
import { SEVERITY } from "../src/bibi/profileMismatch.js";

const HEALTHY = Object.freeze({
  BIBI_CONNECTOR_MODE: "outbound-local-mac",
  BIBI_CONTROL_PLANE_URL: "https://workspace.example.com",
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_ANON_KEY: "anon-key",
});

function codes(report) {
  return report.warnings.map((warning) => warning.code);
}

test("the supported runtime is an outbound-only local Mac connector", () => {
  assert.equal(SUPPORTED_CONNECTOR_MODE, "outbound-local-mac");
  const report = describeRuntimeMismatch(HEALTHY);
  assert.equal(report.ok, true);
  assert.equal(report.blocking, false);
  assert.deepEqual(report.warnings, []);
  assert.equal(runtimeSummaryText(report), "");
});

test("a VPS or Docker-host Hermes target is reported as a blocking environment mismatch", () => {
  for (const target of [
    "http://host.docker.internal:9119",
    "https://srv12345.example.cloud:9119",
    "http://10.0.0.4:9119",
  ]) {
    const report = describeRuntimeMismatch({ ...HEALTHY, HERMES_TARGET: target });
    assert.equal(report.blocking, true, `${target} must block`);
    assert.ok(codes(report).includes(RUNTIME_CODES.REMOTE_HERMES_TARGET));
  }
});

test("a loopback Hermes target is accepted because it is the local Mac runtime", () => {
  for (const target of ["http://127.0.0.1:9119", "http://localhost:9119"]) {
    const report = describeRuntimeMismatch({ ...HEALTHY, HERMES_TARGET: target });
    assert.ok(!codes(report).includes(RUNTIME_CODES.REMOTE_HERMES_TARGET), `${target} must be accepted`);
  }
});

test("any inbound listening port on the connector is blocking", () => {
  const report = describeRuntimeMismatch({ ...HEALTHY, BIBI_CONNECTOR_INBOUND_PORT: "8080" });
  assert.equal(report.blocking, true);
  assert.ok(codes(report).includes(RUNTIME_CODES.INBOUND_PORT_CONFIGURED));
  const warning = report.warnings.find((item) => item.code === RUNTIME_CODES.INBOUND_PORT_CONFIGURED);
  assert.equal(warning.severity, SEVERITY.BLOCKING);
  // An empty value is the correct, supported configuration.
  assert.ok(!codes(describeRuntimeMismatch({ ...HEALTHY, BIBI_CONNECTOR_INBOUND_PORT: "" }))
    .includes(RUNTIME_CODES.INBOUND_PORT_CONFIGURED));
});

test("opting into raw local state upload is blocking", () => {
  const report = describeRuntimeMismatch({ ...HEALTHY, BIBI_UPLOAD_LOCAL_STATE: "true" });
  assert.equal(report.blocking, true);
  assert.ok(codes(report).includes(RUNTIME_CODES.LOCAL_STATE_UPLOAD));
});

test("a service-role key reachable from the browser bundle is blocking", () => {
  for (const key of ["VITE_SUPABASE_SERVICE_ROLE_KEY", "VITE_SERVICE_ROLE_KEY", "VITE_SUPABASE_SECRET"]) {
    const report = describeRuntimeMismatch({ ...HEALTHY, [key]: "any-value" });
    assert.equal(report.blocking, true, `${key} must block`);
    assert.ok(codes(report).includes(RUNTIME_CODES.SERVICE_ROLE_EXPOSED));
  }
});

test("an unset or unsupported connector mode is blocking rather than assumed healthy", () => {
  const unset = describeRuntimeMismatch({ ...HEALTHY, BIBI_CONNECTOR_MODE: "" });
  assert.equal(unset.blocking, true);
  assert.ok(codes(unset).includes(RUNTIME_CODES.CONNECTOR_MODE_UNSET));

  const vps = describeRuntimeMismatch({ ...HEALTHY, BIBI_CONNECTOR_MODE: "vps" });
  assert.equal(vps.blocking, true);
  assert.ok(codes(vps).includes(RUNTIME_CODES.UNSUPPORTED_CONNECTOR_MODE));
});

test("missing cloud configuration warns instead of pretending the control plane is wired", () => {
  const report = describeRuntimeMismatch({ BIBI_CONNECTOR_MODE: SUPPORTED_CONNECTOR_MODE });
  assert.equal(report.ok, false);
  assert.ok(codes(report).includes(RUNTIME_CODES.CLOUD_CONFIG_INCOMPLETE));
  const warning = report.warnings.find((item) => item.code === RUNTIME_CODES.CLOUD_CONFIG_INCOMPLETE);
  assert.match(warning.message, /VITE_SUPABASE_URL/);
});

test("a non-object environment is treated as unknown, never as healthy", () => {
  for (const input of [null, undefined, "", 0]) {
    const report = describeRuntimeMismatch(input);
    assert.equal(report.ok, false);
    assert.equal(report.blocking, true);
  }
});

test("the summary text explains the local-versus-VPS difference in the user's terms", () => {
  const text = runtimeSummaryText(describeRuntimeMismatch({
    ...HEALTHY,
    HERMES_TARGET: "http://host.docker.internal:9119",
  }));
  assert.match(text, /VPS|원격/);
  assert.match(text, /로컬/);
});
