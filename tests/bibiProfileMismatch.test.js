import assert from "node:assert/strict";
import test from "node:test";
import { BIBI_PROFILE_IDS, EXECUTION_PROFILE_IDS } from "../src/bibi/roster.js";
import {
  MISMATCH_CODES,
  SEVERITY,
  describeProfileMismatch,
  mismatchSummaryText,
} from "../src/bibi/profileMismatch.js";

/** The connector reports *physical* profiles, so that is what these feed in. */
function observed(ids) {
  return ids.map((id) => ({ id }));
}

function codes(report) {
  return report.warnings.map((warning) => warning.code);
}

test("a complete physical roster produces no warnings and is not blocking", () => {
  const report = describeProfileMismatch(observed(EXECUTION_PROFILE_IDS));
  assert.equal(report.ok, true);
  assert.equal(report.blocking, false);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unexpected, []);
});

test("the report speaks in organisational ids while naming the physical profile behind each", () => {
  const report = describeProfileMismatch(observed(EXECUTION_PROFILE_IDS));
  assert.deepEqual(report.resolved.map((entry) => entry.id), BIBI_PROFILE_IDS);
  // The CEO row must carry both identities, never collapse them into one.
  const ceo = report.resolved[0];
  assert.equal(ceo.id, "bibi-01");
  assert.equal(ceo.executionProfileId, "default");
  assert.equal(report.resolved[1].executionProfileId, "bibi-02");
});

test("the default profile satisfies the CEO requirement", () => {
  const report = describeProfileMismatch(observed(EXECUTION_PROFILE_IDS));
  assert.ok(!codes(report).includes(MISMATCH_CODES.CEO_PROFILE_MISSING));
  assert.ok(!report.missing.includes("bibi-01"));
});

test("a missing default profile blocks, because the CEO has no other runtime", () => {
  const report = describeProfileMismatch(observed(EXECUTION_PROFILE_IDS.filter((id) => id !== "default")));
  assert.equal(report.blocking, true);
  assert.ok(codes(report).includes(MISMATCH_CODES.CEO_PROFILE_MISSING));
  assert.deepEqual(report.missing, ["bibi-01"]);
});

test("the rollback bibi-01 directory never stands in for the CEO", () => {
  // Everything present except `default`, plus the rollback original on disk.
  const report = describeProfileMismatch(
    observed([...EXECUTION_PROFILE_IDS.filter((id) => id !== "default"), "bibi-01"]),
  );

  // The rollback directory must not satisfy the CEO requirement.
  assert.equal(report.blocking, true);
  assert.ok(codes(report).includes(MISMATCH_CODES.CEO_PROFILE_MISSING));
  assert.deepEqual(report.missing, ["bibi-01"]);

  const rollback = report.warnings.find((warning) => warning.code === MISMATCH_CODES.ROLLBACK_PROFILE_PRESENT);
  assert.ok(rollback, "the rollback original must be called out explicitly");
  assert.equal(rollback.profileId, "bibi-01");
  assert.match(rollback.message, /롤백/);
  assert.ok(!report.resolved.some((entry) => entry.executionProfileId === "bibi-01"));
});

test("the rollback directory is reported even when the CEO runtime is healthy", () => {
  const report = describeProfileMismatch(observed([...EXECUTION_PROFILE_IDS, "bibi-01"]));
  assert.ok(codes(report).includes(MISMATCH_CODES.ROLLBACK_PROFILE_PRESENT));
  assert.deepEqual(report.missing, []);
  // Its presence is informational, not a reason to stop working.
  assert.equal(report.blocking, false);
  assert.equal(report.resolved.length, 18);
});

test("upstream generic profiles are reported as a blocking structural mismatch", () => {
  const report = describeProfileMismatch(observed(["hermes-director", "hermes-operations"]));
  assert.equal(report.ok, false);
  assert.equal(report.blocking, true);

  const generic = report.warnings.filter((warning) => warning.code === MISMATCH_CODES.UPSTREAM_GENERIC_PROFILE);
  assert.deepEqual(generic.map((warning) => warning.profileId), ["hermes-director", "hermes-operations"]);
  assert.ok(generic.every((warning) => warning.severity === SEVERITY.BLOCKING));
  assert.ok(generic.every((warning) => warning.remedy));
  // The remedy must not offer an automatic alias.
  assert.ok(generic.every((warning) => !/자동|alias|fallback/i.test(warning.remedy)));
});

test("missing specialist profiles warn without blocking, and are never back-filled", () => {
  const present = EXECUTION_PROFILE_IDS.filter((id) => !["bibi-17", "bibi-18"].includes(id));
  const report = describeProfileMismatch(observed(present));
  assert.equal(report.ok, false);
  assert.equal(report.blocking, false);
  assert.deepEqual(report.missing, ["bibi-17", "bibi-18"]);
  const missing = report.warnings.filter((warning) => warning.code === MISMATCH_CODES.MISSING_BIBI_PROFILE);
  assert.equal(missing.length, 2);
  assert.ok(missing.every((warning) => warning.severity === SEVERITY.WARNING));
});

test("unrecognised identifiers are surfaced instead of being silently dropped", () => {
  const report = describeProfileMismatch(observed([...EXECUTION_PROFILE_IDS, "bibi-19", "ceo"]));
  assert.equal(report.blocking, false);
  assert.deepEqual(report.unexpected, ["bibi-19", "ceo"]);
  assert.equal(report.warnings.filter((warning) => warning.code === MISMATCH_CODES.UNKNOWN_PROFILE).length, 2);
});

test("duplicate observations collapse without hiding the duplication", () => {
  const report = describeProfileMismatch(observed([...EXECUTION_PROFILE_IDS, "default"]));
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unexpected, []);
  const duplicates = report.warnings.filter((warning) => warning.code === MISMATCH_CODES.DUPLICATE_PROFILE);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].profileId, "default");
  assert.equal(report.resolved.length, 18);
});

test("accepts raw Hermes profile shapes and plain strings alike", () => {
  const report = describeProfileMismatch(["default", { name: "bibi-02" }, { id: "bibi-03" }, { profile: "bibi-04" }]);
  assert.deepEqual(report.resolved.map((entry) => entry.id), ["bibi-01", "bibi-02", "bibi-03", "bibi-04"]);
});

test("a null or non-array observation is reported as unknown, not as a healthy roster", () => {
  for (const input of [null, undefined, "default", 42]) {
    const report = describeProfileMismatch(input);
    assert.equal(report.ok, false, `${String(input)} must not read as healthy`);
    assert.equal(report.blocking, true);
    assert.ok(codes(report).includes(MISMATCH_CODES.ROSTER_UNAVAILABLE));
  }
});

test("the summary text names the real structure difference for the user", () => {
  const text = mismatchSummaryText(describeProfileMismatch(observed(["hermes-director"])));
  assert.match(text, /bibi-01/);
  assert.match(text, /18/);
  assert.ok(text.length > 20);
  assert.equal(mismatchSummaryText(describeProfileMismatch(observed(EXECUTION_PROFILE_IDS))), "");
});
