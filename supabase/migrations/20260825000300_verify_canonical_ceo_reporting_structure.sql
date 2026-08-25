-- Fail-closed remote readback for the canonical CEO reporting migration.
-- This migration performs no writes. It proves at least one real owner row has
-- the complete eighteen-role chart and that no complete Bibi chart retains the
-- physical `default` execution ID or a non-CEO reporting line.

do $$
declare
  v_canonical_rows integer;
begin
  select count(*)
    into v_canonical_rows
    from public.bibi_organization_states as state
   where jsonb_typeof(state.nodes) = 'array'
     and jsonb_array_length(state.nodes) = 18
     and (
       select count(distinct node->>'id') = 18
       from jsonb_array_elements(state.nodes) as item(node)
     )
     and not exists (
       select 1
       from jsonb_array_elements(state.nodes) as item(node)
       where node->>'id' = 'default'
          or (node->>'id' = 'bibi-01' and coalesce(node->'parentId', 'null'::jsonb) <> 'null'::jsonb)
          or (node->>'id' <> 'bibi-01' and node->>'parentId' is distinct from 'bibi-01')
     );

  if v_canonical_rows < 1 then
    raise exception 'CANONICAL_ORGANIZATION_ROW_MISSING';
  end if;

  if exists (
    select 1
    from public.bibi_organization_states as state
    where jsonb_typeof(state.nodes) = 'array'
      and jsonb_array_length(state.nodes) = 18
      and exists (
        select 1
        from jsonb_array_elements(state.nodes) as item(node)
        where node->>'id' = 'default'
           or (node->>'id' = 'bibi-01' and coalesce(node->'parentId', 'null'::jsonb) <> 'null'::jsonb)
           or (node->>'id' <> 'bibi-01' and node->>'parentId' is distinct from 'bibi-01')
      )
  ) then
    raise exception 'CANONICAL_ORGANIZATION_DRIFT';
  end if;

  raise notice 'CANONICAL_BIBI_ORGANIZATION_ROWS=%', v_canonical_rows;
end;
$$;
