import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrations = path.join(root, "supabase", "migrations");

async function latestContinuityMigration() {
  const names = (await readdir(migrations))
    .filter((name) => name.endsWith("_conversation_continuity.sql"))
    .sort();
  assert.equal(names.length, 1, "one forward-only continuity migration is required");
  return readFile(path.join(migrations, names[0]), "utf8");
}

const TABLES = [
  "conversation_bindings",
  "projected_messages",
  "projection_checkpoints",
  "conversation_resume_leases",
  "conversation_audit_events",
];

test("continuity schema is owner scoped, forced-RLS, and client read-only", async () => {
  const sql = await latestContinuityMigration();
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} force row level security`, "i"));
    assert.match(sql, new RegExp(`create index \\w*${table}\\w*owner\\w* on public\\.${table} \\(owner_id`, "i"));
    assert.match(sql, new RegExp(`create policy "${table}_select_own" on public\\.${table}[\\s\\S]*?for select to authenticated[\\s\\S]*?auth\\.uid\\(\\)`, "i"));
  }
  assert.doesNotMatch(sql, /create policy[\s\S]*?for (?:insert|update|delete) to authenticated/i);
});

test("binding and projection identities reject cross-owner and cross-profile rows", async () => {
  const sql = await latestContinuityMigration();
  assert.match(sql, /organization_profile_id text not null references public\.bibi_profiles \(id\)/i);
  assert.match(sql, /execution_profile_id text not null[\s\S]*?check \(execution_profile_id = 'default' or execution_profile_id ~ '\^bibi-\(0\[2-9\]\|1\[0-8\]\)\$'\)/i);
  assert.match(sql, /conversations_specialist_execution_mapping[\s\S]*?profile_id <> 'bibi-01'[\s\S]*?execution_profile_id <> profile_id/i);
  assert.match(sql, /check \(not \(organization_profile_id = 'bibi-01' and execution_profile_id <> 'default'\)\)/i);
  assert.match(sql, /check \(not \(organization_profile_id <> 'bibi-01' and execution_profile_id <> organization_profile_id\)\)/i);
  assert.match(sql, /bibi_validate_conversation_binding/i);
  assert.match(sql, /binding owner\/profile mismatch/i);
  assert.match(sql, /projection owner\/profile mismatch/i);
  assert.doesNotMatch(sql, /execution_profile_id[^\n]*'bibi-01'/i);
});

test("projection ordering, replay and resume leases have database idempotency backstops", async () => {
  const sql = await latestContinuityMigration();
  assert.match(sql, /unique \(owner_id, execution_profile_id, hermes_session_id, source_message_id\)/i);
  assert.match(sql, /unique \(owner_id, execution_profile_id, hermes_session_id\)/i);
  assert.match(sql, /unique \(owner_id, channel, channel_account_id, external_conversation_id\)/i);
  assert.match(sql, /unique index conversation_resume_leases_active_session_idx[\s\S]*?where released_at is null/i);
  assert.match(sql, /source_sequence bigint not null check \(source_sequence >= 0\)/i);
  assert.match(sql, /source_timestamp timestamptz not null/i);
  assert.match(sql, /sync_status text not null[\s\S]*?'synced'[\s\S]*?'blocked'/i);
});

test("audit events are append-only and Telegram mirroring defaults disabled", async () => {
  const sql = await latestContinuityMigration();
  assert.match(sql, /telegram_mirroring_enabled boolean not null default false/i);
  assert.match(sql, /bibi_reject_audit_mutation/i);
  assert.match(sql, /before update or delete on public\.conversation_audit_events/i);
  assert.match(sql, /raise exception 'conversation audit events are append-only'/i);
});

test("bound chat dispatch acquires and releases one fail-closed resume lease", async () => {
  const sql = await latestContinuityMigration();
  assert.match(sql, /alter table public\.work_items[\s\S]*?add column if not exists binding_id/i);
  assert.match(sql, /add column if not exists hermes_session_id text/i);
  assert.match(sql, /add column if not exists channel_origin text/i);
  assert.match(sql, /add column if not exists continuation_status text/i);
  assert.match(sql, /create or replace function public\.bibi_send_chat_message/i);
  assert.match(sql, /origin_channel = 'telegram'[\s\S]*?verified binding required/i);
  assert.match(sql, /insert into public\.conversation_resume_leases/i);
  assert.match(sql, /on conflict \(owner_id, execution_profile_id, hermes_session_id\) where released_at is null do nothing/i);
  assert.match(sql, /resume_lease_id uuid/i);
  assert.match(sql, /function public\.bibi_renew_resume_lease[\s\S]*?update public\.conversation_resume_leases[\s\S]*?set expires_at/i);
  assert.match(sql, /update public\.conversation_resume_leases[\s\S]*?released_at = now\(\)/i);
});

test("claim increments attempt atomically and binds every lease and turn marker to that exact attempt", async () => {
  const sql = await latestContinuityMigration();
  assert.match(sql, /update public\.work_items w set[\s\S]*?attempt = w\.attempt \+ 1[\s\S]*?returning w\.\*/i);
  assert.match(sql, /conversation_resume_leases[\s\S]*?attempt integer not null/i);
  assert.match(sql, /turn_idempotency_key text not null/i);
  assert.match(sql, /select p_owner_id, e\.id, p_connector_node_id, e\.attempt, v_expires_at/i);
  assert.match(sql, /select p_owner_id, l\.conversation_id, l\.binding_id, l\.id, l\.attempt/i);
  assert.doesNotMatch(sql, /e\.attempt \+ 1, v_expires_at/i);
});

test("expired running work is blocked for reconciliation instead of being re-executed", async () => {
  const sql = await latestContinuityMigration();
  assert.match(sql, /status = 'blocked'[\s\S]*?blocked_reason = 'execution outcome requires reconciliation'[\s\S]*?w\.status = 'running'/i);
  assert.match(sql, /execution_started_at timestamptz/i);
  assert.match(sql, /execution_completed_at timestamptz/i);
  assert.match(sql, /reconciliation_status text/i);
});

test("connector reports are applied by one service-only atomic RPC", async () => {
  const sql = await latestContinuityMigration();
  assert.match(sql, /create or replace function public\.bibi_apply_work_report/i);
  assert.match(sql, /insert into public\.work_events[\s\S]*?insert into public\.work_results[\s\S]*?insert into public\.work_evidence[\s\S]*?update public\.work_items[\s\S]*?update public\.command_leases/i);
  assert.match(sql, /revoke all on function public\.bibi_apply_work_report[\s\S]*?from authenticated/i);
  assert.match(sql, /grant execute on function public\.bibi_apply_work_report[\s\S]*?to service_role/i);
});

test("conversation lifecycle changes emit owner-validated append-only audit events", async () => {
  const sql = await latestContinuityMigration();
  for (const type of ["pair", "bind", "resume", "release", "replace", "deliver", "unbind", "retention", "archive", "delete"]) {
    assert.match(sql, new RegExp(`'${type}'`), `missing concrete audit event type ${type}`);
  }
  assert.match(sql, /create trigger bibi_validate_conversation_audit_event/i);
  assert.match(sql, /audit owner\/profile mismatch/i);
  assert.match(sql, /create trigger bibi_reject_audit_mutation[\s\S]*?before update or delete/i);
});
