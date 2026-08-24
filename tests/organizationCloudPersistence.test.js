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
