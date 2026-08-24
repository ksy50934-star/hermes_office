-- Owner-scoped durable organization structure for the Bibi Workspace team editor.

create table public.bibi_organization_states (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  nodes jsonb not null default '[]'::jsonb check (jsonb_typeof(nodes) = 'array'),
  audit jsonb not null default '[]'::jsonb check (jsonb_typeof(audit) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bibi_organization_states enable row level security;
alter table public.bibi_organization_states force row level security;

create policy "bibi_organization_states_select_owner" on public.bibi_organization_states
  for select to authenticated
  using (owner_id = auth.uid());

create policy "bibi_organization_states_insert_owner" on public.bibi_organization_states
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy "bibi_organization_states_update_owner" on public.bibi_organization_states
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "bibi_organization_states_delete_owner" on public.bibi_organization_states
  for delete to authenticated
  using (owner_id = auth.uid());

create index bibi_organization_states_updated_idx
  on public.bibi_organization_states (owner_id, updated_at desc);

alter publication supabase_realtime add table public.bibi_organization_states;

create or replace function public.save_bibi_organization_state(
  p_expected_revision bigint,
  p_nodes jsonb
)
returns setof public.bibi_organization_states
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid := auth.uid();
  v_audit_entry jsonb := jsonb_build_array(jsonb_build_object(
    'revision', p_expected_revision + 1,
    'changedAt', now(),
    'source', 'bibi-workspace-web'
  ));
begin
  if v_owner_id is null or p_expected_revision < 0 or jsonb_typeof(p_nodes) <> 'array' then
    return;
  end if;

  if p_expected_revision = 0 then
    return query
      insert into public.bibi_organization_states (owner_id, revision, nodes, audit)
      values (v_owner_id, 1, p_nodes, v_audit_entry)
      on conflict (owner_id) do nothing
      returning *;
    return;
  end if;

  return query
    update public.bibi_organization_states as state
       set revision = state.revision + 1,
           nodes = p_nodes,
           audit = state.audit || v_audit_entry,
           updated_at = now()
     where state.owner_id = v_owner_id
       and state.revision = p_expected_revision
    returning state.*;
end;
$$;

revoke all on function public.save_bibi_organization_state(bigint, jsonb) from public, anon;
grant execute on function public.save_bibi_organization_state(bigint, jsonb) to authenticated;
