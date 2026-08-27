-- Starvation-free convergence scanning for projected Hermes lifecycle tombstones.
--
-- The forward message checkpoint and the historical lifecycle scan cursor serve
-- different purposes. A monotonic source checkpoint must never move backwards,
-- while a lifecycle cursor must wrap so every previously projected message can
-- be revisited after a rewind/compaction. Keep them as separate columns and
-- update both in the same projection transaction.

alter table public.projection_checkpoints
  add column if not exists last_lifecycle_scan_message_id bigint not null default 0;

alter table public.projection_checkpoints
  drop constraint if exists projection_checkpoints_lifecycle_scan_nonnegative;

alter table public.projection_checkpoints
  add constraint projection_checkpoints_lifecycle_scan_nonnegative
  check (last_lifecycle_scan_message_id >= 0);

create or replace function public.bibi_apply_message_projection_v2(
  p_owner_id uuid,
  p_binding_id uuid,
  p_conversation_id uuid,
  p_organization_profile_id text,
  p_execution_profile_id text,
  p_hermes_session_id text,
  p_channel text,
  p_messages jsonb,
  p_lifecycle_scan_cursor bigint
)
returns table (accepted integer, duplicates integer, checkpoint bigint, lifecycle_checkpoint bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.conversation_bindings%rowtype;
  v_input_count integer;
  v_accepted integer;
  v_checkpoint bigint;
  v_lifecycle_checkpoint bigint;
begin
  if jsonb_typeof(p_messages) <> 'array'
     or jsonb_array_length(p_messages) < 1
     or jsonb_array_length(p_messages) > 500 then
    raise exception 'projection batch must contain 1 to 500 messages' using errcode = 'check_violation';
  end if;
  if p_lifecycle_scan_cursor is null or p_lifecycle_scan_cursor < 0 then
    raise exception 'invalid lifecycle projection cursor' using errcode = 'check_violation';
  end if;
  v_input_count := jsonb_array_length(p_messages);

  select * into v_binding
    from public.conversation_bindings
   where id = p_binding_id
     and owner_id = p_owner_id
     and conversation_id = p_conversation_id
     and organization_profile_id = p_organization_profile_id
     and execution_profile_id = p_execution_profile_id
     and hermes_session_id = p_hermes_session_id
     and channel = p_channel
     and binding_state = 'verified'
     and verified_at is not null
     and verified_by_node_id is not null;
  if v_binding.id is null then
    raise exception 'projection binding owner/profile/proof mismatch' using errcode = 'check_violation';
  end if;

  with source as (
    select * from jsonb_to_recordset(p_messages) as m(
      "sourceMessageId" bigint,
      "sourceSequence" bigint,
      "sourceTimestamp" timestamptz,
      role text,
      body text,
      "contentSha256" text,
      "originChannel" text,
      "canonicalMessageKey" text,
      "canonicalTurnId" uuid,
      "lifecycleState" text
    )
  ), inserted as (
    insert into public.projected_messages (
      owner_id, conversation_id, binding_id, organization_profile_id,
      execution_profile_id, hermes_session_id, channel, source_message_id,
      origin_channel, canonical_message_key, canonical_turn_id,
      lifecycle_state, source_sequence, source_timestamp, role, body, content_sha256
    )
    select p_owner_id, p_conversation_id, p_binding_id, p_organization_profile_id,
           p_execution_profile_id, p_hermes_session_id, p_channel,
           "sourceMessageId", "originChannel", "canonicalMessageKey", "canonicalTurnId",
           "lifecycleState", "sourceSequence", "sourceTimestamp", role, body, "contentSha256"
      from source
    on conflict (owner_id, execution_profile_id, hermes_session_id, source_message_id) do update
      set lifecycle_state = excluded.lifecycle_state,
          body = excluded.body,
          content_sha256 = excluded.content_sha256,
          projected_at = now(),
          sync_status = 'synced'
      where public.projected_messages.lifecycle_state is distinct from excluded.lifecycle_state
         or public.projected_messages.content_sha256 is distinct from excluded.content_sha256
    returning source_message_id, lifecycle_state, (xmax <> 0) as replaced
  ), audited as (
    insert into public.conversation_audit_events (
      owner_id, conversation_id, binding_id, event_id, event_type,
      organization_profile_id, execution_profile_id, hermes_session_id, payload
    )
    select p_owner_id, p_conversation_id, p_binding_id,
           'projection:' || p_binding_id::text || ':' || i.source_message_id::text || ':' || i.lifecycle_state,
           case when i.replaced and i.lifecycle_state = 'active' then 'replace'
                when i.lifecycle_state = 'active' then 'deliver'
                when i.lifecycle_state = 'archived' then 'archive'
                when i.lifecycle_state = 'deleted' then 'delete'
                else 'retention' end,
           p_organization_profile_id, p_execution_profile_id, p_hermes_session_id,
           jsonb_build_object('sourceMessageId', i.source_message_id, 'lifecycleState', i.lifecycle_state)
      from inserted i
    on conflict (owner_id, event_id) do nothing
    returning id
  )
  select count(*)::integer into v_accepted from inserted;

  select max((item->>'sourceMessageId')::bigint) into v_checkpoint
    from jsonb_array_elements(p_messages) item;

  insert into public.projection_checkpoints (
    owner_id, binding_id, organization_profile_id, execution_profile_id,
    hermes_session_id, last_source_message_id, last_source_sequence,
    last_lifecycle_scan_message_id, last_content_sha256,
    sync_status, last_error, updated_at
  ) values (
    p_owner_id, p_binding_id, p_organization_profile_id, p_execution_profile_id,
    p_hermes_session_id, v_checkpoint, v_checkpoint,
    p_lifecycle_scan_cursor,
    p_messages->(jsonb_array_length(p_messages) - 1)->>'contentSha256',
    'synced', null, now()
  )
  on conflict (binding_id) do update
    set last_source_message_id = greatest(public.projection_checkpoints.last_source_message_id, excluded.last_source_message_id),
        last_source_sequence = greatest(public.projection_checkpoints.last_source_sequence, excluded.last_source_sequence),
        last_lifecycle_scan_message_id = excluded.last_lifecycle_scan_message_id,
        last_content_sha256 = excluded.last_content_sha256,
        sync_status = 'synced',
        last_error = null,
        updated_at = now()
  returning last_source_message_id, last_lifecycle_scan_message_id
       into v_checkpoint, v_lifecycle_checkpoint;

  update public.conversations
     set sync_status = 'synced', sync_error = null, last_message_at = now(), updated_at = now()
   where id = p_conversation_id and owner_id = p_owner_id;

  insert into public.conversation_audit_events (
    owner_id, conversation_id, binding_id, event_id, event_type,
    organization_profile_id, execution_profile_id, hermes_session_id, payload
  ) values (
    p_owner_id, p_conversation_id, p_binding_id,
    'projection:' || p_binding_id::text || ':' || v_checkpoint::text || ':' || v_lifecycle_checkpoint::text,
    'project', p_organization_profile_id, p_execution_profile_id, p_hermes_session_id,
    jsonb_build_object(
      'checkpoint', v_checkpoint,
      'lifecycleCheckpoint', v_lifecycle_checkpoint,
      'accepted', v_accepted
    )
  ) on conflict (owner_id, event_id) do nothing;

  return query select v_accepted, v_input_count - v_accepted, v_checkpoint, v_lifecycle_checkpoint;
end;
$$;

revoke all on function public.bibi_apply_message_projection_v2(uuid, uuid, uuid, text, text, text, text, jsonb, bigint) from public;
revoke all on function public.bibi_apply_message_projection_v2(uuid, uuid, uuid, text, text, text, text, jsonb, bigint) from anon;
revoke all on function public.bibi_apply_message_projection_v2(uuid, uuid, uuid, text, text, text, text, jsonb, bigint) from authenticated;
grant execute on function public.bibi_apply_message_projection_v2(uuid, uuid, uuid, text, text, text, text, jsonb, bigint) to service_role;
