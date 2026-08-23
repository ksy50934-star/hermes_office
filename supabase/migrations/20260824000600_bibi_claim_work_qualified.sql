-- Fixes the production claim failure: `column reference "work_item_id" is
-- ambiguous` (SQLSTATE 42702), returned by /api/connector/poll as HTTP 500.
--
-- `bibi_claim_work` declares `returns table (work_item_id uuid, ..., attempt
-- integer, ...)`. Every one of those OUT parameters is an ordinary plpgsql
-- variable inside the body, and `public.command_leases` has columns with the
-- same names. Wherever the body names one of them without a table qualifier,
-- plpgsql finds both a variable and a column and refuses to guess, which is
-- exactly the 42702 the connector sees.
--
-- Migration 005 left two such references in the `recorded` CTE:
--
--   on conflict (work_item_id, attempt) do nothing   -- both names ambiguous
--   returning work_item_id                           -- ambiguous
--
-- They are runtime failures, not creation failures: plpgsql only parses a
-- statement the first time it executes it, so 005 applied cleanly and broke on
-- the first poll that reached the claim.
--
-- This migration is forward-only. Migrations 001-005 are already applied
-- remotely and are not edited; this one replaces the function definition and
-- nothing else. The row type is unchanged, so the connector's RPC contract and
-- `store.claimWork` mapping stay exactly as they are.

-- ---------------------------------------------------------------------------
-- Preconditions
-- ---------------------------------------------------------------------------

-- The `on conflict` arbiter below is named by constraint rather than by column
-- list. That is not style: an inference column list is parse-analysed as an
-- expression against the target relation, so bare `work_item_id` there is
-- ambiguous for the same reason as everywhere else -- and a qualified name is
-- not resolvable in that clause, because the arbiter namespace exposes the
-- target relation's columns without its alias. Naming the constraint bypasses
-- expression analysis entirely.
--
-- The constraint is the inline `unique (work_item_id, attempt)` from migration
-- 001, which PostgreSQL names deterministically. Assert it rather than assume
-- it: a mismatch here must fail the migration loudly instead of shipping a
-- function that raises `undefined_object` on the first poll.
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.command_leases'::pg_catalog.regclass
       and c.contype = 'u'
       and c.conname = 'command_leases_work_item_id_attempt_key'
  ) then
    raise exception
      'expected unique constraint command_leases_work_item_id_attempt_key on public.command_leases'
      using errcode = 'undefined_object';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Replacement
-- ---------------------------------------------------------------------------

-- The OUT row type is identical to the one 005 created, so `create or replace`
-- would be accepted here. The drop is deliberate anyway: it guarantees the new
-- body cannot be shadowed by a stale definition, and it matches the pattern 005
-- established. Dropped by the exact four-argument signature, never `cascade` --
-- nothing in the schema depends on this function, only the connector API calls
-- it over RPC, and `cascade` would silently take any future dependent with it.
drop function if exists public.bibi_claim_work(uuid, uuid, integer, integer);

create function public.bibi_claim_work(
  p_owner_id uuid,
  p_connector_node_id uuid,
  p_max integer,
  p_lease_ttl_ms integer
)
returns table (
  work_item_id uuid,
  profile_id text,
  kind text,
  conversation_id uuid,
  title text,
  brief text,
  attempt integer,
  lease_id uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz := now() + make_interval(secs => p_lease_ttl_ms / 1000.0);
begin
  -- 1. Reclaim anything whose lease ran out.
  --
  -- The left-hand side of `set` is resolved against the target relation only
  -- and is never a plpgsql variable, which is why `released_at` and the column
  -- assignments below carry no qualifier -- PostgreSQL forbids one there. Every
  -- value expression and every predicate is qualified.
  update public.command_leases l
     set released_at = now(),
         release_reason = 'lease expired'
   where l.owner_id = p_owner_id
     and l.released_at is null
     and l.expires_at < now();

  update public.work_items w
     set status = 'assigned',
         lease_id = null,
         node_id = null,
         lease_expires_at = null,
         updated_at = now()
   where w.owner_id = p_owner_id
     and w.status in ('leased', 'running')
     and w.lease_expires_at is not null
     and w.lease_expires_at < now();

  -- 2. Take a disjoint batch of assigned work.
  return query
  with claimed as (
    select w.id
      from public.work_items w
     where w.owner_id = p_owner_id
       and w.status = 'assigned'
       and w.profile_id is not null
     order by w.created_at
     limit greatest(p_max, 0)
     for update skip locked
  ),
  leased as (
    update public.work_items w
       set status = 'leased',
           attempt = w.attempt,
           lease_id = gen_random_uuid(),
           node_id = p_connector_node_id,
           lease_expires_at = v_expires_at,
           updated_at = now()
      from claimed c
     where w.id = c.id
    returning w.id, w.profile_id, w.kind, w.conversation_id, w.title, w.brief,
              w.attempt, w.lease_id, w.lease_expires_at
  ),
  -- `as cl` gives the insert target a name, so the `returning` list can qualify
  -- the column and stop colliding with the OUT parameter of the same name. The
  -- CTE's own output column is renamed too, so the existence check below reads
  -- as what it is and cannot pick up a variable either.
  recorded (recorded_work_item_id) as (
    insert into public.command_leases as cl
      (owner_id, work_item_id, connector_node_id, attempt, expires_at)
    select p_owner_id, l.id, p_connector_node_id, l.attempt + 1, v_expires_at
      from leased l
    on conflict on constraint command_leases_work_item_id_attempt_key do nothing
    returning cl.work_item_id
  )
  select l.id, l.profile_id, l.kind, l.conversation_id, l.title, l.brief,
         l.attempt + 1, l.lease_id, l.lease_expires_at
    from leased l
   where exists (
     select 1
       from recorded r
      where r.recorded_work_item_id = l.id
   );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Mandatory, not repetition: the drop above discarded the grants 005 made, and
-- a freshly created function carries the default `execute` to public. Without
-- this block a browser session could call a security definer function that
-- bypasses RLS and hand itself every owner's work queue.
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from public;
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from anon;
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from authenticated;
grant execute on function public.bibi_claim_work(uuid, uuid, integer, integer) to service_role;
