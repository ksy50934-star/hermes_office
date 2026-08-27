-- BIBI-ORG-20260826-02 — seat every stored Team chart in a real room.
--
-- v1 had no seating contract. `buildCanonicalBibiOrganizationNodes` put the CEO
-- in 대표실 (`executive`) and dropped the other seventeen members into 운영실
-- (`operations`), so the office map showed one crowded room and eight empty
-- ones, and a member's location carried no information about their work.
--
-- v2 seats all eighteen against the room purposes on the calibrated floor plan:
--   대표실 결정과 우선순위        bibi-01
--   운영실 일정과 실행            bibi-07 · bibi-18
--   관제센터 시스템 상태·장애     bibi-12 · bibi-17 · bibi-11
--   브랜드룸 정체성과 메시지      bibi-09
--   콘텐츠룸 캠페인과 발행        bibi-03 · bibi-04 · bibi-05
--   크리에이티브룸 제작과 품질    bibi-06 · bibi-10
--   자료실 문서와 산출물          bibi-13 · bibi-14 · bibi-15
--   고객 데스크 상담과 경험       bibi-08
--   기술실 자동화와 개발          bibi-02
--   재무실 매출과 KPI             bibi-16
--
-- 관제센터 and 자료실 were already on the floor plan; they were simply missing
-- from the assignable room list. No room coordinate changes here or in
-- `src/officeData.js` — only which room a member is filed under.
--
-- This forward migration rewrites only `roomId`. Departments, reporting lines,
-- order and every other field stay exactly as placed, and no row and no node is
-- ever removed.
--
-- The guard is the point. A room is migrated ONLY when the chart still carries
-- the exact seating v1 emitted — every Bibi member other than bibi-01 in
-- `operations`, and bibi-01, if present, in `executive`. One member moved out of
-- 운영실 means the user has arranged the office themselves, and then this
-- migration does nothing at all. `organizationHasCollapsedRooms` in
-- `organizationHierarchy.js` applies the identical test, so the browser and the
-- database agree on which charts are v1 and which are the user's.
--
-- Re-applying is a no-op: once seated, the collapse test no longer matches.

update public.bibi_organization_states as state
set nodes = (
      select jsonb_agg(
        case
          when seat.room is null then item.node
          else jsonb_set(item.node, '{roomId}', to_jsonb(seat.room), true)
        end
        order by item.ordinal
      )
      from jsonb_array_elements(state.nodes) with ordinality as item(node, ordinal)
      left join (values
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
    audit = state.audit || jsonb_build_array(jsonb_build_object(
      'revision', state.revision + 1,
      'actor', 'system:bibi-room-seating-v2',
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
  -- at least one non-CEO Bibi member is present to seat
  and exists (
    select 1
    from jsonb_array_elements(state.nodes) as item(node)
    where item.node->>'id' ~ '^bibi-(0[2-9]|1[0-8])$'
  )
  -- and the chart still carries v1's collapse, unchanged
  and not exists (
    select 1
    from jsonb_array_elements(state.nodes) as item(node)
    where (item.node->>'id' ~ '^bibi-(0[2-9]|1[0-8])$' and item.node->>'roomId' is distinct from 'operations')
       or (item.node->>'id' = 'bibi-01' and item.node->>'roomId' is distinct from 'executive')
  );
