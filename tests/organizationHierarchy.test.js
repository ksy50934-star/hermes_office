import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BIBI_DEPARTMENT_ASSIGNMENTS,
  LEGACY_DEPARTMENT_MIGRATION,
  ORGANIZATION_DEFAULT_DEPARTMENT,
  BIBI_ROOM_ASSIGNMENTS,
  ORGANIZATION_DEPARTMENTS,
  ORGANIZATION_ROOMS,
  ORGANIZATION_VERSION,
  addOrganizationNode,
  buildCanonicalBibiOrganizationNodes,
  buildDefaultOrganizationNodes,
  migrateOrganizationDepartment,
  moveOrganizationNode,
  organizationDepartmentLabel,
  organizationMemberFunction,
  organizationReportingContext,
  organizationRequiresMigration,
  organizationRoomAssignments,
  organizationVisibleNodeIds,
  removeOrganizationNode,
  validateOrganizationNodes,
} from "../organizationHierarchy.js";
import { BIBI_PROFILE_IDS, bibiProfile } from "../src/bibi/roster.js";

const profiles = [
  { name: "default" },
  { name: "hermes-operations" },
  { name: "hermes-brand" },
  { name: "external-agent" },
];

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const MIGRATION_SQL = "supabase/migrations/20260826000100_five_department_bibi_organization.sql";

/**
 * The confirmed five-department contract (BIBI-ORG-20260825-01), transcribed
 * from the packet in presentation order: department id, label, exact members.
 */
const CONTRACT = [
  ["management", "관리부서", ["bibi-01", "bibi-12"]],
  ["execution", "실무부서", ["bibi-02", "bibi-03", "bibi-04", "bibi-05", "bibi-06", "bibi-15", "bibi-16"]],
  ["review", "검수부서", ["bibi-09", "bibi-10", "bibi-14"]],
  ["support", "지원부서", ["bibi-07", "bibi-08", "bibi-13", "bibi-17", "bibi-18"]],
  ["recurring", "반복부서(크론잡)", ["bibi-11"]],
];

/** Every department id v1 could have persisted, before the contract existed. */
const V1_DEPARTMENT_IDS = [
  "leadership", "operations", "brand", "growth", "content",
  "creative", "customer", "finance", "technology", "general",
];

const canonicalNodes = () => buildCanonicalBibiOrganizationNodes(BIBI_PROFILE_IDS.map((name) => ({ name })));

test("default hierarchy contains every actual Hermes profile exactly once", () => {
  const nodes = buildDefaultOrganizationNodes(profiles);
  assert.deepEqual(new Set(nodes.map((node) => node.id)), new Set(profiles.map((profile) => profile.name)));
  assert.equal(nodes.find((node) => node.id === "default")?.parentId, null);
  assert.equal(nodes.find((node) => node.id === "hermes-operations")?.parentId, "default");
  assert.equal(nodes.find((node) => node.id === "hermes-brand")?.parentId, "hermes-operations");
});

test("canonical Bibi organization places all seventeen specialists directly under CEO비비", () => {
  const nodes = buildCanonicalBibiOrganizationNodes(BIBI_PROFILE_IDS.map((name) => ({ name })));

  assert.deepEqual(nodes.map((node) => node.id), BIBI_PROFILE_IDS);
  assert.equal(nodes.find((node) => node.id === "bibi-01")?.parentId, null);
  assert.equal(nodes.filter((node) => node.id !== "bibi-01" && node.parentId === "bibi-01").length, 17);
  assert.equal(nodes.some((node) => node.id !== "bibi-01" && node.parentId !== "bibi-01"), false);
});

test("canonical Bibi organization rejects a partial or foreign roster instead of guessing", () => {
  assert.throws(
    () => buildCanonicalBibiOrganizationNodes([{ name: "bibi-01" }, { name: "bibi-02" }]),
    /exactly bibi-01 through bibi-18/i,
  );
  assert.throws(
    () => buildCanonicalBibiOrganizationNodes([
      ...BIBI_PROFILE_IDS.slice(0, 17).map((name) => ({ name })),
      { name: "hermes-brand" },
    ]),
    /exactly bibi-01 through bibi-18/i,
  );
  assert.throws(
    () => buildCanonicalBibiOrganizationNodes([
      ...BIBI_PROFILE_IDS.map((name) => ({ name })),
      { name: "foreign-profile" },
    ]),
    /exactly bibi-01 through bibi-18/i,
  );
  assert.throws(
    () => buildCanonicalBibiOrganizationNodes([
      ...BIBI_PROFILE_IDS.map((name) => ({ name })),
      { name: "bibi-18" },
    ]),
    /exactly bibi-01 through bibi-18/i,
  );
  assert.throws(
    () => buildCanonicalBibiOrganizationNodes([
      { name: "default" },
      { name: "bibi-01" },
      ...BIBI_PROFILE_IDS.slice(2).map((name) => ({ name })),
    ]),
    /exactly bibi-01 through bibi-18/i,
  );
});

test("cloud seed construction is inside the promise rejection path", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(
    appSource,
    /Promise\.resolve\(\)[\s\S]*?\.then\(\(\) => buildCanonicalBibiOrganizationNodes\(profiles\)\)[\s\S]*?\.then\(\(defaults\) => saveCloudOrganization/,
  );
});

test("the primary Hermes profile and UI alias collapse into one organization node", () => {
  const nodes = buildDefaultOrganizationNodes([
    { name: "default" },
    { name: "hermes-director" },
    { name: "hermes-operations" },
  ]);
  assert.deepEqual(nodes.map((node) => node.id), ["default", "hermes-operations"]);

  const migrated = validateOrganizationNodes([
    { id: "default", parentId: null, department: "leadership", roomId: "executive", order: 0 },
    { id: "hermes-director", parentId: "default", department: "general", roomId: "operations", order: 99 },
    { id: "hermes-operations", parentId: "hermes-director", department: "operations", roomId: "operations", order: 1 },
  ]);
  assert.equal(migrated.filter((node) => node.id === "default").length, 1);
  assert.equal(migrated.find((node) => node.id === "default")?.roomId, "executive");
  assert.equal(migrated.find((node) => node.id === "hermes-operations")?.parentId, "default");
});

test("drag-style moves reject reporting cycles", () => {
  const nodes = buildDefaultOrganizationNodes(profiles);
  assert.throws(
    () => moveOrganizationNode(nodes, "default", "hermes-brand"),
    /순환 보고선/,
  );
  const moved = moveOrganizationNode(nodes, "external-agent", "hermes-brand");
  assert.equal(moved.find((node) => node.id === "external-agent")?.parentId, "hermes-brand");
});

test("adding and removing a member preserves a valid tree and reparents children", () => {
  const base = buildDefaultOrganizationNodes(profiles.slice(0, 3));
  const added = addOrganizationNode(base, "external-agent", { parentId: "hermes-brand", roomId: "creative" });
  assert.equal(added.find((node) => node.id === "external-agent")?.parentId, "hermes-brand");
  const removed = removeOrganizationNode(added, "hermes-brand");
  assert.equal(removed.find((node) => node.id === "external-agent")?.parentId, "hermes-operations");
  assert.doesNotThrow(() => validateOrganizationNodes(removed));
});

test("room assignments are derived only from validated organization nodes", () => {
  const nodes = buildDefaultOrganizationNodes(profiles);
  const assignments = organizationRoomAssignments(nodes);
  assert.equal(assignments.default, "executive");
  assert.equal(assignments["hermes-brand"], "brand");
  assert.throws(
    () => organizationRoomAssignments([{ id: "default", parentId: "missing", roomId: "tech" }]),
    /Unknown parent/,
  );
});

test("reporting context exposes manager, direct reports, depth, and the full escalation path", () => {
  const nodes = moveOrganizationNode(buildDefaultOrganizationNodes(profiles), "external-agent", "hermes-brand");
  const context = organizationReportingContext(nodes, "hermes-brand");
  assert.equal(context.managerId, "hermes-operations");
  assert.deepEqual(context.directReportIds, ["external-agent"]);
  assert.deepEqual(context.escalationPathIds, ["default", "hermes-operations", "hermes-brand"]);
  assert.equal(context.depth, 2);
});

test("department filters preserve every ancestor required to understand the reporting line", () => {
  const nodes = moveOrganizationNode(buildDefaultOrganizationNodes(profiles), "external-agent", "hermes-brand").map((node) => (
    node.id === "external-agent" ? { ...node, department: "review" } : node
  ));
  // The invariant under test is that a department held by a leaf alone still
  // resolves the whole chain above it, so no ancestor may share the filter.
  assert.deepEqual(nodes.filter((node) => node.department === "review").map((node) => node.id), ["external-agent"]);
  const visible = organizationVisibleNodeIds(nodes, "review");
  assert.deepEqual(visible, new Set(["external-agent", "hermes-brand", "hermes-operations", "default"]));
  assert.deepEqual(organizationVisibleNodeIds(nodes, "all"), new Set(nodes.map((node) => node.id)));
});

test("B1 organization console separates live operations from staged structure editing", async () => {
  const [workspaceSource, appSource, serverSource, b1Styles, mainSource] = await Promise.all([
    readFile(new URL("../src/TeamWorkspace.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../src/organizationB1.css", import.meta.url), "utf8"),
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspaceSource, /\["hierarchy", "조직도"\]/);
  assert.match(workspaceSource, /draggable={editing}/);
  assert.match(workspaceSource, /editing && draggedId && draggedId !== node\.id\) onDrop\(node\.id\)/);
  assert.match(workspaceSource, /구조 편집/);
  assert.match(workspaceSource, /변경사항 저장/);
  assert.match(workspaceSource, /setDraftNodes\(validated\)/);
  assert.match(workspaceSource, /await onSave\(validateOrganizationNodes\(draftNodes\)\)/);
  assert.match(workspaceSource, /organization-departments/);
  assert.match(workspaceSource, /MEMBER BRIEF/);
  assert.match(workspaceSource, /REPORTING LINE/);
  assert.match(workspaceSource, /WORKSPACE AUTHORITY/);
  assert.match(workspaceSource, /HERMES PROFILE SCOPE/);
  assert.match(workspaceSource, /조직도에서 제외/);
  assert.match(workspaceSource, /오피스 룸/);
  assert.match(workspaceSource, /저장 전에는 반영되지 않습니다/);
  assert.match(workspaceSource, /role="tablist"/);
  assert.match(workspaceSource, /role="tree"/);
  assert.match(workspaceSource, /<DepartmentIcon id={department\.id}/);
  assert.doesNotMatch(workspaceSource, /department\.label\.slice\(0, 1\)/);
  assert.doesNotMatch(workspaceSource, /member\.initials/);
  assert.match(appSource, /roomAssignments={roomAssignments}/);
  assert.match(appSource, /missions={effectiveMissions}/);
  assert.match(appSource, /onOpenOffice={\(\) => navigate\("office"\)}/);
  assert.match(appSource, /onSaveOrganization={saveOrganizationStructure}/);
  assert.match(appSource, /const normalizedNodes = validateOrganizationNodes\(state\?\.nodes \?\? \[\]\)/);
  assert.match(appSource, /await saveOrganization\(normalizedNodes, state\.revision\)/);
  assert.doesNotMatch(appSource, /\.filter\(\(profile\) => TEAM_META\[profile\.name\]\)/);
  assert.match(serverSource, /url\.pathname === "\/bridge\/organization"/);
  assert.match(serverSource, /baseRevision/);
  assert.match(mainSource, /organizationB1\.css/);
  assert.match(b1Styles, /grid-template-columns: minmax\(440px, 1fr\) minmax\(318px, 346px\)/);
  assert.match(b1Styles, /width: min\(100%, 520px\)/);
  assert.match(b1Styles, /\.team-workspace\.organization-mode > aside[\s\S]*display: block !important/);
  assert.match(b1Styles, /@container \(max-width: 900px\)/);
  assert.match(b1Styles, /flex: 1 1 auto/);
  assert.doesNotMatch(b1Styles, /min-height: min\(760px/);
  assert.match(b1Styles, /@media \(max-width: 1180px\)/);
  assert.match(b1Styles, /@media \(max-width: 820px\)/);
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

test("the organization has exactly the five confirmed departments, with exact ids and labels", () => {
  assert.deepEqual(ORGANIZATION_DEPARTMENTS, CONTRACT.map(([id, label]) => ({ id, label })));
  assert.equal(ORGANIZATION_DEPARTMENTS.length, 5);
  assert.equal(new Set(ORGANIZATION_DEPARTMENTS.map((department) => department.id)).size, 5);
  assert.deepEqual(
    ORGANIZATION_DEPARTMENTS.map((department) => department.label),
    ["관리부서", "실무부서", "검수부서", "지원부서", "반복부서(크론잡)"],
  );
  // No v1 department id may survive as a live filter.
  for (const legacy of V1_DEPARTMENT_IDS) {
    assert.ok(
      !ORGANIZATION_DEPARTMENTS.some((department) => department.id === legacy),
      `${legacy} is a v1 department and must not remain on the contract`,
    );
  }
  assert.ok(ORGANIZATION_DEPARTMENTS.some((department) => department.id === ORGANIZATION_DEFAULT_DEPARTMENT));
  assert.deepEqual(
    CONTRACT.map(([id]) => organizationDepartmentLabel(id)),
    CONTRACT.map(([, label]) => label),
  );
  // A department that no longer exists still reads as something truthful.
  assert.equal(organizationDepartmentLabel("leadership"), "지원부서");
});

test("the department assignment table covers exactly the eighteen role slots", () => {
  assert.deepEqual(Object.keys(BIBI_DEPARTMENT_ASSIGNMENTS).sort(), [...BIBI_PROFILE_IDS].sort());
  assert.ok(Object.isFrozen(BIBI_DEPARTMENT_ASSIGNMENTS));
  const contractIds = new Set(ORGANIZATION_DEPARTMENTS.map((department) => department.id));
  for (const [id, department] of Object.entries(BIBI_DEPARTMENT_ASSIGNMENTS)) {
    assert.ok(contractIds.has(department), `${id} is assigned to an unknown department: ${department}`);
  }
});

test("the eighteen members are partitioned 2/7/3/5/1 with no duplicate and no omission", () => {
  const nodes = canonicalNodes();
  assert.equal(nodes.length, 18);
  assert.deepEqual(nodes.map((node) => node.id), BIBI_PROFILE_IDS);
  assert.equal(new Set(nodes.map((node) => node.id)).size, 18);

  const byDepartment = new Map(CONTRACT.map(([id]) => [id, []]));
  for (const node of nodes) {
    assert.ok(byDepartment.has(node.department), `${node.id} is filed under an unknown department: ${node.department}`);
    byDepartment.get(node.department).push(node.id);
  }
  for (const [id, label, members] of CONTRACT) {
    assert.deepEqual([...byDepartment.get(id)].sort(), [...members].sort(), `${label} membership must match the contract`);
  }
  assert.deepEqual(CONTRACT.map(([id]) => byDepartment.get(id).length), [2, 7, 3, 5, 1]);
  // Flattening the departments must rebuild the roster exactly: assigned once,
  // and nobody left off the chart.
  assert.deepEqual([...byDepartment.values()].flat().sort(), [...BIBI_PROFILE_IDS].sort());
});

test("the canonical chart keeps the declared reporting line while the departments change", () => {
  const nodes = canonicalNodes();
  assert.equal(nodes.find((node) => node.id === "bibi-01").parentId, null);
  assert.equal(nodes.filter((node) => node.id !== "bibi-01" && node.parentId === "bibi-01").length, 17);
  assert.equal(nodes.find((node) => node.id === "bibi-01").roomId, "executive");
  // Seating is its own contract now (see tests/bibiRoomSeating.test.js): the
  // roster is spread across every room instead of piling into 운영실.
  assert.deepEqual(
    [...new Set(nodes.map((node) => node.roomId))].sort(),
    ORGANIZATION_ROOMS.map((room) => room.id).sort(),
  );
});

// ---------------------------------------------------------------------------
// bibi-09 is a reviewer, not a producer
// ---------------------------------------------------------------------------

test("bibi-09 sits in 검수부서 and the chart labels the seat as review, not production", async () => {
  assert.equal(BIBI_DEPARTMENT_ASSIGNMENTS["bibi-09"], "review");
  assert.equal(canonicalNodes().find((node) => node.id === "bibi-09").department, "review");
  assert.equal(organizationDepartmentLabel("review"), "검수부서");
  assert.ok(
    !CONTRACT.find(([id]) => id === "execution")[2].includes("bibi-09"),
    "bibi-09 must not be filed with the producing members",
  );

  const wording = organizationMemberFunction("bibi-09");
  assert.match(wording, /마케팅 검토·피드백/);
  assert.match(wording, /제작 담당 아님/);
  // Only bibi-09 needs the override; every other card keeps the roster mandate.
  assert.deepEqual(BIBI_PROFILE_IDS.filter((id) => organizationMemberFunction(id)), ["bibi-09"]);
  // And the override is a chart label only: the canonical profile.json
  // transcription in the roster is left exactly as declared.
  assert.equal(bibiProfile("bibi-09").role, "마케터비비");
  assert.equal(bibiProfile("bibi-09").mandate, "마케팅 기획·실행 방향·독립 피드백");

  const workspace = await read("src/TeamWorkspace.jsx");
  assert.match(workspace, /const memberFunction = organizationMemberFunction\(node\.id\) \|\| meta\.role;/);
  assert.match(workspace, /<em>\{memberFunction\}<\/em>/);
  assert.match(workspace, /organizationMemberFunction\(selectedNode\.id\) \|\| selectedMeta\?\.role/);
});

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

test("every department v1 ever shipped has a declared destination on the contract", () => {
  assert.deepEqual(Object.keys(LEGACY_DEPARTMENT_MIGRATION).sort(), [...V1_DEPARTMENT_IDS].sort());
  const contractIds = new Set(ORGANIZATION_DEPARTMENTS.map((department) => department.id));
  for (const legacy of V1_DEPARTMENT_IDS) {
    const migrated = migrateOrganizationDepartment("external-agent", legacy);
    assert.equal(migrated, LEGACY_DEPARTMENT_MIGRATION[legacy], `${legacy} must follow the declared table`);
    assert.ok(contractIds.has(migrated), `${legacy} migrated to an unknown department: ${migrated}`);
  }
  // Anything never shipped still lands somewhere real rather than nowhere.
  assert.equal(migrateOrganizationDepartment("external-agent", "no-such-department"), ORGANIZATION_DEFAULT_DEPARTMENT);
  assert.equal(migrateOrganizationDepartment("external-agent", undefined), ORGANIZATION_DEFAULT_DEPARTMENT);
  assert.equal(migrateOrganizationDepartment("external-agent", null), ORGANIZATION_DEFAULT_DEPARTMENT);
});

test("a role slot takes its contract department whatever v1 stored, and a v2 choice is preserved", () => {
  for (const legacy of V1_DEPARTMENT_IDS) {
    for (const [id, department] of Object.entries(BIBI_DEPARTMENT_ASSIGNMENTS)) {
      assert.equal(migrateOrganizationDepartment(id, legacy), department, `${id} stored as ${legacy}`);
    }
  }
  // A department the user picked by hand is not overwritten, so the structure
  // editor still works after v2 lands.
  assert.equal(migrateOrganizationDepartment("bibi-09", "execution"), "execution");
  assert.equal(migrateOrganizationDepartment("bibi-01", "support"), "support");
  assert.equal(migrateOrganizationDepartment("external-agent", "recurring"), "recurring");
});

test("a persisted v1 chart is migrated onto the five departments on read", () => {
  const stored = BIBI_PROFILE_IDS.map((id, index) => ({
    id,
    parentId: id === "bibi-01" ? null : "bibi-01",
    department: id === "bibi-01" ? "leadership" : "general",
    roomId: id === "bibi-01" ? "executive" : "operations",
    order: index,
  }));
  const migrated = validateOrganizationNodes(stored);

  assert.deepEqual(migrated, canonicalNodes());
  assert.deepEqual(
    CONTRACT.map(([id]) => migrated.filter((node) => node.department === id).length),
    [2, 7, 3, 5, 1],
  );
  assert.equal(migrated.find((node) => node.id === "bibi-09").department, "review");
  // Only the filing changes here: reporting lines and order are untouched.
  assert.deepEqual(migrated.map((node) => node.parentId), stored.map((node) => node.parentId));
  assert.deepEqual(migrated.map((node) => node.order), stored.map((node) => node.order));
  // Rooms do move, but by the seating contract rather than by the department
  // migration — this stored chart carries v1's "everyone in 운영실" collapse.
  assert.deepEqual(migrated.map((node) => node.roomId), migrated.map((node) => BIBI_ROOM_ASSIGNMENTS[node.id]));
});

test("a member added without a department lands on the contract, not on a v1 id", () => {
  const added = addOrganizationNode(canonicalNodes(), "external-agent", { parentId: "bibi-01" });
  const node = added.find((item) => item.id === "external-agent");
  assert.equal(node.department, ORGANIZATION_DEFAULT_DEPARTMENT);
  assert.ok(ORGANIZATION_DEPARTMENTS.some((department) => department.id === node.department));
});

// ---------------------------------------------------------------------------
// Write-back: a stored chart is repaired, not just relabelled on screen
// ---------------------------------------------------------------------------

test("write-back is requested for a v1 chart and refused for one already on the contract", () => {
  const canonical = canonicalNodes();
  assert.equal(organizationRequiresMigration(canonical), false);
  assert.equal(organizationRequiresMigration([]), false);
  assert.equal(organizationRequiresMigration(null), false);

  const v1 = canonical.map((node) => ({ ...node, department: node.id === "bibi-01" ? "leadership" : "general" }));
  assert.equal(organizationRequiresMigration(v1), true);
  assert.equal(organizationRequiresMigration([{ ...canonical[0], department: "general" }, ...canonical.slice(1)]), true);

  // The order rows come back in is not a reason to rewrite the chart.
  assert.equal(organizationRequiresMigration([...canonical].reverse()), false);

  // A collapsed profile alias is a repair the stored chart still needs.
  assert.equal(organizationRequiresMigration([
    { id: "default", parentId: null, department: "management", roomId: "executive", order: 0 },
    { id: "hermes-director", parentId: "default", department: "management", roomId: "executive", order: 1 },
  ]), true);

  // An unusable chart is a load error to surface, never a migration to persist
  // over the only copy of the structure.
  assert.equal(organizationRequiresMigration([{ id: "bibi-02", parentId: "missing-manager" }]), false);
});

test("the change ships as a version bump, not a silent default swap", async () => {
  assert.equal(ORGANIZATION_VERSION, 2);
  const [serverSource, appSource] = await Promise.all([read("server.js"), read("src/App.jsx")]);
  assert.match(serverSource, /version: ORGANIZATION_VERSION/);
  assert.match(appSource, /useState\(\{ version: ORGANIZATION_VERSION, revision: 0, nodes: \[\], audit: \[\] \}\)/);
});

test("every persistence path repairs a stored v1 chart instead of leaving it behind", async () => {
  const [appSource, serverSource, sql] = await Promise.all([
    read("src/App.jsx"),
    read("server.js"),
    read(MIGRATION_SQL),
  ]);

  // Hermes bridge: migrated on read and rewritten on disk atomically.
  assert.match(serverSource, /await migrateOrganizationStateFile\(\);/);
  assert.match(serverSource, /organizationRequiresMigration\(stored\.nodes \?\? \[\]\)/);
  const migrateFile = serverSource.slice(
    serverSource.indexOf("async function migrateOrganizationStateFile()"),
    serverSource.indexOf("async function updateOrganizationState"),
  );
  assert.ok(migrateFile.length > 200, "the local migration must exist");
  assert.match(migrateFile, /fs\.rename\(temporaryPath, organizationStatePath\)/);
  // Refiling a member is not a structural edit, so the compare-and-set base an
  // open editor already holds must survive it.
  assert.doesNotMatch(migrateFile, /revision/);

  // Browser against the local bridge: normalized chart saved back under CAS.
  assert.match(appSource, /const normalizedNodes = validateOrganizationNodes\(state\?\.nodes \?\? \[\]\)/);
  assert.match(appSource, /const requiresMigration = organizationRequiresMigration\(state\?\.nodes \?\? \[\]\)/);
  assert.match(appSource, /await saveOrganization\(normalizedNodes, state\.revision\)/);

  // Browser against the cloud: the same repair, behind the same revision CAS.
  assert.match(appSource, /if \(!organizationRequiresMigration\(cloudOrganization\.nodes\)\) return;/);
  assert.match(appSource, /expectedRevision: cloudOrganization\.revision/);
  assert.match(appSource, /saveError\.status === 409 && saveError\.current/);

  // Supabase: forward-only, department-only, never destructive.
  assert.match(sql, /update public\.bibi_organization_states/i);
  assert.match(sql, /jsonb_set\([\s\S]*?'\{department\}'/);
  assert.match(sql, /revision = state\.revision \+ 1/);
  assert.match(sql, /audit = state\.audit \|\|/);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.bibi_organization_states/i);
  assert.doesNotMatch(sql, /'\{parentId\}'|'\{roomId\}'|'\{order\}'|'\{id\}'/);
});

test("the Supabase migration files members exactly as the browser migration does", async () => {
  const sql = await read(MIGRATION_SQL);
  for (const [id, department] of Object.entries(BIBI_DEPARTMENT_ASSIGNMENTS)) {
    assert.ok(sql.includes(`('${id}', '${department}')`), `${id} must migrate to ${department} in SQL`);
  }
  for (const [legacy, department] of Object.entries(LEGACY_DEPARTMENT_MIGRATION)) {
    assert.ok(sql.includes(`('${legacy}', '${department}')`), `${legacy} must map to ${department} in SQL`);
  }
  // A department already on the contract is preserved on both sides, and the
  // guard makes re-applying the migration a no-op.
  for (const [id] of CONTRACT) {
    assert.ok(sql.includes(`'${id}'`), `${id} must be recognised as already migrated`);
  }
  assert.match(sql, /not in \('management', 'execution', 'review', 'support', 'recurring'\)/);
});

// ---------------------------------------------------------------------------
// Nothing else about the chart regresses
// ---------------------------------------------------------------------------

test("department filtering still resolves the whole reporting line above the match", () => {
  const nodes = validateOrganizationNodes(canonicalNodes().map((node) => (
    node.id === "bibi-11" ? { ...node, parentId: "bibi-12" } : node
  )));
  // Only the leaf holds the filtered department, so the ancestors can only be
  // visible because the filter walks the reporting line up.
  assert.deepEqual(nodes.filter((node) => node.department === "recurring").map((node) => node.id), ["bibi-11"]);
  assert.deepEqual(organizationVisibleNodeIds(nodes, "recurring"), new Set(["bibi-11", "bibi-12", "bibi-01"]));
  assert.equal(organizationVisibleNodeIds(nodes, "all").size, 18);
  for (const [id, , members] of CONTRACT) {
    assert.ok(organizationVisibleNodeIds(nodes, id).size >= members.length, `${id} must stay filterable`);
  }
});

test("the chart filters, labels, counts and icons all come from the contract", async () => {
  const workspace = await read("src/TeamWorkspace.jsx");
  assert.match(workspace, /const departmentRows = ORGANIZATION_DEPARTMENTS/);
  assert.match(workspace, /count: nodes\.filter\(\(node\) => node\.department === department\.id\)\.length/);
  assert.match(workspace, /organizationDepartmentLabel\(node\.department\)/);
  assert.match(workspace, /organizationDepartmentLabel\(selectedNode\.department\)/);
  // The structure editor still offers every contract department, and the
  // revision conflict guard on staged edits is untouched.
  assert.match(workspace, /ORGANIZATION_DEPARTMENTS\.map\(\(department\) => <option key=\{department\.id\} value=\{department\.id\}>/);
  assert.match(workspace, /const revisionConflict = editing && editingBaseRevision != null && organization\?\.revision !== editingBaseRevision;/);
  assert.match(workspace, /await onSave\(validateOrganizationNodes\(draftNodes\)\)/);

  for (const [id] of CONTRACT) {
    assert.ok(workspace.includes(`    ${id}: <>`), `${id} needs a department icon`);
  }
  for (const legacy of V1_DEPARTMENT_IDS) {
    assert.doesNotMatch(workspace, new RegExp(`^\\s{4}${legacy}: <`, "m"), `the ${legacy} icon must be gone`);
  }
  // "공통" was the v1 catch-all label; nothing may fall back to it any more.
  assert.doesNotMatch(workspace, /공통/);
});

// ---------------------------------------------------------------------------
// Chart layout — the regressions fresh browser QA found at 1440x1000 and 390x844
// ---------------------------------------------------------------------------

/**
 * Slice a CSS block by its opening line, matching braces so nested rules
 * survive. `from` picks a later occurrence: the stylesheet carries more than
 * one `@media (max-width: 820px)` block and the Team console rules are in the
 * last of them, so a plain first-match would read the wrong one.
 */
function cssBlock(styles, header, from = 0) {
  const start = styles.indexOf(header, from);
  assert.notEqual(start, -1, `${header} must exist in organizationB1.css`);
  let depth = 0;
  for (let index = styles.indexOf("{", start); index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    else if (styles[index] === "}" && (depth -= 1) === 0) return styles.slice(start, index + 1);
  }
  throw new Error(`${header} is unterminated`);
}

test("every department filter stays on screen without a sideways scroll", async () => {
  const b1Styles = await read("src/organizationB1.css");
  const bar = cssBlock(b1Styles, ".organization-departments {");
  const button = cssBlock(b1Styles, ".organization-departments button {");

  // QA at 1440x1000 measured scrollWidth 890 against clientWidth 612, and 882
  // against 388 at 390x844: a nowrap row on overflow-x:auto hid the last
  // departments off screen. The row wraps now, and nothing scrolls sideways.
  assert.match(bar, /flex-wrap: wrap;/);
  assert.doesNotMatch(bar, /overflow-x:\s*(auto|scroll)/);
  assert.doesNotMatch(bar, /scrollbar-width/);
  // max-content is what stops a wrapped filter from clipping its own label.
  assert.match(button, /min-width: max-content;/);
  assert.match(button, /flex: 1 1 auto;/);

  // Each of the five departments must carry a readable headcount, so the count
  // column may not be dropped on the narrowest phones.
  const narrow = cssBlock(b1Styles, "@media (max-width: 520px) {");
  assert.match(narrow, /\.team-page \.organization-departments button \{ grid-template-columns: 22px minmax\(0, auto\) 20px; \}/);
  assert.doesNotMatch(narrow, /\.organization-departments button > b \{ display: none/);

  const workspace = await read("src/TeamWorkspace.jsx");
  assert.match(workspace, /<strong>\{department\.label\}<\/strong>/);
  assert.match(workspace, /<b>\{department\.count\}<\/b>/);
});

test("the mobile chart has a real vertical scroll path to all eighteen cards", async () => {
  const b1Styles = await read("src/organizationB1.css");
  const mobile = cssBlock(b1Styles, "@media (max-width: 820px) {", b1Styles.lastIndexOf("@media (max-width: 820px) {"));

  // QA at 390x844: the panel measured scrollHeight 2704 against clientHeight
  // 246 with overflow hidden all the way down and no scroll candidate at all,
  // so every card past the first viewport was unreachable. The hierarchy tab
  // owns one real scroller now.
  assert.match(mobile, /\.team-page \.team-hierarchy-panel \{\s*overflow-y: auto;\s*overscroll-behavior: contain;\s*\}/);
  // …and the chart inside it takes its natural height instead of being capped.
  assert.match(
    mobile,
    /\.team-page \.team-hierarchy-panel \.organization-hierarchy,\s*\.team-page \.team-hierarchy-panel \.organization-layout,\s*\.team-page \.team-hierarchy-panel \.organization-canvas,\s*\.team-page \.team-hierarchy-panel \.organization-tree-scroll \{\s*height: auto;\s*min-height: 0;\s*overflow-y: visible;\s*\}/,
  );
  // The other Team tabs keep their own scroll container, untouched.
  assert.match(mobile, /\.team-page \.team-detail \{ overflow-y: auto; \}/);
});
