-- BIBI-ORG-20260825-01 — file every stored Team chart under the five
-- confirmed departments.
--
-- v1 stored the upstream generic departments (leadership, operations, brand,
-- growth, content, creative, customer, finance, technology, general). v2 is the
-- confirmed contract: 관리부서 / 실무부서 / 검수부서 / 지원부서 / 반복부서(크론잡).
--
-- This forward migration rewrites only `department`. Reporting lines, office
-- rooms, order and every other field stay exactly as placed, and no row and no
-- node is ever removed.
--
-- Precedence is the same as the browser migration in `organizationHierarchy.js`
-- so both paths agree on the result:
--   1. a department already on the v2 contract is kept, so a department the
--      user chose by hand survives the migration;
--   2. one of the eighteen role slots takes its contract department — this is
--      what puts bibi-09 마케터비비 in 검수부서 as the marketing reviewer;
--   3. anything else follows the v1 → v2 table, then 지원부서.
--
-- The revision is bumped once with an audit entry, so a client holding the old
-- revision is told to reload rather than silently writing v1 back over this.
-- Re-applying is a no-op: the guard matches only charts that still hold a
-- department outside the v2 contract.

update public.bibi_organization_states as state
set nodes = (
      select jsonb_agg(
        jsonb_set(
          item.node,
          '{department}',
          to_jsonb(case
            when item.node->>'department' in ('management', 'execution', 'review', 'support', 'recurring')
              then item.node->>'department'
            else coalesce(contract.department, legacy.department, 'support')
          end),
          true
        ) order by item.ordinal
      )
      from jsonb_array_elements(state.nodes) with ordinality as item(node, ordinal)
      left join (values
        ('bibi-01', 'management'),
        ('bibi-12', 'management'),
        ('bibi-02', 'execution'),
        ('bibi-03', 'execution'),
        ('bibi-04', 'execution'),
        ('bibi-05', 'execution'),
        ('bibi-06', 'execution'),
        ('bibi-15', 'execution'),
        ('bibi-16', 'execution'),
        ('bibi-09', 'review'),
        ('bibi-10', 'review'),
        ('bibi-14', 'review'),
        ('bibi-07', 'support'),
        ('bibi-08', 'support'),
        ('bibi-13', 'support'),
        ('bibi-17', 'support'),
        ('bibi-18', 'support'),
        ('bibi-11', 'recurring')
      ) as contract(id, department) on contract.id = item.node->>'id'
      left join (values
        ('leadership', 'management'),
        ('operations', 'management'),
        ('brand', 'execution'),
        ('content', 'execution'),
        ('creative', 'execution'),
        ('growth', 'execution'),
        ('technology', 'execution'),
        ('customer', 'support'),
        ('finance', 'support'),
        ('general', 'support')
      ) as legacy(id, department) on legacy.id = item.node->>'department'
    ),
    revision = state.revision + 1,
    audit = state.audit || jsonb_build_array(jsonb_build_object(
      'revision', state.revision + 1,
      'actor', 'system:five-department-organization-v2',
      'at', now()
    )),
    updated_at = now()
where jsonb_typeof(state.nodes) = 'array'
  and jsonb_array_length(state.nodes) > 0
  and not exists (
    select 1
    from jsonb_array_elements(state.nodes) as item(node)
    where jsonb_typeof(item.node) <> 'object'
  )
  and exists (
    select 1
    from jsonb_array_elements(state.nodes) as item(node)
    where coalesce(item.node->>'department', '') not in ('management', 'execution', 'review', 'support', 'recurring')
  );
