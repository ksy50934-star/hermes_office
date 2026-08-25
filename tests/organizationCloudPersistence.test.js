import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("organization save is an owner-bound revision CAS with append-only audit", async () => {
  const sql = await read("supabase/migrations/20260824000900_cloud_organization.sql");
  assert.match(sql, /create or replace function public\.save_bibi_organization_state/);
  assert.match(sql, /v_owner_id uuid := auth\.uid\(\)/);
  assert.match(sql, /state\.revision = p_expected_revision/);
  assert.match(sql, /audit = state\.audit \|\| v_audit_entry/);
  assert.match(sql, /on conflict \(owner_id\) do nothing/);
  assert.match(sql, /revoke all on function public\.save_bibi_organization_state\(bigint, jsonb\) from public, anon/);
  assert.match(sql, /grant execute on function public\.save_bibi_organization_state\(bigint, jsonb\) to authenticated/);
});

test("organization browser client uses the atomic RPC and reports stale revisions as conflicts", async () => {
  const client = await read("src/cloud/workspaceClient.js");
  assert.match(client, /\.rpc\("save_bibi_organization_state"/);
  assert.match(client, /p_expected_revision: expectedRevision/);
  assert.match(client, /conflict\.status = 409/);
  assert.doesNotMatch(client, /from\("bibi_organization_states"\)[\s\S]{0,300}\.update\(/);
});

test("forward migration repairs existing owner organization rows without discarding visual placement", async () => {
  const sql = await read("supabase/migrations/20260825000200_canonical_ceo_reporting_structure.sql");
  assert.match(sql, /update public\.bibi_organization_states/i);
  assert.match(sql, /'bibi-01'/i);
  assert.match(sql, /jsonb_set\([\s\S]*?\{parentId\}/i);
  assert.match(sql, /jsonb_array_length\(state\.nodes\) = 18/i);
  assert.match(sql, /count\(distinct node->>'id'\) = 18/i);
  assert.match(sql, /state\.nodes @>/i);
  assert.match(sql, /revision = state\.revision \+ 1/i);
  assert.match(sql, /audit = state\.audit \|\|/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.bibi_organization_states/i);
});

test("forward-only remote verification requires the exact Bibi roster and executable adversarial fixtures", async () => {
  const sql = await read("supabase/migrations/20260825000400_verify_exact_canonical_ceo_roster.sql");
  assert.match(sql, /v_canonical_rows < 1/i);
  assert.match(sql, /CANONICAL_ORGANIZATION_ROW_MISSING/i);
  assert.match(sql, /CANONICAL_ORGANIZATION_DRIFT/i);
  assert.match(sql, /v_expected_ids text\[\]/i);
  assert.match(sql, /array_agg\(node->>'id' order by node->>'id'\) = v_expected_ids/i);
  assert.match(sql, /foreign-17/i);
  assert.match(sql, /ADVERSARIAL_FOREIGN_ROSTER_ACCEPTED/i);
  assert.match(sql, /node->>'id' <> 'bibi-01'[\s\S]*?node->>'parentId' is distinct from 'bibi-01'/i);
});
