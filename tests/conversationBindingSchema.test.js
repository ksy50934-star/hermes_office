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
import { PGlite } from "@electric-sql/pglite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrations = path.join(root, "supabase", "migrations");

async function onboardingMigration() {
  const names = (await readdir(migrations))
    .filter((name) => name.endsWith("_bibi_conversation_binding_onboarding.sql"))
    .sort();
  assert.equal(names.length, 1, "one forward-only binding onboarding migration is required");
  return readFile(path.join(migrations, names[0]), "utf8");
}

async function rotationMigration() {
  const names = (await readdir(migrations))
    .filter((name) => name.endsWith("_bibi_conversation_binding_rotation.sql"))
    .sort();
  assert.equal(names.length, 1, "one forward-only binding rotation migration is required");
  return readFile(path.join(migrations, names[0]), "utf8");
}

async function profileScopedBindingMigration() {
  const names = (await readdir(migrations))
    .filter((name) => name.endsWith("_bibi_profile_scoped_telegram_binding.sql"))
    .sort();
  assert.equal(names.length, 1, "one forward-only profile-scoped binding migration is required");
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

test("rotation keeps the old binding as history and creates a separate pending binding", async () => {
  const sql = await rotationMigration();
  const replaceBody = sql.slice(
    sql.indexOf("create or replace function public.bibi_replace_conversation_binding"),
    sql.indexOf("revoke all on function public.bibi_replace_conversation_binding"),
  ).replace(/--[^\n]*/g, "");

  assert.match(sql, /conversation_bindings_live_conversation_channel_idx[\s\S]*?where binding_state <> 'unbound'/i);
  assert.match(sql, /array_agg\(att\.attname::text order by att\.attname::text\)/i);
  assert.match(sql, /request is only valid for the first binding; use a replacement session/i);
  assert.match(replaceBody, /pg_advisory_xact_lock\(pg_catalog\.hashtextextended\([\s\S]*?'bibi-binding:'[\s\S]*?p_conversation_id::text[\s\S]*?p_channel/i);
  assert.doesNotMatch(replaceBody, /from public\.conversations[\s\S]{0,200}?for update/i);
  assert.match(replaceBody, /(?:cb\.)?binding_state = 'unbound'[\s\S]*?order by (?:cb\.)?cancelled_at desc/i);
  assert.match(replaceBody, /if v_previous\.id is null then[\s\S]*?must be cancelled before a new session is requested/i);
  assert.match(replaceBody, /v_previous\.hermes_session_id = btrim\(p_hermes_session_id\)[\s\S]*?replacement must name a different Hermes session/i);
  assert.match(replaceBody, /binding_state <> 'unbound'[\s\S]*?for update/i);
  assert.match(replaceBody, /insert into public\.conversation_bindings[\s\S]*?'pending', 'user'/i);
  assert.match(replaceBody, /client request id was already used for a different binding request/i);
  assert.doesNotMatch(replaceBody, /update public\.conversation_bindings/i);
  assert.doesNotMatch(replaceBody, /delete from/i);
});

test("rotation migration executes twice and preserves the old row at runtime", async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.conversations (
      id uuid primary key, owner_id uuid not null, profile_id text not null,
      execution_profile_id text not null, sync_status text default 'local-only',
      sync_error text, telegram_mirroring_enabled boolean default false,
      updated_at timestamptz not null default now()
    );
    create table public.conversation_bindings (
      id uuid primary key default gen_random_uuid(), owner_id uuid not null,
      conversation_id uuid not null, organization_profile_id text not null,
      execution_profile_id text not null, channel text not null,
      channel_account_id text not null, external_conversation_id text not null,
      hermes_session_id text not null, binding_state text not null default 'pending',
      initiation_source text not null, client_request_id text,
      request_count integer not null default 1, verified_at timestamptz,
      verified_by_node_id uuid, verification_code text, verification_error text,
      cancelled_at timestamptz, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint old_channel_unique unique(owner_id, channel, channel_account_id, external_conversation_id),
      constraint old_conversation_unique unique(conversation_id, channel),
      constraint old_session_unique unique(owner_id, execution_profile_id, hermes_session_id),
      constraint old_request_unique unique(owner_id, client_request_id)
    );
    create table public.conversation_audit_events (
      id uuid primary key default gen_random_uuid(), owner_id uuid not null,
      conversation_id uuid not null, binding_id uuid, event_id text not null,
      event_type text not null, organization_profile_id text,
      execution_profile_id text, hermes_session_id text,
      payload jsonb not null default '{}'::jsonb, unique(owner_id, event_id)
    );
  `);
  const sql = await rotationMigration();
  await db.exec(sql);
  await db.exec(sql);
  const profileSql = await profileScopedBindingMigration();
  await db.exec(profileSql);
  await db.exec(profileSql);

  const owner = "11111111-1111-1111-1111-111111111111";
  const conversation = "22222222-2222-2222-2222-222222222222";
  await db.exec(`
    insert into conversations(id, owner_id, profile_id, execution_profile_id)
    values ('${conversation}', '${owner}', 'bibi-02', 'bibi-02');
    insert into conversation_bindings(
      id, owner_id, conversation_id, organization_profile_id,
      execution_profile_id, channel, channel_account_id,
      external_conversation_id, hermes_session_id, binding_state,
      initiation_source, cancelled_at, client_request_id
    ) values (
      '33333333-3333-3333-3333-333333333333', '${owner}', '${conversation}',
      'bibi-02', 'bibi-02', 'telegram', 'acct', 'chat', 'old-session',
      'unbound', 'user', now(), 'old-request'
    );
  `);

  await assert.rejects(
    db.query(`select * from public.bibi_request_conversation_binding(
      '${owner}', '${conversation}', 'telegram', 'acct', 'chat', 'old-session', 'bypass-request'
    )`),
    /request is only valid for the first binding; use a replacement session/i,
  );

  await assert.rejects(
    db.query(`select * from public.bibi_replace_conversation_binding(
      '${owner}', '${conversation}', 'telegram', 'acct', 'chat', 'old-session', 'same-session-request'
    )`),
    /replacement must name a different Hermes session/i,
  );

  const first = await db.query(`select * from public.bibi_replace_conversation_binding(
    '${owner}', '${conversation}', 'telegram', 'acct', 'chat', 'new-session', 'new-request'
  )`);
  const duplicate = await db.query(`select * from public.bibi_replace_conversation_binding(
    '${owner}', '${conversation}', 'telegram', 'acct', 'chat', 'new-session', 'new-request'
  )`);
  const rows = await db.query(`select hermes_session_id, binding_state
    from conversation_bindings order by hermes_session_id`);
  const constraints = await db.query(`select conname from pg_constraint
    where conrelid = 'public.conversation_bindings'::regclass and contype = 'u'`);

  assert.equal(first.rows[0].binding_state, "pending");
  assert.equal(first.rows[0].previous_binding_id, "33333333-3333-3333-3333-333333333333");
  assert.equal(duplicate.rows[0].binding_id, first.rows[0].binding_id);
  assert.equal(duplicate.rows[0].duplicate, true);
  assert.deepEqual(rows.rows, [
    { hermes_session_id: "new-session", binding_state: "pending" },
    { hermes_session_id: "old-session", binding_state: "unbound" },
  ]);
  assert.deepEqual(
    constraints.rows.map((row) => row.conname).sort(),
    ["old_request_unique"],
  );

  const researchConversation = "44444444-4444-4444-4444-444444444444";
  const duplicateResearchConversation = "55555555-5555-5555-5555-555555555555";
  await db.exec(`
    insert into conversations(id, owner_id, profile_id, execution_profile_id)
    values
      ('${researchConversation}', '${owner}', 'bibi-14', 'bibi-14'),
      ('${duplicateResearchConversation}', '${owner}', 'bibi-14', 'bibi-14');
  `);
  const research = await db.query(`select * from public.bibi_request_conversation_binding(
    '${owner}', '${researchConversation}', 'telegram', 'acct', 'chat', 'research-session', 'research-request'
  )`);
  assert.equal(research.rows[0].binding_state, "pending", "the same Telegram DM may bind once per execution profile");
  await assert.rejects(
    db.query(`select * from public.bibi_request_conversation_binding(
      '${owner}', '${duplicateResearchConversation}', 'telegram', 'acct', 'chat', 'research-session-2', 'research-conflict'
    )`),
    /this Telegram conversation is already bound to another conversation/i,
    "the same profile still cannot give one Telegram DM two Office conversations",
  );
});

test("rotation cannot verify or modify existing Office messages", async () => {
  const sql = await rotationMigration();
  const replaceBody = sql.slice(
    sql.indexOf("create or replace function public.bibi_replace_conversation_binding"),
    sql.indexOf("revoke all on function public.bibi_replace_conversation_binding"),
  ).replace(/--[^\n]*/g, "");

  assert.doesNotMatch(replaceBody, /set_config\('bibi\.binding_verification'/i);
  assert.doesNotMatch(replaceBody, /'verified'/i);
  assert.doesNotMatch(replaceBody, /public\.messages|projected_messages/i);
  for (const role of ["public", "anon", "authenticated"]) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.bibi_replace_conversation_binding\\(uuid, uuid, text, text, text, text, text\\) from ${role};`, "i"),
    );
  }
  assert.match(sql, /grant execute on function public\.bibi_replace_conversation_binding\(uuid, uuid, text, text, text, text, text\) to service_role;/i);
});

test("the browser rotation contract is cancel, same-conversation new-session, then readback", async () => {
  const [workspace, client] = await Promise.all([
    readFile(path.join(root, "src/BibiWorkspace.jsx"), "utf8"),
    readFile(path.join(root, "src/cloud/workspaceClient.js"), "utf8"),
  ]);
  const disconnect = workspace.slice(
    workspace.indexOf("const handleDisconnectTelegram"),
    workspace.indexOf("const handleFile"),
  );
  const connect = workspace.slice(
    workspace.indexOf("const handleConnectTelegram"),
    workspace.indexOf("const handleRetryTelegram"),
  );

  assert.match(disconnect, /cancelConversationBinding\(/);
  assert.match(disconnect, /refreshConversation\(conversationId\)/);
  assert.match(connect, /const conversationId = conversationIdRef\.current/);
  assert.match(connect, /action = current \? "new-session" : "request"/);
  assert.match(connect, /setBinding\(await loadConversationBinding\(conversationId\)\)/);
  assert.match(workspace, /filter\(\(session\) => session\.hermes_session_id !== bridge\.hermesSessionId\)/);
  assert.match(client, /OWNER_BINDING_ACTIONS = Object\.freeze\(\["request", "retry", "new-session"\]\)/);
  assert.doesNotMatch(client, /OWNER_BINDING_ACTIONS[^\n]*verified/);
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
