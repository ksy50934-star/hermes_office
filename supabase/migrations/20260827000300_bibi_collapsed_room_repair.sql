-- BIBI-ORG-20260827-03 — repair the production legacy variant that stored
-- all eighteen canonical Bibi members in operations, including bibi-01.
--
-- The earlier seating migration intentionally required bibi-01=executive and
-- therefore skipped this observed production shape. This repair is narrower:
-- it runs only when the JSON array contains exactly the eighteen unique
-- canonical Bibi ids and every one still has roomId=operations. A partial chart,
-- duplicate roster, non-Bibi node, or a single user-arranged room is a no-op.

update public.bibi_organization_states as state
set nodes = (
      select jsonb_agg(
        jsonb_set(item.node, '{roomId}', to_jsonb(seat.room), true)
        order by item.ordinal
      )
      from jsonb_array_elements(state.nodes) with ordinality as item(node, ordinal)
      join (values
        ('bibi-01', 'executive'),
        ('bibi-07', 'operations'),
        ('bibi-18', 'operations'),
        ('bibi-12', 'control'),
        ('bibi-17', 'control'),
        ('bibi-11', 'control'),
        ('bibi-09', 'brand'),
        ('bibi-03', 'content'),
        ('bibi-04', 'content'),
        ('bibi-05', 'content'),
        ('bibi-06', 'creative'),
        ('bibi-10', 'creative'),
        ('bibi-13', 'library'),
        ('bibi-14', 'library'),
        ('bibi-15', 'library'),
        ('bibi-08', 'customer'),
        ('bibi-02', 'tech'),
        ('bibi-16', 'finance')
      ) as seat(id, room) on seat.id = item.node->>'id'
    ),
    revision = state.revision + 1,
    audit = coalesce(state.audit, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'revision', state.revision + 1,
      'actor', 'system:bibi-room-seating-v2-all-operations-repair',
      'at', now()
    )),
    updated_at = now()
where jsonb_typeof(state.nodes) = 'array'
  and jsonb_array_length(state.nodes) = 18
  and not exists (
    select 1
    from jsonb_array_elements(state.nodes) as item(node)
    where jsonb_typeof(item.node) <> 'object'
       or item.node->>'id' !~ '^bibi-(0[1-9]|1[0-8])$'
       or item.node->>'roomId' is distinct from 'operations'
  )
  and (
    select count(distinct item.node->>'id')
    from jsonb_array_elements(state.nodes) as item(node)
  ) = 18;
