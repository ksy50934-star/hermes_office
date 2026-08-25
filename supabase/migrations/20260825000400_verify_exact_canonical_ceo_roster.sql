-- Tighten the already-applied 250003 verification without rewriting history.
-- This migration performs no production writes. It proves that a canonical row
-- contains exactly bibi-01 through bibi-18, and it executes the reviewer's
-- foreign-roster counterexample before checking live rows.

do $$
declare
  v_expected_ids text[] := array[
    'bibi-01', 'bibi-02', 'bibi-03', 'bibi-04', 'bibi-05', 'bibi-06',
    'bibi-07', 'bibi-08', 'bibi-09', 'bibi-10', 'bibi-11', 'bibi-12',
    'bibi-13', 'bibi-14', 'bibi-15', 'bibi-16', 'bibi-17', 'bibi-18'
  ];
  v_foreign_nodes jsonb;
  v_fixture_ids text[];
  v_canonical_rows integer;
begin
  -- Executable adversarial fixture: CEO plus seventeen foreign IDs must never
  -- satisfy the exact canonical roster predicate, despite having the same shape.
  select jsonb_build_array(jsonb_build_object('id', 'bibi-01', 'parentId', null))
         || jsonb_agg(jsonb_build_object(
              'id', 'foreign-' || lpad(series::text, 2, '0'),
              'parentId', 'bibi-01'
            ) order by series)
    into v_foreign_nodes
    from generate_series(1, 17) as series;

  select array_agg(node->>'id' order by node->>'id')
    into v_fixture_ids
    from jsonb_array_elements(v_foreign_nodes) as item(node);

  if v_fixture_ids = v_expected_ids then
    raise exception 'ADVERSARIAL_FOREIGN_ROSTER_ACCEPTED: foreign-17';
  end if;

  select count(*)
    into v_canonical_rows
    from public.bibi_organization_states as state
   where jsonb_typeof(state.nodes) = 'array'
     and jsonb_array_length(state.nodes) = 18
     and (
       select array_agg(node->>'id' order by node->>'id') = v_expected_ids
       from jsonb_array_elements(state.nodes) as item(node)
     )
     and not exists (
       select 1
       from jsonb_array_elements(state.nodes) as item(node)
       where (node->>'id' = 'bibi-01' and coalesce(node->'parentId', 'null'::jsonb) <> 'null'::jsonb)
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
      and (
        select array_agg(node->>'id' order by node->>'id') = v_expected_ids
        from jsonb_array_elements(state.nodes) as item(node)
      )
      and exists (
        select 1
        from jsonb_array_elements(state.nodes) as item(node)
        where (node->>'id' = 'bibi-01' and coalesce(node->'parentId', 'null'::jsonb) <> 'null'::jsonb)
           or (node->>'id' <> 'bibi-01' and node->>'parentId' is distinct from 'bibi-01')
      )
  ) then
    raise exception 'CANONICAL_ORGANIZATION_DRIFT';
  end if;

  raise notice 'EXACT_CANONICAL_BIBI_ORGANIZATION_ROWS=%', v_canonical_rows;
end;
$$;
