import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BIBI_PROFILE_IDS } from "../src/bibi/roster.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(projectRoot, "supabase", "migrations");

/** Tables that only the service role may ever touch. A client policy on one of
 *  these would hand a browser a connector credential. */
const SERVICE_ROLE_ONLY_TABLES = ["connector_credentials"];

/** Tables the signed-in owner reads through RLS. */
const OWNER_SCOPED_TABLES = [
  "connector_nodes",
  "conversations",
  "messages",
  "work_items",
  "work_events",
  "work_results",
  "work_evidence",
  "command_leases",
];

async function loadMigrations() {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const contents = await Promise.all(
    files.map(async (name) => [name, await readFile(path.join(migrationsDir, name), "utf8")]),
  );
  return { files, contents, sql: contents.map(([, body]) => body).join("\n") };
}

function createdTables(sql) {
  return [...sql.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)].map((match) => match[1]);
}

function policiesFor(sql, table) {
  return [...sql.matchAll(/create policy\s+"([^"]+)"\s+on public\.(\w+)([\s\S]*?);/gi)]
    .filter((match) => match[2] === table)
    .map((match) => ({ name: match[1], body: match[3] }));
}

test("migrations exist, are ordered and are forward-only", async () => {
  const { files, sql } = await loadMigrations();
  assert.ok(files.length >= 1, "at least one migration must exist");
  assert.deepEqual(files, [...files].sort(), "migration filenames must sort into apply order");
  assert.ok(files.every((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)), `unexpected migration name in ${files.join(", ")}`);

  // A forward migration set must never destroy data on apply.
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+schema\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+column\b/i);
});

test("every created table enables and forces row level security", async () => {
  const { sql } = await loadMigrations();
  const tables = createdTables(sql);
  assert.ok(tables.length >= 9, `expected the full schema, found: ${tables.join(", ")}`);

  for (const table of tables) {
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      `${table} must enable RLS`,
    );
    // FORCE matters: without it the table owner role bypasses every policy.
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} force row level security`, "i"),
      `${table} must force RLS`,
    );
  }
});

test("the expected tables are present", async () => {
  const { sql } = await loadMigrations();
  const tables = createdTables(sql);
  for (const table of [...OWNER_SCOPED_TABLES, ...SERVICE_ROLE_ONLY_TABLES, "bibi_profiles"]) {
    assert.ok(tables.includes(table), `${table} must be created`);
  }
});

test("owner-scoped tables restrict every policy to the authenticated owner", async () => {
  const { sql } = await loadMigrations();
  for (const table of OWNER_SCOPED_TABLES) {
    const policies = policiesFor(sql, table);
    assert.ok(policies.length > 0, `${table} must have at least one policy`);
    for (const policy of policies) {
      assert.match(policy.body, /to authenticated/i, `${table}.${policy.name} must target the authenticated role`);
      assert.match(policy.body, /auth\.uid\(\)/, `${table}.${policy.name} must be scoped by auth.uid()`);
      assert.doesNotMatch(policy.body, /using\s*\(\s*true\s*\)/i, `${table}.${policy.name} must not be unconditional`);
    }
  }
});

test("credential tables carry no client policy at all", async () => {
  const { sql } = await loadMigrations();
  for (const table of SERVICE_ROLE_ONLY_TABLES) {
    assert.deepEqual(
      policiesFor(sql, table).map((policy) => policy.name),
      [],
      `${table} must be reachable only through the service role`,
    );
  }
  // The connector secret must be stored hashed, never in plaintext.
  assert.match(sql, /token_hash/i);
  assert.doesNotMatch(sql, /token_plaintext|raw_token|token_value/i);
});

test("no policy is granted to anon or public", async () => {
  const { sql } = await loadMigrations();
  const policies = [...sql.matchAll(/create policy[\s\S]*?;/gi)].map((match) => match[0]);
  for (const policy of policies) {
    assert.doesNotMatch(policy, /\bto\s+anon\b/i, `anon must never hold a policy: ${policy.slice(0, 80)}`);
    assert.doesNotMatch(policy, /\bto\s+public\b/i, `public must never hold a policy: ${policy.slice(0, 80)}`);
  }
});

test("lifecycle-authoritative tables are not client-writable", async () => {
  const { sql } = await loadMigrations();
  // Events, results, evidence and leases are written by the API using the
  // service role after validating a transition. A browser may only read them.
  for (const table of ["work_events", "work_results", "work_evidence", "command_leases"]) {
    for (const policy of policiesFor(sql, table)) {
      assert.match(
        policy.body,
        /for select/i,
        `${table}.${policy.name} must be read-only for the client`,
      );
    }
  }
});

test("work items are owner-writable so intake works straight from the browser", async () => {
  const { sql } = await loadMigrations();
  const commands = policiesFor(sql, "work_items").map((policy) => {
    const match = policy.body.match(/for (select|insert|update|delete)/i);
    return match ? match[1].toLowerCase() : null;
  });
  assert.ok(commands.includes("select"));
  assert.ok(commands.includes("insert"));
});

test("the profile reference table holds exactly the eighteen physical profiles", async () => {
  const { sql } = await loadMigrations();
  for (const id of BIBI_PROFILE_IDS) {
    assert.ok(sql.includes(`'${id}'`), `${id} must be seeded`);
  }
  assert.ok(!sql.includes("'bibi-19'"));
  assert.ok(!sql.includes("'bibi-00'"));
  // Generic upstream identifiers must not exist as profiles.
  assert.doesNotMatch(sql, /'hermes-director'|'hermes-operations'/);
  assert.match(sql, /check \(id ~ '\^bibi-\(0\[1-9\]\|1\[0-8\]\)\$'\)/i);
});

test("the roster table maps each role slot to the physical profile that runs it", async () => {
  const { sql } = await loadMigrations();

  // CEO비비 runs on `default` (~/.hermes), not on a profile named bibi-01.
  assert.match(sql, /\('bibi-01',\s*1,\s*'default'/);
  assert.match(sql, /\('bibi-02',\s*2,\s*'bibi-02'/);
  assert.match(sql, /\('bibi-18',\s*18,\s*'bibi-18'/);

  // The constraint must make the rollback `bibi-01` directory unstorable as an
  // execution target, which is what stops it standing in for the CEO.
  assert.match(sql, /check \(execution_profile = 'default' or execution_profile ~ '\^bibi-\(0\[2-9\]\|1\[0-8\]\)\$'\)/);
  assert.match(sql, /execution_profile text not null unique/);

  // Evidence must be able to record which physical profile produced it.
  assert.match(sql, /execution_profile_id text/);
});

test("the seeded roster carries the canonical role, mandate and reporting line", async () => {
  const { sql } = await loadMigrations();
  const { BIBI_ROSTER } = await import("../src/bibi/roster.js");

  for (const entry of BIBI_ROSTER) {
    const escaped = (value) => value.replace(/'/g, "''");
    assert.ok(sql.includes(`'${escaped(entry.role)}'`), `${entry.id} role must be seeded`);
    assert.ok(sql.includes(`'${escaped(entry.mandate)}'`), `${entry.id} mandate must be seeded`);
  }
  // No placeholder may survive in the seeded rows. The check constraint still
  // permits UNCONFIRMED as a provenance value, so scope this to the seed block.
  const seed = sql.slice(
    sql.indexOf("insert into public.bibi_profiles"),
    sql.indexOf("on conflict (id) do nothing;"),
  );
  assert.ok(seed.length > 500, "the seed block must be present");
  assert.doesNotMatch(seed, /'비비 \d{2}'/);
  assert.doesNotMatch(seed, /'UNCONFIRMED'/);
  assert.equal((seed.match(/'CONFIRMED'/g) ?? []).length, 18);
  assert.match(sql, /reports_to text not null/);
  assert.match(sql, /role text not null/);
  assert.match(sql, /mandate text not null/);
});

test("owner scoping columns are indexed and cascade with the owner", async () => {
  const { sql } = await loadMigrations();
  for (const table of OWNER_SCOPED_TABLES) {
    assert.match(
      sql,
      new RegExp(`create index (?:if not exists )?\\w*${table}\\w*owner\\w* on public\\.${table}`, "i"),
      `${table}.owner_id must be indexed for RLS predicates`,
    );
  }
  assert.match(sql, /references auth\.users\s*\(id\)\s*on delete cascade/i);
});

test("intake idempotency is enforced in the database, not only in the client", async () => {
  const { sql } = await loadMigrations();
  assert.match(
    sql,
    /unique\s*\(\s*owner_id\s*,\s*client_request_id\s*\)|create unique index[\s\S]*?work_items\s*\(\s*owner_id\s*,\s*client_request_id\s*\)/i,
  );
  // A replayed connector event must not be able to double-apply.
  assert.match(sql, /unique\s*\(\s*work_item_id\s*,\s*event_id\s*\)/i);
});

test("realtime publishes the tables the workspace subscribes to", async () => {
  const { sql } = await loadMigrations();
  for (const table of ["work_items", "work_events", "messages", "connector_nodes"]) {
    assert.match(
      sql,
      new RegExp(`alter publication supabase_realtime add table public\\.${table}`, "i"),
      `${table} must be published for realtime`,
    );
  }
});
