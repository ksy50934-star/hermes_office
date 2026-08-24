-- Fix PL/pgSQL output-column ambiguity in bibi_claim_work.
--
-- RETURNS TABLE declares hermes_session_id (and the other output names) as
-- PL/pgSQL variables.  Naming those columns again in an ON CONFLICT inference
-- clause is ambiguous on the linked Postgres runtime.  The insert is safe to
-- suppress on any uniqueness conflict: failure to create the active resume
-- lease makes the work item ineligible and the same statement reverts it to
-- assigned below.

create or replace function public.bibi_claim_work(
  p_owner_id uuid,
  p_connector_node_id uuid,
  p_max integer,
  p_lease_ttl_ms integer
)
returns table (
  work_item_id uuid, profile_id text, kind text, conversation_id uuid,
  title text, brief text, attempt integer, lease_id uuid,
  lease_expires_at timestamptz, binding_id uuid, hermes_session_id text,
  channel_origin text, continuation_status text, resume_lease_id uuid,
  turn_idempotency_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz := now() + make_interval(secs => p_lease_ttl_ms / 1000.0);
begin
  update public.conversation_resume_leases r
     set released_at = now(), release_reason = 'lease expired'
   where r.owner_id = p_owner_id and r.released_at is null and r.expires_at < now();
  update public.command_leases c
     set released_at = now(), release_reason = 'lease expired'
   where c.owner_id = p_owner_id and c.released_at is null and c.expires_at < now();
  update public.work_items w
     set status = 'blocked', blocked_reason = 'execution outcome requires reconciliation',
         reconciliation_status = 'pending', lease_id = null, node_id = null,
         lease_expires_at = null, updated_at = now()
   where w.owner_id = p_owner_id and w.status = 'running'
     and w.lease_expires_at < now();
  update public.work_items w
     set status = 'assigned', lease_id = null, node_id = null,
         lease_expires_at = null, updated_at = now()
   where w.owner_id = p_owner_id and w.status = 'leased'
     and w.lease_expires_at < now();

  return query
  with claimed as (
    select w.id from public.work_items w
     where w.owner_id = p_owner_id and w.status = 'assigned' and w.profile_id is not null
       and not exists (
         select 1 from public.conversation_resume_leases r
          where r.owner_id = p_owner_id and r.released_at is null
            and w.hermes_session_id is not null
            and r.execution_profile_id = (select p.execution_profile from public.bibi_profiles p where p.id = w.profile_id)
            and r.hermes_session_id = w.hermes_session_id
       )
     order by w.created_at limit greatest(p_max, 0) for update skip locked
  ), leased as (
    update public.work_items w set status = 'leased', attempt = w.attempt + 1,
      turn_idempotency_key = w.id::text || ':' || (w.attempt + 1)::text,
      execution_started_at = null, execution_completed_at = null,
      reconciliation_status = 'not-required', lease_id = gen_random_uuid(),
      node_id = p_connector_node_id, lease_expires_at = v_expires_at, updated_at = now()
      from claimed c where w.id = c.id
      returning w.*
  ), resume_recorded as (
    insert into public.conversation_resume_leases (
      owner_id, conversation_id, binding_id, work_item_id, attempt,
      turn_idempotency_key, execution_profile_id, hermes_session_id, expires_at
    )
    select p_owner_id, l.conversation_id, l.binding_id, l.id, l.attempt,
           l.turn_idempotency_key, p.execution_profile, l.hermes_session_id, v_expires_at
      from leased l join public.bibi_profiles p on p.id = l.profile_id
     where l.hermes_session_id is not null and l.binding_id is not null
    on conflict do nothing
    returning conversation_resume_leases.id, conversation_resume_leases.work_item_id
  ), eligible as (
    select l.* from leased l
     where l.hermes_session_id is null
        or exists (select 1 from resume_recorded r where r.work_item_id = l.id)
  ), reverted as (
    update public.work_items w set status = 'assigned', lease_id = null, node_id = null,
      lease_expires_at = null, updated_at = now()
      from leased l where w.id = l.id
        and not exists (select 1 from eligible e where e.id = l.id)
    returning w.id
  ), command_recorded as (
    insert into public.command_leases (owner_id, work_item_id, connector_node_id, attempt, expires_at)
    select p_owner_id, e.id, p_connector_node_id, e.attempt, v_expires_at from eligible e
    on conflict do nothing returning command_leases.work_item_id
  )
  select e.id, e.profile_id, e.kind, e.conversation_id, e.title, e.brief,
         e.attempt, e.lease_id, e.lease_expires_at, e.binding_id,
         e.hermes_session_id, e.channel_origin, e.continuation_status,
         (select r.id from resume_recorded r where r.work_item_id = e.id),
         e.turn_idempotency_key
    from eligible e join command_recorded c on c.work_item_id = e.id;
end;
$$;

revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from public;
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from anon;
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from authenticated;
grant execute on function public.bibi_claim_work(uuid, uuid, integer, integer) to service_role;
