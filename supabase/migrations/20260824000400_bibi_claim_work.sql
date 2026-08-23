-- Atomic work claim for the local Mac connector.
--
-- Claiming has to be one statement, not a select followed by an update: two
-- connector nodes polling at the same moment would otherwise both read the same
-- assigned row and both start it. `for update skip locked` gives each poller a
-- disjoint set, and the partial unique index on command_leases is the backstop
-- if anything ever bypasses this function.
--
-- The function also reclaims expired leases first. A Mac that slept mid-task
-- holds a lease that will never be released by its owner, and that work has to
-- return to the queue rather than sit in `running` forever.

create or replace function public.bibi_claim_work(
  p_owner_id uuid,
  p_connector_node_id uuid,
  p_max integer,
  p_lease_ttl_ms integer
)
returns table (
  work_item_id uuid,
  profile_id text,
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
    returning w.id, w.profile_id, w.title, w.brief, w.attempt, w.lease_id, w.lease_expires_at
  ),
  recorded as (
    insert into public.command_leases (owner_id, work_item_id, connector_node_id, attempt, expires_at)
    select p_owner_id, l.id, p_connector_node_id, l.attempt + 1, v_expires_at
      from leased l
    on conflict (work_item_id, attempt) do nothing
    returning work_item_id
  )
  select l.id, l.profile_id, l.title, l.brief, l.attempt + 1, l.lease_id, l.lease_expires_at
    from leased l
   where exists (select 1 from recorded r where r.work_item_id = l.id);
end;
$$;

-- A security definer function bypasses RLS by design, so it must not be callable
-- from a browser session. Only the service role, used by the connector API,
-- may invoke it.
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from public;
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from anon;
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from authenticated;
grant execute on function public.bibi_claim_work(uuid, uuid, integer, integer) to service_role;
