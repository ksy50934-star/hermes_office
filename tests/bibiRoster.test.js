import assert from "node:assert/strict";
import test from "node:test";
import {
  BIBI_PROFILE_COUNT,
  BIBI_PROFILE_IDS,
  BIBI_ROSTER,
  CEO_EXECUTION_PROFILE_ID,
  CEO_PROFILE_ID,
  DEVELOPER_PROFILE_ID,
  EXECUTION_PROFILE_IDS,
  ROLE_CONFIRMED,
  ROLLBACK_PROFILE_ID,
  ceoFirstRoster,
  isBibiProfileId,
  isExecutionProfileId,
  resolveBibiProfile,
  toExecutionProfileId,
  toOrganizationProfileId,
  unconfirmedRoleIds,
} from "../src/bibi/roster.js";
import { readFile } from "node:fs/promises";

test("the organisational roster is exactly the eighteen bibi role slots", () => {
  assert.equal(BIBI_PROFILE_COUNT, 18);
  assert.equal(BIBI_PROFILE_IDS.length, 18);
  assert.deepEqual(BIBI_PROFILE_IDS, [
    "bibi-01", "bibi-02", "bibi-03", "bibi-04", "bibi-05", "bibi-06",
    "bibi-07", "bibi-08", "bibi-09", "bibi-10", "bibi-11", "bibi-12",
    "bibi-13", "bibi-14", "bibi-15", "bibi-16", "bibi-17", "bibi-18",
  ]);
  assert.equal(BIBI_ROSTER.length, 18);
  assert.deepEqual(BIBI_ROSTER.map((entry) => entry.id), BIBI_PROFILE_IDS);
  assert.deepEqual(BIBI_ROSTER.map((entry) => entry.ordinal), Array.from({ length: 18 }, (_, i) => i + 1));
});

test("the roster is frozen so no caller can widen or rename the physical profile set", () => {
  assert.ok(Object.isFrozen(BIBI_PROFILE_IDS));
  assert.ok(Object.isFrozen(BIBI_ROSTER));
  assert.ok(BIBI_ROSTER.every((entry) => Object.isFrozen(entry)));
  assert.throws(() => { BIBI_PROFILE_IDS.push("bibi-19"); }, TypeError);
});

test("bibi-01 is the CEO surface and bibi-02 is the developer surface", () => {
  assert.equal(CEO_PROFILE_ID, "bibi-01");
  assert.equal(DEVELOPER_PROFILE_ID, "bibi-02");
  const ceo = BIBI_ROSTER[0];
  assert.equal(ceo.id, "bibi-01");
  assert.equal(ceo.isCeo, true);
  assert.equal(ceo.isPrimarySurface, true);
  assert.equal(ceo.displayName, "CEO비비");
  assert.equal(BIBI_ROSTER[1].displayName, "개발자비비");
  assert.equal(BIBI_ROSTER.filter((entry) => entry.isCeo).length, 1);
  assert.equal(BIBI_ROSTER.filter((entry) => entry.isPrimarySurface).length, 1);
});

test("every role is canonical, so nothing is left unconfirmed or positional", () => {
  assert.deepEqual(unconfirmedRoleIds(), []);
  for (const entry of BIBI_ROSTER) {
    assert.equal(entry.roleSource, ROLE_CONFIRMED, `${entry.id} must carry a canonical role`);
    assert.ok(entry.role && entry.role.trim(), `${entry.id} needs a role`);
    assert.ok(entry.mandate && entry.mandate.trim(), `${entry.id} needs a mandate`);
    assert.ok(entry.displayName && entry.displayName.trim());
    // The placeholder label the first pass shipped must be gone entirely.
    assert.doesNotMatch(entry.displayName, /^비비 \d{2}$/, `${entry.id} still has a placeholder name`);
  }
});

test("the roster matches the canonical bibi-world declarations exactly", async () => {
  // The single source of truth is read-only; this test fails if the roster and
  // the declarations ever drift apart.
  for (const entry of BIBI_ROSTER) {
    const declared = JSON.parse(await readFile(
      `/Users/siyoung/Documents/bibi-world/${entry.id}/profile.json`,
      "utf8",
    ));
    assert.equal(entry.displayName, declared.official_role, `${entry.id} display name`);
    assert.equal(entry.role, declared.official_role, `${entry.id} role`);
    assert.equal(entry.mandate, declared.purpose, `${entry.id} mandate`);
    assert.equal(entry.reportsTo, declared.reports_to, `${entry.id} reports_to`);
  }
});

test("the CEO reports to the user and every specialist reports to the CEO", () => {
  assert.equal(BIBI_ROSTER[0].reportsTo, "user");
  for (const entry of BIBI_ROSTER.slice(1)) {
    assert.equal(entry.reportsTo, CEO_PROFILE_ID, `${entry.id} must report to the CEO`);
  }
});

test("ceoFirstRoster keeps bibi-01 first and preserves physical ordering after it", () => {
  const ordered = ceoFirstRoster();
  assert.equal(ordered[0].id, "bibi-01");
  assert.deepEqual(ordered.map((entry) => entry.id), BIBI_PROFILE_IDS);
});

test("profile resolution never aliases upstream generic identifiers onto a bibi profile", () => {
  assert.equal(isBibiProfileId("bibi-01"), true);
  assert.equal(isBibiProfileId("bibi-18"), true);
  assert.equal(isBibiProfileId("bibi-19"), false);
  assert.equal(isBibiProfileId("bibi-1"), false);
  assert.equal(isBibiProfileId("BIBI-01"), false);
  assert.equal(isBibiProfileId("default"), false);
  assert.equal(isBibiProfileId("hermes-director"), false);

  assert.equal(resolveBibiProfile("bibi-01").ok, true);
  assert.equal(resolveBibiProfile("bibi-01").profile.id, "bibi-01");

  for (const generic of ["default", "hermes-director", "hermes-operations", ""]) {
    const result = resolveBibiProfile(generic);
    assert.equal(result.ok, false, `${generic} must not resolve`);
    assert.equal(result.profile, null);
    assert.ok(result.code);
  }
  // `default` is a real physical profile (the CEO runtime), not a generic
  // upstream one, so it gets its own code telling the caller to translate.
  assert.equal(resolveBibiProfile("default").code, "EXECUTION_PROFILE_NOT_ORGANIZATION_ID");
  assert.equal(resolveBibiProfile("hermes-director").code, "UPSTREAM_GENERIC_PROFILE");
  assert.equal(resolveBibiProfile("totally-unknown").code, "UNKNOWN_PROFILE");
  assert.equal(resolveBibiProfile("").code, "MISSING_PROFILE");
});

// ---------------------------------------------------------------------------
// Organisational role slot <-> physical execution profile
// ---------------------------------------------------------------------------

test("the physical execution profiles are `default` plus bibi-02..bibi-18", () => {
  assert.equal(CEO_EXECUTION_PROFILE_ID, "default");
  // `default` plus the seventeen specialist profiles bibi-02..bibi-18.
  assert.equal(EXECUTION_PROFILE_IDS.length, 18);
  assert.ok(!EXECUTION_PROFILE_IDS.includes("bibi-01"));
  assert.deepEqual(EXECUTION_PROFILE_IDS, ["default", ...BIBI_PROFILE_IDS.slice(1)]);
  assert.ok(Object.isFrozen(EXECUTION_PROFILE_IDS));

  assert.equal(isExecutionProfileId("default"), true);
  assert.equal(isExecutionProfileId("bibi-18"), true);
  // The physical bibi-01 directory is a rollback original, not a runtime.
  assert.equal(isExecutionProfileId("bibi-01"), false);
  assert.equal(isExecutionProfileId("hermes-director"), false);
});

test("every roster entry names the physical profile it actually executes on", () => {
  assert.equal(BIBI_ROSTER[0].executionProfileId, "default");
  for (const entry of BIBI_ROSTER.slice(1)) {
    assert.equal(entry.executionProfileId, entry.id, `${entry.id} executes on itself`);
  }
});

test("the CEO role slot maps to the default profile, explicitly and in one direction only", () => {
  assert.equal(toExecutionProfileId("bibi-01"), "default");
  assert.equal(toOrganizationProfileId("default"), "bibi-01");

  // The asymmetry is the safety property. The organisational id `bibi-01` and
  // the physical directory `bibi-01` share a name and mean different things;
  // translating the directory back to the CEO would auto-select the rollback
  // original as the CEO runtime, which is exactly what must never happen.
  assert.equal(ROLLBACK_PROFILE_ID, "bibi-01");
  assert.equal(toOrganizationProfileId("bibi-01"), null);
});

test("specialist role slots map to their own physical profile", () => {
  for (const id of BIBI_PROFILE_IDS.slice(1)) {
    assert.equal(toExecutionProfileId(id), id);
    assert.equal(toOrganizationProfileId(id), id);
  }
});

test("neither direction of the mapping invents a profile", () => {
  for (const value of ["", "bibi-19", "bibi-00", "hermes-director", null, undefined, 7]) {
    assert.equal(toExecutionProfileId(value), null, `${String(value)} has no execution profile`);
  }
  for (const value of ["", "bibi-19", "hermes-director", "hermes-operations", null, undefined]) {
    assert.equal(toOrganizationProfileId(value), null, `${String(value)} has no role slot`);
  }
});

test("the two identifier spaces round-trip for every role slot", () => {
  for (const id of BIBI_PROFILE_IDS) {
    assert.equal(toOrganizationProfileId(toExecutionProfileId(id)), id);
  }
  for (const id of EXECUTION_PROFILE_IDS) {
    assert.equal(toExecutionProfileId(toOrganizationProfileId(id)), id);
  }
});
