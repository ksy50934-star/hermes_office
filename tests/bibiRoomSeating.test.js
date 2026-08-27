import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  BIBI_ROOM_ASSIGNMENTS,
  ORGANIZATION_DEFAULT_ROOM,
  ORGANIZATION_ROOMS,
  buildCanonicalBibiOrganizationNodes,
  migrateOrganizationRoom,
  migrateOrganizationRooms,
  organizationHasCollapsedRooms,
  organizationRequiresMigration,
  organizationRoomAssignments,
  validateOrganizationNodes,
} from "../organizationHierarchy.js";
import { BIBI_DEPARTMENT_ASSIGNMENTS } from "../organizationHierarchy.js";
import { OFFICE_FLOOR_ZONES, buildOfficeAgentPlacements } from "../src/officeData.js";
import { BIBI_PROFILE_IDS, CEO_PROFILE_ID, toExecutionProfileId } from "../src/bibi/roster.js";

const SEATING_MIGRATION = new URL(
  "../supabase/migrations/20260826000200_bibi_room_seating.sql",
  import.meta.url,
);
const COLLAPSED_ROOM_REPAIR = new URL(
  "../supabase/migrations/20260827000300_bibi_collapsed_room_repair.sql",
  import.meta.url,
);

/** The seating v1 emitted: CEO in 대표실, everyone else dropped into 운영실. */
function v1Chart() {
  return BIBI_PROFILE_IDS.map((id, index) => ({
    id,
    parentId: id === CEO_PROFILE_ID ? null : CEO_PROFILE_ID,
    department: BIBI_DEPARTMENT_ASSIGNMENTS[id],
    roomId: id === CEO_PROFILE_ID ? "executive" : "operations",
    order: index,
  }));
}

function allOperationsChart() {
  return v1Chart().map((node) => ({ ...node, roomId: "operations" }));
}

test("every organization room is a real zone on the floor plan", () => {
  const zoneIds = new Set(OFFICE_FLOOR_ZONES.map((zone) => zone.id));
  for (const room of ORGANIZATION_ROOMS) {
    assert.ok(zoneIds.has(room.id), `${room.id} is not a zone on the floor plan`);
    const zone = OFFICE_FLOOR_ZONES.find((item) => item.id === room.id);
    assert.equal(room.label, zone.label, `${room.id} label disagrees with the floor plan`);
  }
});

test("회의실 and 내 책상 stay out of the chart, because neither is a desk assignment", () => {
  const assignable = ORGANIZATION_ROOMS.map((room) => room.id);
  assert.ok(!assignable.includes("meeting"));
  assert.ok(!assignable.includes("desk"));
});

test("관제센터 and 자료실 are seatable rooms now, and no zone coordinate moved", async () => {
  const assignable = ORGANIZATION_ROOMS.map((room) => room.id);
  assert.ok(assignable.includes("control"), "관제센터 must be assignable");
  assert.ok(assignable.includes("library"), "자료실 must be assignable");

  // The calibrated geometry is the thing that must not drift when a room
  // becomes assignable: the map is traced onto a background image.
  const geometry = Object.fromEntries(
    OFFICE_FLOOR_ZONES.map((zone) => [zone.id, [zone.x, zone.y, zone.w, zone.h, ...zone.marker]]),
  );
  assert.deepEqual(geometry.control, [60.3, 2.0, 25.2, 22.2, 72.8, 22.0]);
  assert.deepEqual(geometry.library, [39.5, 70.0, 23.2, 28.0, 51.0, 72.0]);
  assert.deepEqual(geometry.executive, [1.9, 2.0, 12.2, 22.2, 7.0, 22.0]);
  assert.deepEqual(geometry.operations, [14.3, 2.0, 25.4, 22.2, 27.0, 22.0]);
});

test("the seating contract covers exactly the eighteen role slots", () => {
  assert.deepEqual(Object.keys(BIBI_ROOM_ASSIGNMENTS).sort(), [...BIBI_PROFILE_IDS].sort());
  const roomIds = new Set(ORGANIZATION_ROOMS.map((room) => room.id));
  for (const [id, room] of Object.entries(BIBI_ROOM_ASSIGNMENTS)) {
    assert.ok(roomIds.has(room), `${id} is seated in ${room}, which is not a room`);
  }
});

test("every room holds at least one member and none is left empty", () => {
  const nodes = buildCanonicalBibiOrganizationNodes([...BIBI_PROFILE_IDS]);
  const occupied = new Set(nodes.map((node) => node.roomId));
  const empty = ORGANIZATION_ROOMS.filter((room) => !occupied.has(room.id));
  assert.deepEqual(empty, [], `empty rooms: ${empty.map((room) => room.label).join(", ")}`);
  assert.equal(nodes.length, BIBI_PROFILE_IDS.length);
});

test("the whole roster is seated without any room exceeding its seats", () => {
  const nodes = buildCanonicalBibiOrganizationNodes([...BIBI_PROFILE_IDS]);
  const assignments = Object.fromEntries(
    nodes.map((node) => [toExecutionProfileId(node.id), node.roomId]),
  );
  const profiles = Object.keys(assignments).map((name) => ({ name }));
  const placements = buildOfficeAgentPlacements(profiles, undefined, undefined, assignments);

  assert.equal(Object.keys(placements).length, BIBI_PROFILE_IDS.length);
  for (const [name, placement] of Object.entries(placements)) {
    assert.equal(
      placement.roomId,
      assignments[name],
      `${name} was pushed out of ${assignments[name]} into ${placement.roomId}`,
    );
  }
  const coordinates = new Set(Object.values(placements).map((seat) => `${seat.x}:${seat.y}`));
  assert.equal(coordinates.size, BIBI_PROFILE_IDS.length, "two members share one seat");
});

test("a member's room matches the work their mandate describes", () => {
  // Spot-checks of the mapping that carry the argument: the runtime operator,
  // the fixer and the scheduler watch the office from 관제센터; the three
  // publishing seats share 콘텐츠룸; research, knowledge and documents share 자료실.
  assert.equal(BIBI_ROOM_ASSIGNMENTS["bibi-01"], "executive");
  assert.equal(BIBI_ROOM_ASSIGNMENTS["bibi-12"], "control");
  assert.equal(BIBI_ROOM_ASSIGNMENTS["bibi-17"], "control");
  assert.equal(BIBI_ROOM_ASSIGNMENTS["bibi-11"], "control");
  assert.equal(BIBI_ROOM_ASSIGNMENTS["bibi-02"], "tech");
  assert.equal(BIBI_ROOM_ASSIGNMENTS["bibi-06"], "creative");
  for (const id of ["bibi-03", "bibi-04", "bibi-05"]) {
    assert.equal(BIBI_ROOM_ASSIGNMENTS[id], "content");
  }
  for (const id of ["bibi-13", "bibi-14", "bibi-15"]) {
    assert.equal(BIBI_ROOM_ASSIGNMENTS[id], "library");
  }
});

test("a persisted v1 chart is seated on read, and write-back is requested", () => {
  const stored = v1Chart();
  assert.equal(organizationHasCollapsedRooms(stored), true);
  assert.equal(organizationRequiresMigration(stored), true);

  const seated = validateOrganizationNodes(stored);
  for (const node of seated) {
    assert.equal(node.roomId, BIBI_ROOM_ASSIGNMENTS[node.id]);
  }
  assert.equal(new Set(seated.map((node) => node.roomId)).size, ORGANIZATION_ROOMS.length);
});

test("the exact eighteen-member all-operations production variant is also repaired", () => {
  const stored = allOperationsChart();
  assert.equal(organizationHasCollapsedRooms(stored), true);
  const seated = validateOrganizationNodes(stored);
  for (const node of seated) assert.equal(node.roomId, BIBI_ROOM_ASSIGNMENTS[node.id]);

  assert.equal(
    organizationHasCollapsedRooms(stored.slice(0, 17)),
    false,
    "a partial all-operations chart is not safe to classify as legacy",
  );
  assert.equal(
    organizationHasCollapsedRooms([...stored, {
      id: "non-bibi",
      parentId: null,
      department: "support",
      roomId: "operations",
      order: 18,
    }]),
    false,
    "a chart with an extra non-Bibi node is not the exact production legacy shape",
  );
  assert.equal(
    organizationHasCollapsedRooms([...stored.slice(0, 17), stored[0]]),
    false,
    "a duplicate canonical id cannot stand in for the missing member",
  );
  assert.equal(
    organizationHasCollapsedRooms(stored.map((node) => (
      node.id === "bibi-04" ? { ...node, roomId: "creative" } : node
    ))),
    false,
    "one explicit room choice preserves the whole user arrangement",
  );
});

test("an office the user arranged is never re-seated", () => {
  // One member moved out of 운영실 is enough: the arrangement is theirs now.
  const arranged = v1Chart().map((node) => (
    node.id === "bibi-04" ? { ...node, roomId: "creative" } : node
  ));
  assert.equal(organizationHasCollapsedRooms(arranged), false);
  assert.equal(migrateOrganizationRooms(arranged), arranged);
  assert.equal(organizationRequiresMigration(arranged), false);

  const rooms = organizationRoomAssignments(arranged);
  assert.equal(rooms["bibi-04"], "creative");
  assert.equal(rooms["bibi-03"], "operations", "an untouched member keeps the room they were in");
});

test("seating is applied once and is stable on every later read", () => {
  const seated = validateOrganizationNodes(v1Chart());
  assert.equal(organizationRequiresMigration(seated), false);
  assert.deepEqual(validateOrganizationNodes(seated), seated);
});

test("a member with an unusable room falls back to the contract, then to 운영실", () => {
  assert.equal(migrateOrganizationRoom("bibi-02", "nowhere"), "tech");
  assert.equal(migrateOrganizationRoom("bibi-02", undefined), "tech");
  assert.equal(migrateOrganizationRoom("bibi-02", "library"), "library", "a real room is kept");
  assert.equal(migrateOrganizationRoom("not-a-bibi", "nowhere"), ORGANIZATION_DEFAULT_ROOM);
});

test("a chart with no Bibi members is left completely alone", () => {
  const generic = [
    { id: "default", parentId: null, department: "management", roomId: "executive", order: 0 },
    { id: "hermes-operations", parentId: "default", department: "management", roomId: "operations", order: 1 },
  ];
  assert.equal(organizationHasCollapsedRooms(generic), false);
  const rooms = organizationRoomAssignments(generic);
  assert.equal(rooms["hermes-operations"], "operations");
});

test("the Supabase migration seats members exactly as the browser does", async () => {
  const sql = await readFile(SEATING_MIGRATION, "utf8");
  const seatBlock = sql.slice(sql.lastIndexOf("(values", sql.indexOf(") as seat(id, room)")), sql.indexOf(") as seat(id, room)"));
  const stored = Object.fromEntries(
    [...seatBlock.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(stored, { ...BIBI_ROOM_ASSIGNMENTS });
});

test("the Supabase migration only fires on the v1 collapse, and only rewrites roomId", async () => {
  const sql = await readFile(SEATING_MIGRATION, "utf8");
  // The same test the browser applies: non-CEO members all in operations, CEO in executive.
  assert.match(sql, /roomId'\s+is distinct from 'operations'/);
  assert.match(sql, /bibi-01' and item\.node->>'roomId' is distinct from 'executive'/);
  // Only the room is written, and no row is removed.
  assert.match(sql, /jsonb_set\(item\.node, '\{roomId\}'/);
  assert.ok(!/delete\s+from/i.test(sql), "the migration must never delete a row");
  assert.ok(!/'\{department\}'/.test(sql), "the migration must not touch departments");
  assert.ok(!/'\{parentId\}'/.test(sql), "the migration must not touch reporting lines");
  // The revision is bumped once with an audit entry, like every other data migration here.
  assert.match(sql, /revision = state\.revision \+ 1/);
  assert.match(sql, /system:bibi-room-seating-v2/);
});

test("the forward repair executes once on exact all-operations data and preserves custom seating", async () => {
  const db = new PGlite();
  await db.exec(`
    create table bibi_organization_states (
      owner_id uuid primary key,
      revision integer not null,
      nodes jsonb not null,
      audit jsonb,
      updated_at timestamptz not null default now()
    );
  `);
  const collapsedNodes = allOperationsChart();
  const arrangedNodes = allOperationsChart().map((node) => (
    node.id === "bibi-04" ? { ...node, roomId: "creative" } : node
  ));
  const collapsed = JSON.stringify(collapsedNodes).replaceAll("'", "''");
  const arranged = JSON.stringify(arrangedNodes).replaceAll("'", "''");
  await db.exec(`
    insert into bibi_organization_states (owner_id, revision, nodes, audit) values
      ('00000000-0000-0000-0000-000000000001', 2, '${collapsed}'::jsonb, '[]'::jsonb),
      ('00000000-0000-0000-0000-000000000002', 7, '${arranged}'::jsonb, '[]'::jsonb);
  `);
  const sql = await readFile(COLLAPSED_ROOM_REPAIR, "utf8");
  await db.exec(sql);
  await db.exec(sql);

  const rows = await db.query(`
    select owner_id::text, revision, nodes, audit
      from bibi_organization_states order by owner_id
  `);
  const repaired = rows.rows[0];
  const custom = rows.rows[1];
  assert.equal(repaired.revision, 3, "repair is idempotent after rooms diverge");
  assert.equal(repaired.audit.length, 1);
  assert.equal(repaired.audit[0].actor, "system:bibi-room-seating-v2-all-operations-repair");
  assert.deepEqual(
    Object.fromEntries(repaired.nodes.map((node) => [node.id, node.roomId])),
    { ...BIBI_ROOM_ASSIGNMENTS },
  );
  assert.equal(custom.revision, 7);
  assert.deepEqual(custom.nodes, arrangedNodes);
  assert.deepEqual(custom.audit, []);
  await db.close();
});
