import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(projectRoot, "supabase", "migrations");

const CHAT_MIGRATION = "20260824000500_bibi_chat_execution.sql";
const FIX_MIGRATION = "20260824000600_bibi_claim_work_qualified.sql";

/** Migrations 001-005 are applied on the remote database. A forward-only set
 *  may append; it may never rewrite history, because a rewritten file is a file
 *  that will never run again anywhere it already applied. These digests are the
 *  guard: change one of those files and this test fails, which is the point. */
const APPLIED_DIGESTS = {
  "20260824000100_bibi_workspace_core.sql":
    "852f43f236e1f079d4d3ba82e6c412445db3c06e277c974ac5ab007423a8f525",
  "20260824000200_bibi_workspace_rls.sql":
    "8bc166c5820c440343cbf9a267e40bab33ed728744cfcf388ea1267c7f42fdab",
  "20260824000300_bibi_workspace_realtime.sql":
    "4b119cb6e0aca0c514478a1fd534cbb64965b4b0b9b733d56c5f872a54cd2000",
  "20260824000400_bibi_claim_work.sql":
    "841c48091b3579475d3ccb1b3f6b9cd428d0abed7f81eccda6a208f86a70fbe7",
  [CHAT_MIGRATION]: "b065a3bd89168666b233a77a6df23b9978af63caa7f3768860eaa424d89a4dd1",
};

const SIGNATURE = "public\\.bibi_claim_work\\s*\\(\\s*uuid\\s*,\\s*uuid\\s*,\\s*integer\\s*,\\s*integer\\s*\\)";

async function migration(name) {
  return readFile(path.join(migrationsDir, name), "utf8");
}

/** The `create function ... as $$ ... $$;` span, so assertions about the body
 *  cannot be satisfied by a comment or by the grant block underneath it. */
function claimDefinition(sql) {
  const start = sql.search(/create (?:or replace )?function public\.bibi_claim_work/i);
  assert.ok(start >= 0, "bibi_claim_work must be defined");
  const bodyStart = sql.indexOf("as $$", start);
  assert.ok(bodyStart > start, "the definition must have a dollar-quoted body");
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  assert.ok(bodyEnd > bodyStart, "the dollar-quoted body must be closed");
  return sql.slice(start, bodyEnd + 3);
}

/** The column names of the `returns table (...)` clause, in order. */
function claimReturnColumns(sql) {
  const clause = claimDefinition(sql).match(/returns table\s*\(([\s\S]*?)\)\s*language/i);
  assert.ok(clause, "bibi_claim_work must return a table");
  return clause[1]
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** Statements of the plpgsql body with SQL comments stripped. The comments in
 *  this migration quote the very patterns the tests below forbid. */
function executableBody(sql) {
  const definition = claimDefinition(sql);
  const body = definition.slice(definition.indexOf("as $$") + 5);
  return body.replace(/--[^\n]*/g, "");
}

// ---------------------------------------------------------------------------
// The fix is a new migration, not an edit
// ---------------------------------------------------------------------------

test("migration 006 exists and applies after the chat migration", async () => {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

  assert.ok(files.includes(FIX_MIGRATION), `${FIX_MIGRATION} must exist`);
  assert.ok(files.indexOf(FIX_MIGRATION) >= 0, "the claim fix remains in the forward migration chain");
  assert.ok(
    files.indexOf(FIX_MIGRATION) > files.indexOf(CHAT_MIGRATION),
    "the fix must apply after the migration that introduced the ambiguity",
  );
});

test("migrations 001-005 are byte-identical to what is already applied remotely", async () => {
  for (const [name, digest] of Object.entries(APPLIED_DIGESTS)) {
    const contents = await readFile(path.join(migrationsDir, name));
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      digest,
      `${name} is already applied remotely and must not be edited; fix forward in a new migration instead`,
    );
  }
});

// ---------------------------------------------------------------------------
// The ambiguity itself
// ---------------------------------------------------------------------------

test("the chat migration really does contain the reference that fails in production", async () => {
  // If this ever stops holding, migration 006 is fixing something that is no
  // longer there and the assertions below are measuring nothing.
  const body = executableBody(await migration(CHAT_MIGRATION));
  assert.match(
    body,
    /returning\s+work_item_id\s*\n/i,
    "005 must still carry the unqualified `returning work_item_id` this fix replaces",
  );
  assert.match(
    body,
    /on conflict\s*\(\s*work_item_id\s*,\s*attempt\s*\)/i,
    "005 must still carry the unqualified on-conflict column list",
  );
});

test("migration 006 leaves no reference that can collide with an OUT parameter", async () => {
  const sql = await migration(FIX_MIGRATION);
  const body = executableBody(sql);
  const outColumns = claimReturnColumns(sql);

  // `returning work_item_id` is where the connector's 500 came from:
  // work_item_id is both a command_leases column and an OUT parameter, and
  // plpgsql refuses to choose. Every returned column must carry a qualifier.
  const returningLists = [...body.matchAll(/returning\s+([\s\S]*?)(?=\n\s*(?:\)|on conflict|from|where|;))/gi)];
  assert.ok(returningLists.length > 0, "the claim must still return its leased rows");
  for (const match of returningLists) {
    for (const item of match[1].split(",")) {
      const reference = item.trim().split(/\s+/)[0];
      if (!reference) continue;
      assert.match(
        reference,
        /^\w+\./,
        `returning must qualify ${reference}: it collides with the OUT parameter of the same name`,
      );
    }
  }

  // An on-conflict column list is parse-analysed as an expression against the
  // target relation and cannot take a qualifier, so the arbiter has to be named
  // by constraint instead.
  assert.doesNotMatch(
    body,
    /on conflict\s*\(/i,
    "an on-conflict column list re-introduces the ambiguity; name the constraint",
  );
  assert.match(
    body,
    /on conflict on constraint command_leases_work_item_id_attempt_key do nothing/i,
    "the arbiter must stay the (work_item_id, attempt) unique constraint, so a live-lease violation still raises",
  );

  // Nothing in the body may name an OUT parameter bare. `set <column> =` is the
  // one exception PostgreSQL forces: an UPDATE target list forbids qualifiers,
  // and it is resolved against the target relation, never against a variable.
  // The insert column list is resolved the same way and is stripped with it.
  const assignable = body
    .replace(/^\s*(?:set\s+)?\w+\s*=(?!=)/gm, " ")
    .replace(/insert into public\.command_leases as cl\s*\([^)]*\)/i, " ");
  for (const column of outColumns) {
    const bare = new RegExp(`(?<![\\w.])${column}(?![\\w.])`, "g");
    const hits = [...assignable.matchAll(bare)];
    assert.equal(
      hits.length,
      0,
      `${column} is referenced without a table qualifier and is also an OUT parameter: ${hits.map((hit) => assignable.slice(Math.max(0, hit.index - 40), hit.index + 40)).join(" | ")}`,
    );
  }
});

test("migration 006 asserts the arbiter constraint exists before it depends on it", async () => {
  const sql = await migration(FIX_MIGRATION);
  const guard = sql.slice(0, sql.search(/create function public\.bibi_claim_work/i));

  // Naming a constraint that is not there would swap a runtime 42702 for a
  // runtime undefined_object. The guard turns that into a failed migration
  // instead of a connector that still cannot poll.
  assert.match(guard, /pg_catalog\.pg_constraint/);
  assert.match(guard, /command_leases_work_item_id_attempt_key/);
  assert.match(guard, /raise exception/i);
});

// ---------------------------------------------------------------------------
// Nothing else about the function moves
// ---------------------------------------------------------------------------

test("the replacement keeps the chat-aware row type exactly as the connector reads it", async () => {
  const before = claimReturnColumns(await migration(CHAT_MIGRATION));
  const after = claimReturnColumns(await migration(FIX_MIGRATION));

  // Identical, and in order: store.claimWork maps the RPC rows by name, so a
  // dropped or renamed column is a silently undefined field on the connector
  // side rather than an error.
  assert.deepEqual(after, before, "006 must not change the claim's OUT row type");
  assert.ok(after.includes("kind"), "the claim must still carry the chat marker");
  assert.ok(after.includes("conversation_id"), "the claim must still carry the conversation to reply into");

  const store = await readFile(path.join(projectRoot, "api", "_lib", "store.js"), "utf8");
  const mapping = store.slice(store.indexOf("async claimWork("), store.indexOf("async renewLease("));
  assert.ok(mapping.includes("bibi_claim_work"), "store.claimWork must still call the RPC");
  for (const column of after) {
    assert.ok(mapping.includes(`row.${column}`), `store.claimWork reads row.${column}; it must survive`);
  }
});

test("the replacement preserves the reclaim and the disjoint batch", async () => {
  const sql = await migration(FIX_MIGRATION);
  const body = executableBody(sql);

  // Without skip-locked two pollers read the same assigned rows and both run
  // them; without the reclaim a slept Mac strands its work in `running`.
  assert.match(body, /for update skip locked/i);
  assert.match(body, /release_reason = 'lease expired'/);
  assert.match(body, /set status = 'assigned'/);
  assert.match(body, /set status = 'leased'/);
  assert.match(claimDefinition(sql), /security definer/i);
  assert.match(claimDefinition(sql), /set search_path = ''/);
});

test("migration 006 drops the exact claim signature before recreating it", async () => {
  const sql = await migration(FIX_MIGRATION);

  const drop = sql.match(new RegExp(`drop function if exists ${SIGNATURE}\\s*;`, "i"));
  assert.ok(drop, "006 must drop public.bibi_claim_work(uuid, uuid, integer, integer) by its exact signature");

  // Unqualified, the drop is ambiguous the moment a second overload exists;
  // `cascade` would silently take dependents with it.
  assert.doesNotMatch(sql, /drop function[^;]*bibi_claim_work[^;]*cascade/i);

  const create = sql.search(/create (?:or replace )?function public\.bibi_claim_work/i);
  assert.ok(create >= 0, "006 must recreate the claim");
  assert.ok(drop.index < create, "the drop must precede the replacement");
});

test("the replacement keeps its service-role-only privilege boundary", async () => {
  const sql = await migration(FIX_MIGRATION);
  const create = sql.search(/create (?:or replace )?function public\.bibi_claim_work/i);

  // A dropped function takes its grants with it and comes back with the default
  // `execute` to public. Without these, a browser session could call a security
  // definer function that bypasses RLS.
  for (const role of ["public", "anon", "authenticated"]) {
    const revoke = sql.search(new RegExp(`revoke all on function ${SIGNATURE} from ${role}\\s*;`, "i"));
    assert.ok(revoke >= 0, `006 must revoke the recreated claim from ${role}`);
    assert.ok(revoke > create, `the revoke from ${role} must come after the recreated definition`);
  }

  const grant = sql.search(new RegExp(`grant execute on function ${SIGNATURE} to service_role\\s*;`, "i"));
  assert.ok(grant >= 0, "006 must grant execute on the recreated claim to service_role");
  assert.ok(grant > create, "the grant must come after the recreated definition");

  // service_role is the only role that may ever hold execute on it.
  const grants = [...sql.matchAll(new RegExp(`grant\\s+\\w+\\s+on function ${SIGNATURE} to (\\w+)`, "gi"))];
  assert.deepEqual(
    grants.map((match) => match[1]),
    ["service_role"],
    "no role other than service_role may be granted the claim",
  );
});
