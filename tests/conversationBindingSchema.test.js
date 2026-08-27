/**
 * Schema contract for Telegram binding onboarding.
 *
 * The rule this file exists to hold is one sentence: nothing that the browser or
 * the API can write on its own may mark a binding verified. `20260824000800`
 * defaulted `binding_state` to `'verified'`, which made that sentence false by
 * default — any row that reached the table without naming a state was treated as
 * proven, and `bibi_apply_message_projection` accepts exactly those rows.
 *
 * So the assertions below are about who can reach which state, not about column
 * shapes. The guard trigger is checked for its fail-closed default, the
 * verification function for being the only thing that opens the gate, and every
 * one of them for being unreachable from `authenticated`.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrations = path.join(root, "supabase", "migrations");

async function onboardingMigration() {
  const names = (await readdir(migrations))
    .filter((name) => name.endsWith("_bibi_conversation_binding_onboarding.sql"))
    .sort();
  assert.equal(names.length, 1, "one forward-only binding onboarding migration is required");
  return readFile(path.join(migrations, names[0]), "utf8");
}

/** Every function this migration adds, with the argument list its grants name. */
const FUNCTIONS = [
  ["bibi_request_conversation_binding", "uuid, uuid, text, text, text, text, text"],
  ["bibi_cancel_conversation_binding", "uuid, uuid, text"],
  ["bibi_verify_conversation_binding", "uuid, uuid, uuid, text, text, text, text, jsonb"],
  ["bibi_fail_conversation_binding", "uuid, uuid, uuid, text, text"],
  ["bibi_record_telegram_session_scan", "uuid, uuid, text, text, jsonb, text, timestamptz"],
];

// ---------------------------------------------------------------------------
// The unsafe default
// ---------------------------------------------------------------------------

test("a binding created without naming a state is pending, not verified", async () => {
  const sql = await onboardingMigration();
  assert.match(sql, /alter table public\.conversation_bindings\s+alter column binding_state set default 'pending';/i);
});

test("a user-initiated binding may only ever be created pending", async () => {
  const sql = await onboardingMigration();
  assert.match(sql, /initiation_source text not null default 'user'/i);
  assert.match(
    sql,
    /tg_op = 'INSERT' and new\.initiation_source = 'user' and new\.binding_state <> 'pending'[\s\S]*?raise exception 'a user initiated binding may only be created pending'/i,
  );
});

// ---------------------------------------------------------------------------
// The fail-closed guard
// ---------------------------------------------------------------------------

test("reaching verified requires a transaction flag only the connector function sets", async () => {
  const sql = await onboardingMigration();

  // Fail closed: `current_setting(..., true)` returns null when unset, and the
  // coalesce turns that into a value that cannot equal 'connector'.
  assert.match(
    sql,
    /coalesce\(current_setting\('bibi\.binding_verification', true\), ''\) <> 'connector'[\s\S]*?raise exception 'binding verification requires the authenticated connector'/i,
  );
  // Exactly one place sets it, and it is the connector verification function.
  const setters = [...sql.matchAll(/set_config\('bibi\.binding_verification', 'connector'/g)];
  assert.equal(setters.length, 1, "only bibi_verify_conversation_binding may open the gate");
  const verifyBody = sql.slice(
    sql.indexOf("create or replace function public.bibi_verify_conversation_binding"),
    sql.indexOf("create or replace function public.bibi_fail_conversation_binding"),
  );
  assert.match(verifyBody, /perform set_config\('bibi\.binding_verification', 'connector', true\);/);
});

test("the guard runs before the existing identity validator", async () => {
  const sql = await onboardingMigration();
  assert.match(sql, /create trigger bibi_guard_binding_verification\s+before insert or update on public\.conversation_bindings/i);
  // Postgres fires BEFORE ROW triggers in name order, and the guard has to
  // decide before anything else touches the row.
  assert.ok(
    "bibi_guard_binding_verification" < "bibi_validate_conversation_binding",
    "the guard trigger name must sort before the validator's",
  );
});

test("verified is unreachable without recorded connector proof", async () => {
  const sql = await onboardingMigration();
  assert.match(
    sql,
    /check \(binding_state <> 'verified' or \(verified_at is not null and verified_by_node_id is not null\)\)/i,
  );
  assert.match(
    sql,
    /check \(binding_state <> 'pending' or \(verified_at is null and verified_by_node_id is null\)\)/i,
  );
  assert.match(sql, /verified_by_node_id uuid references public\.connector_nodes \(id\)/i);
  assert.match(sql, /new\.verified_at is null or new\.verified_by_node_id is null[\s\S]*?raise exception 'binding verification requires connector proof'/i);
});

test("verification must name back the exact identity that was requested", async () => {
  const sql = await onboardingMigration();
  const verifyBody = sql.slice(
    sql.indexOf("create or replace function public.bibi_verify_conversation_binding"),
    sql.indexOf("create or replace function public.bibi_fail_conversation_binding"),
  );
  for (const column of ["channel_account_id", "external_conversation_id", "hermes_session_id", "execution_profile_id"]) {
    assert.match(verifyBody, new RegExp(`v_binding\\.${column} is distinct from p_${column}`, "i"));
  }
  assert.match(verifyBody, /raise exception 'binding verification identity mismatch'/i);
  // The connector node has to belong to the owner it is verifying for.
  assert.match(verifyBody, /from public\.connector_nodes\s+where id = p_connector_node_id and owner_id = p_owner_id/i);
  // A cancelled or blocked binding is not silently re-verified.
  assert.match(verifyBody, /binding_state <> 'pending'[\s\S]*?raise exception 'only a pending binding may be verified'/i);
});

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

test("no binding function is callable by a signed-in browser", async () => {
  const sql = await onboardingMigration();
  for (const [name, args] of FUNCTIONS) {
    for (const role of ["public", "anon", "authenticated"]) {
      assert.match(
        sql,
        new RegExp(`revoke all on function public\\.${name}\\(${args.replace(/[()]/g, "\\$&")}\\) from ${role};`, "i"),
        `${name} must be revoked from ${role}`,
      );
    }
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${name}\\(${args.replace(/[()]/g, "\\$&")}\\) to service_role;`, "i"),
      `${name} must be service-role only`,
    );
  }
});

test("idempotent create, cancel and retry are all backed by the database", async () => {
  const sql = await onboardingMigration();
  // Same submission twice returns the first row rather than racing the unique
  // identity constraint.
  assert.match(sql, /create unique index if not exists conversation_bindings_client_request_idx[\s\S]*?where client_request_id is not null/i);
  assert.match(sql, /where owner_id = p_owner_id and client_request_id = p_client_request_id;[\s\S]*?return query select v_binding\.id, v_binding\.binding_state, true, false;/i);
  // A retry reuses the row and clears the stale failure reason.
  assert.match(sql, /set binding_state = 'pending',[\s\S]*?verification_code = null,\s*verification_error = null,\s*cancelled_at = null,\s*request_count = request_count \+ 1/i);
  // Cancelling twice is not an error.
  assert.match(sql, /if v_binding\.binding_state = 'unbound' then\s*return query select v_binding\.id, v_binding\.binding_state, true;/i);
  // Failure state carries a code and an error for the UI to explain.
  assert.match(sql, /verification_code text/i);
  assert.match(sql, /verification_error text/i);
  assert.match(sql, /verification_attempts integer not null default 0/i);
});

test("disconnecting unbinds a channel and deletes no canonical message", async () => {
  const sql = await onboardingMigration();
  // Comments stripped: the function's own comment names the tables it leaves
  // alone, and naming them is the opposite of touching them.
  const cancelBody = sql.slice(
    sql.indexOf("create or replace function public.bibi_cancel_conversation_binding"),
    sql.indexOf("create or replace function public.bibi_verify_conversation_binding"),
  ).replace(/--[^\n]*/g, "");
  assert.match(cancelBody, /set binding_state = 'unbound'/i);
  assert.doesNotMatch(cancelBody, /delete from/i);
  assert.doesNotMatch(cancelBody, /projected_messages/i);
  assert.doesNotMatch(cancelBody, /public\.messages/i);
  // The conversation stops claiming a sync it no longer has.
  assert.match(cancelBody, /update public\.conversations[\s\S]*?sync_status = 'local-only'/i);
});

test("every binding lifecycle change lands in the append-only audit log", async () => {
  const sql = await onboardingMigration();
  assert.match(sql, /'pair', 'bind', 'verify_failed', 'project'/i);
  for (const [fn, type] of [
    ["bibi_request_conversation_binding", "pair"],
    ["bibi_cancel_conversation_binding", "unbind"],
    ["bibi_verify_conversation_binding", "bind"],
    ["bibi_fail_conversation_binding", "verify_failed"],
  ]) {
    const start = sql.indexOf(`create or replace function public.${fn}`);
    assert.ok(start > 0, `${fn} must exist`);
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    assert.match(body, /insert into public\.conversation_audit_events/i, `${fn} must audit`);
    assert.match(body, new RegExp(`'${type}'`), `${fn} must audit as ${type}`);
    assert.match(body, /on conflict \(owner_id, event_id\) do nothing/i, `${fn} audit must be replay safe`);
  }
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("session discovery stores identity and reachability, never message content", async () => {
  const sql = await onboardingMigration();
  const table = sql.slice(
    sql.indexOf("create table if not exists public.bibi_telegram_sessions"),
    sql.indexOf("create table if not exists public.bibi_telegram_session_scans"),
  );
  assert.match(table, /hermes_session_id text not null/i);
  assert.match(table, /channel_account_id text/i);
  assert.match(table, /external_conversation_id text/i);
  assert.match(table, /message_count integer not null default 0/i);
  for (const forbidden of ["body", "content", "excerpt", "preview", "snippet", "title", "summary"]) {
    assert.doesNotMatch(table, new RegExp(`\\b${forbidden}\\b`, "i"), `discovery must not store ${forbidden}`);
  }
});

test("an unusable identity cannot be presented as connectable", async () => {
  const sql = await onboardingMigration();
  assert.match(
    sql,
    /check \(identity_complete = \(channel_account_id is not null and external_conversation_id is not null\)\)/i,
  );
});

test("discovery tables are owner scoped, forced-RLS and client read-only", async () => {
  const sql = await onboardingMigration();
  for (const table of ["bibi_telegram_sessions", "bibi_telegram_session_scans"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} force row level security`, "i"));
    assert.match(
      sql,
      new RegExp(`create policy "${table}_select_own" on public\\.${table}\\s+for select to authenticated using \\(owner_id = \\(select auth\\.uid\\(\\)\\)\\)`, "i"),
    );
  }
  assert.doesNotMatch(sql, /create policy[\s\S]*?for (?:insert|update|delete) to authenticated/i);
});

test("a session that vanished from the Mac vanishes from the picker", async () => {
  const sql = await onboardingMigration();
  assert.match(
    sql,
    /delete from public\.bibi_telegram_sessions t\s+where t\.owner_id = p_owner_id[\s\S]*?hermes_session_id not in/i,
  );
});

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

test("every table the canonical timeline depends on is published and replicates in full", async () => {
  const sql = await onboardingMigration();
  const published = [
    "conversations", "conversation_bindings", "projected_messages",
    "projection_checkpoints", "bibi_telegram_sessions", "bibi_telegram_session_scans",
  ];
  const block = sql.slice(sql.indexOf("foreach t in array array["), sql.indexOf("] loop"));
  for (const table of published) {
    assert.match(block, new RegExp(`'${table}'`), `${table} must be published`);
    // Realtime sends only the primary key on update and delete without this.
    assert.match(sql, new RegExp(`alter table public\\.${table} replica identity full;`, "i"));
  }
  // Adding a table that is already a member is an error, so the add is guarded.
  assert.match(sql, /if not exists \(\s*select 1 from pg_publication_tables/i);
});
