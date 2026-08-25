-- Bring existing owner-scoped Team charts onto the canonical Bibi role IDs.
--
-- The CEO executes through the physical `default` profile, but the organization
-- role is `bibi-01`. Earlier cloud seeding persisted `default` as the root. This
-- forward migration changes only role identity/reporting fields. Department,
-- room, order and every other visual-placement field remain untouched.

update public.bibi_organization_states as state
set nodes = (
      select jsonb_agg(
        jsonb_set(
          jsonb_set(
            node,
            '{id}',
            to_jsonb(case when node->>'id' = 'default' then 'bibi-01' else node->>'id' end),
            true
          ),
          '{parentId}',
          case
            when node->>'id' in ('default', 'bibi-01') then 'null'::jsonb
            else '"bibi-01"'::jsonb
          end,
          true
        ) order by ordinal
      )
      from jsonb_array_elements(state.nodes) with ordinality as item(node, ordinal)
    ),
    revision = state.revision + 1,
    audit = state.audit || jsonb_build_array(jsonb_build_object(
      'revision', state.revision + 1,
      'actor', 'system:canonical-ceo-reporting-v1',
      'at', now()
    )),
    updated_at = now()
where jsonb_typeof(state.nodes) = 'array'
  and jsonb_array_length(state.nodes) = 18
  and (
    select count(distinct node->>'id') = 18
    from jsonb_array_elements(state.nodes) as item(node)
  )
  and state.nodes @> '[
    {"id":"bibi-02"},{"id":"bibi-03"},{"id":"bibi-04"},{"id":"bibi-05"},
    {"id":"bibi-06"},{"id":"bibi-07"},{"id":"bibi-08"},{"id":"bibi-09"},
    {"id":"bibi-10"},{"id":"bibi-11"},{"id":"bibi-12"},{"id":"bibi-13"},
    {"id":"bibi-14"},{"id":"bibi-15"},{"id":"bibi-16"},{"id":"bibi-17"},
    {"id":"bibi-18"}
  ]'::jsonb
  and (state.nodes @> '[{"id":"default"}]'::jsonb or state.nodes @> '[{"id":"bibi-01"}]'::jsonb)
  and exists (
    select 1
    from jsonb_array_elements(state.nodes) as item(node)
    where node->>'id' = 'default'
       or (node->>'id' = 'bibi-01' and node->'parentId' <> 'null'::jsonb)
       or (node->>'id' not in ('default', 'bibi-01') and node->>'parentId' is distinct from 'bibi-01')
  );
