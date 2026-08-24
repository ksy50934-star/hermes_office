-- Fix PL/pgSQL output-column ambiguity in bibi_apply_work_report.
-- RETURNS TABLE exposes status/result_id as variables; every table reference in
-- the transition update must therefore be explicitly qualified.

create or replace function public.bibi_apply_work_report(
  p_owner_id uuid,
  p_connector_node_id uuid,
  p_work_item_id uuid,
  p_event_id text,
  p_event_type text,
  p_attempt integer,
  p_turn_idempotency_key text,
  p_summary text,
  p_detail text,
  p_error text,
  p_reason text,
  p_evidence jsonb,
  p_payload jsonb,
  p_at timestamptz
)
returns table (duplicate boolean, status text, result_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_work public.work_items%rowtype;
  v_result_id uuid;
  v_next_status text;
  v_execution_profile text;
begin
  select w.* into v_work from public.work_items w
   where w.id = p_work_item_id and w.owner_id = p_owner_id
   for update;
  if v_work.id is null then
    raise exception 'work item not found for owner' using errcode = 'no_data_found';
  end if;

  if exists (
    select 1 from public.work_events ev
     where ev.owner_id = p_owner_id and ev.work_item_id = p_work_item_id and ev.event_id = p_event_id
  ) then
    return query select true, v_work.status, v_work.result_id;
    return;
  end if;

  if p_attempt is distinct from v_work.attempt
     or p_turn_idempotency_key is distinct from v_work.turn_idempotency_key
     or v_work.node_id is distinct from p_connector_node_id then
    raise exception 'report identity mismatch' using errcode = 'check_violation';
  end if;

  if p_event_type = 'start' and v_work.status = 'leased' then
    v_next_status := 'running';
  elsif p_event_type = 'succeed' and v_work.status = 'running' then
    v_next_status := 'succeeded';
  elsif p_event_type = 'fail' and v_work.status in ('leased', 'running') then
    if coalesce(btrim(p_error), '') = '' then
      raise exception 'reason is required for fail' using errcode = 'check_violation';
    end if;
    v_next_status := 'failed';
  elsif p_event_type = 'release' and v_work.status in ('leased', 'running') then
    v_next_status := 'assigned';
  elsif p_event_type = 'block' and v_work.status in ('assigned', 'leased', 'running') then
    if coalesce(btrim(p_reason), '') = '' then
      raise exception 'reason is required for block' using errcode = 'check_violation';
    end if;
    v_next_status := 'blocked';
  else
    raise exception 'invalid transition % from %', p_event_type, v_work.status using errcode = 'check_violation';
  end if;

  insert into public.work_events (owner_id, work_item_id, event_id, event_type, payload, created_at)
  values (p_owner_id, p_work_item_id, p_event_id, p_event_type, coalesce(p_payload, '{}'), p_at);

  if p_event_type = 'succeed' then
    insert into public.work_results (owner_id, work_item_id, summary, detail, created_at)
    values (p_owner_id, p_work_item_id, coalesce(p_summary, ''), coalesce(p_detail, ''), p_at)
    returning work_results.id into v_result_id;

    select p.execution_profile into v_execution_profile
      from public.bibi_profiles p where p.id = v_work.profile_id;
    insert into public.work_evidence (
      owner_id, work_item_id, execution_profile_id, kind, label, sha256,
      byte_size, storage_path, inline_excerpt, created_at
    )
    select p_owner_id, p_work_item_id, v_execution_profile,
           e.kind, e.label, e.sha256, e."byteSize", e."storagePath", e."inlineExcerpt", p_at
      from jsonb_to_recordset(coalesce(p_evidence, '[]')) as e(
        kind text, label text, sha256 text, "byteSize" bigint,
        "storagePath" text, "inlineExcerpt" text
      );

    if v_work.kind = 'chat' and v_work.continuation_status <> 'bound' then
      insert into public.messages (owner_id, conversation_id, profile_id, role, body, client_message_id)
      values (p_owner_id, v_work.conversation_id, v_work.profile_id, 'assistant', coalesce(p_summary, ''),
              'assistant:' || p_work_item_id::text)
      on conflict (conversation_id, client_message_id) do nothing;
    end if;
  end if;

  update public.work_items w
     set status = v_next_status,
         result_id = case when p_event_type = 'succeed' then v_result_id else w.result_id end,
         error = case when p_event_type = 'fail' then p_error when p_event_type = 'succeed' then null else w.error end,
         blocked_reason = case when p_event_type = 'block' then p_reason when p_event_type in ('release', 'succeed') then null else w.blocked_reason end,
         execution_started_at = case when p_event_type = 'start' then p_at else w.execution_started_at end,
         execution_completed_at = case when p_event_type in ('succeed', 'fail') then p_at else w.execution_completed_at end,
         reconciliation_status = case when p_event_type in ('succeed', 'fail') then 'reconciled' else w.reconciliation_status end,
         lease_id = case when p_event_type in ('succeed', 'fail', 'release', 'block') then null else w.lease_id end,
         node_id = case when p_event_type in ('succeed', 'fail', 'release', 'block') then null else w.node_id end,
         lease_expires_at = case when p_event_type in ('succeed', 'fail', 'release', 'block') then null else w.lease_expires_at end,
         updated_at = p_at
   where w.id = p_work_item_id and w.owner_id = p_owner_id;

  if p_event_type in ('succeed', 'fail', 'release', 'block') then
    update public.command_leases cl
       set released_at = p_at, release_reason = p_event_type
     where cl.owner_id = p_owner_id and cl.work_item_id = p_work_item_id
       and cl.connector_node_id = p_connector_node_id and cl.attempt = p_attempt and cl.released_at is null;
    update public.conversation_resume_leases rl
       set released_at = p_at, release_reason = p_event_type
     where rl.owner_id = p_owner_id and rl.work_item_id = p_work_item_id
       and rl.attempt = p_attempt and rl.turn_idempotency_key = p_turn_idempotency_key and rl.released_at is null;
  end if;

  return query select false, v_next_status, v_result_id;
end;
$$;

revoke all on function public.bibi_apply_work_report(uuid, uuid, uuid, text, text, integer, text, text, text, text, text, jsonb, jsonb, timestamptz) from public;
revoke all on function public.bibi_apply_work_report(uuid, uuid, uuid, text, text, integer, text, text, text, text, text, jsonb, jsonb, timestamptz) from anon;
revoke all on function public.bibi_apply_work_report(uuid, uuid, uuid, text, text, integer, text, text, text, text, text, jsonb, jsonb, timestamptz) from authenticated;
grant execute on function public.bibi_apply_work_report(uuid, uuid, uuid, text, text, integer, text, text, text, text, text, jsonb, jsonb, timestamptz) to service_role;
