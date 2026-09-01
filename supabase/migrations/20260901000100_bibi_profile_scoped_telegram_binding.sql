-- Scope a Telegram DM binding to its physical Hermes execution profile.
--
-- Every Bibi profile has its own state.db and therefore its own Hermes session
-- for the same Telegram DM. The previous live-channel identity omitted
-- execution_profile_id, so a valid bibi-14 session collided with bibi-02's
-- binding even though their local histories and projection checkpoints are
-- intentionally separate.

begin;

drop index if exists public.conversation_bindings_live_channel_identity_idx;
create unique index conversation_bindings_live_channel_identity_idx
  on public.conversation_bindings (
    owner_id, execution_profile_id, channel,
    channel_account_id, external_conversation_id
  )
  where binding_state <> 'unbound';

create or replace function public.bibi_request_conversation_binding(
  p_owner_id uuid,
  p_conversation_id uuid,
  p_channel text,
  p_channel_account_id text,
  p_external_conversation_id text,
  p_hermes_session_id text,
  p_client_request_id text
)
returns table (binding_id uuid, binding_state text, duplicate boolean, retried boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_binding public.conversation_bindings%rowtype;
begin
  if p_channel is distinct from 'telegram' then
    raise exception 'only telegram bindings may be requested' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_channel_account_id), '') = ''
     or coalesce(btrim(p_external_conversation_id), '') = ''
     or coalesce(btrim(p_hermes_session_id), '') = '' then
    raise exception 'binding identity is incomplete' using errcode = 'check_violation';
  end if;

  select * into v_conversation from public.conversations
   where id = p_conversation_id and owner_id = p_owner_id;
  if v_conversation.id is null then
    raise exception 'conversation not found for owner' using errcode = 'no_data_found';
  end if;

  -- Serialize owner-side creation/replacement without taking the conversation
  -- row lock. Connector verify/fail and owner cancel lock binding then
  -- conversation; avoiding the opposite row-lock order prevents deadlocks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'bibi-binding:' || p_owner_id::text || ':' || p_conversation_id::text || ':' || p_channel,
    0
  ));

  -- Same submission twice: return the row the first one made.
  if p_client_request_id is not null then
    select * into v_binding from public.conversation_bindings
     where owner_id = p_owner_id and client_request_id = p_client_request_id;
    if v_binding.id is not null then
      return query select v_binding.id, v_binding.binding_state, true, false;
      return;
    end if;
  end if;

  select cb.* into v_binding from public.conversation_bindings cb
   where cb.owner_id = p_owner_id
     and cb.execution_profile_id = v_conversation.execution_profile_id
     and cb.channel = p_channel
     and cb.channel_account_id = p_channel_account_id
     and cb.external_conversation_id = p_external_conversation_id
     and cb.binding_state <> 'unbound'
   for update;

  if v_binding.id is not null then
    if v_binding.conversation_id is distinct from p_conversation_id then
      raise exception 'this Telegram conversation is already bound to another conversation'
        using errcode = 'unique_violation';
    end if;
    if v_binding.binding_state = 'verified' then
      return query select v_binding.id, v_binding.binding_state, true, false;
      return;
    end if;
    if v_binding.binding_state = 'pending'
       and v_binding.hermes_session_id = p_hermes_session_id then
      return query select v_binding.id, v_binding.binding_state, true, false;
      return;
    end if;

    -- Retry after a blocked attempt. The error is cleared here so the UI stops
    -- showing a reason that no longer applies to the new attempt.
    update public.conversation_bindings
       set binding_state = 'pending',
           hermes_session_id = p_hermes_session_id,
           verified_at = null,
           verified_by_node_id = null,
           verification_code = null,
           verification_error = null,
           cancelled_at = null,
           request_count = request_count + 1,
           client_request_id = coalesce(p_client_request_id, client_request_id)
     where id = v_binding.id
    returning * into v_binding;

    insert into public.conversation_audit_events (
      owner_id, conversation_id, binding_id, event_id, event_type,
      organization_profile_id, execution_profile_id, hermes_session_id, payload
    ) values (
      p_owner_id, p_conversation_id, v_binding.id,
      'pair:' || v_binding.id::text || ':' || v_binding.request_count::text,
      'pair', v_conversation.profile_id, v_conversation.execution_profile_id,
      p_hermes_session_id,
      jsonb_build_object('initiationSource', 'user', 'retry', true, 'requestCount', v_binding.request_count)
    ) on conflict (owner_id, event_id) do nothing;

    return query select v_binding.id, v_binding.binding_state, false, true;
    return;
  end if;

  -- `request` is the first-binding verb. Once this conversation/channel has
  -- history, even if every row is now unbound, callers must use the replacement
  -- RPC. This closes the owner-route bypass that could otherwise recreate the
  -- just-cancelled Hermes session with the onboarding action.
  if exists (
    select 1
    from public.conversation_bindings as cb
    where cb.owner_id = p_owner_id
      and cb.conversation_id = p_conversation_id
      and cb.channel = p_channel
  ) then
    raise exception 'request is only valid for the first binding; use a replacement session'
      using errcode = 'check_violation';
  end if;

  insert into public.conversation_bindings (
    owner_id, conversation_id, organization_profile_id, execution_profile_id,
    channel, channel_account_id, external_conversation_id, hermes_session_id,
    binding_state, initiation_source, client_request_id
  ) values (
    p_owner_id, p_conversation_id, v_conversation.profile_id, v_conversation.execution_profile_id,
    p_channel, btrim(p_channel_account_id), btrim(p_external_conversation_id), btrim(p_hermes_session_id),
    'pending', 'user', p_client_request_id
  ) returning * into v_binding;

  insert into public.conversation_audit_events (
    owner_id, conversation_id, binding_id, event_id, event_type,
    organization_profile_id, execution_profile_id, hermes_session_id, payload
  ) values (
    p_owner_id, p_conversation_id, v_binding.id,
    'pair:' || v_binding.id::text || ':' || v_binding.request_count::text,
    'pair', v_conversation.profile_id, v_conversation.execution_profile_id,
    btrim(p_hermes_session_id),
    jsonb_build_object('initiationSource', 'user', 'retry', false, 'requestCount', v_binding.request_count)
  ) on conflict (owner_id, event_id) do nothing;

  return query select v_binding.id, v_binding.binding_state, false, false;
end;
$$;

revoke all on function public.bibi_request_conversation_binding(uuid, uuid, text, text, text, text, text) from public;
revoke all on function public.bibi_request_conversation_binding(uuid, uuid, text, text, text, text, text) from anon;
revoke all on function public.bibi_request_conversation_binding(uuid, uuid, text, text, text, text, text) from authenticated;
grant execute on function public.bibi_request_conversation_binding(uuid, uuid, text, text, text, text, text) to service_role;

create or replace function public.bibi_replace_conversation_binding(
  p_owner_id uuid,
  p_conversation_id uuid,
  p_channel text,
  p_channel_account_id text,
  p_external_conversation_id text,
  p_hermes_session_id text,
  p_client_request_id text
)
returns table (
  binding_id uuid,
  binding_state text,
  duplicate boolean,
  previous_binding_id uuid,
  previous_binding_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_live public.conversation_bindings%rowtype;
  v_previous public.conversation_bindings%rowtype;
  v_binding public.conversation_bindings%rowtype;
begin
  if p_channel is distinct from 'telegram' then
    raise exception 'only telegram bindings may be requested' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_channel_account_id), '') = ''
     or coalesce(btrim(p_external_conversation_id), '') = ''
     or coalesce(btrim(p_hermes_session_id), '') = '' then
    raise exception 'binding identity is incomplete' using errcode = 'check_violation';
  end if;

  select * into v_conversation from public.conversations
   where id = p_conversation_id and owner_id = p_owner_id;
  if v_conversation.id is null then
    raise exception 'conversation not found for owner' using errcode = 'no_data_found';
  end if;

  -- Serialize owner-side creation/replacement without taking the conversation
  -- row lock. Connector verify/fail and owner cancel lock binding then
  -- conversation; avoiding the opposite row-lock order prevents deadlocks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'bibi-binding:' || p_owner_id::text || ':' || p_conversation_id::text || ':' || p_channel,
    0
  ));

  -- The cancelled binding this rotation follows. Reported back so the caller can
  -- show what was replaced, and read before the insert so it names the row that
  -- existed beforehand.
  select cb.* into v_previous from public.conversation_bindings cb
   where cb.owner_id = p_owner_id
     and cb.conversation_id = p_conversation_id
     and cb.channel = p_channel
     and cb.binding_state = 'unbound'
   order by cb.cancelled_at desc nulls last, cb.created_at desc
   limit 1;

  if v_previous.id is null then
    raise exception 'the current binding must be cancelled before a new session is requested'
      using errcode = 'check_violation';
  end if;
  if v_previous.hermes_session_id = btrim(p_hermes_session_id) then
    raise exception 'replacement must name a different Hermes session'
      using errcode = 'check_violation';
  end if;

  -- A resend of the same submission resolves to the row the first one made.
  if p_client_request_id is not null then
    select * into v_binding from public.conversation_bindings
     where owner_id = p_owner_id and client_request_id = p_client_request_id;
    if v_binding.id is not null then
      if v_binding.conversation_id is distinct from p_conversation_id
         or v_binding.channel is distinct from p_channel
         or v_binding.channel_account_id is distinct from btrim(p_channel_account_id)
         or v_binding.external_conversation_id is distinct from btrim(p_external_conversation_id)
         or v_binding.hermes_session_id is distinct from btrim(p_hermes_session_id) then
        raise exception 'client request id was already used for a different binding request'
          using errcode = 'unique_violation';
      end if;
      return query select v_binding.id, v_binding.binding_state, true,
                          v_previous.id, v_previous.binding_state;
      return;
    end if;
  end if;

  select cb.* into v_live from public.conversation_bindings cb
   where cb.owner_id = p_owner_id
     and cb.conversation_id = p_conversation_id
     and cb.channel = p_channel
     and cb.binding_state <> 'unbound'
   for update;

  if v_live.id is not null then
    -- Already pointing at the requested session: this is the same intention
    -- arriving twice, not a rotation.
    if v_live.hermes_session_id = p_hermes_session_id
       and v_live.channel_account_id = btrim(p_channel_account_id)
       and v_live.external_conversation_id = btrim(p_external_conversation_id) then
      return query select v_live.id, v_live.binding_state, true,
                          v_previous.id, v_previous.binding_state;
      return;
    end if;
    raise exception 'the current binding must be cancelled before a new session is requested'
      using errcode = 'unique_violation';
  end if;

  -- The same Telegram address, or the same Hermes session, live under some other
  -- conversation. Binding it here would give one thread two homes.
  if exists (
    select 1 from public.conversation_bindings cb
     where cb.owner_id = p_owner_id
       and cb.execution_profile_id = v_conversation.execution_profile_id
       and cb.channel = p_channel
       and cb.binding_state <> 'unbound'
       and cb.conversation_id is distinct from p_conversation_id
       and (
         (cb.channel_account_id = btrim(p_channel_account_id)
          and cb.external_conversation_id = btrim(p_external_conversation_id))
         or (cb.execution_profile_id = v_conversation.execution_profile_id
            and cb.hermes_session_id = btrim(p_hermes_session_id))
       )
  ) then
    raise exception 'this Telegram conversation is already bound to another conversation'
      using errcode = 'unique_violation';
  end if;

  insert into public.conversation_bindings (
    owner_id, conversation_id, organization_profile_id, execution_profile_id,
    channel, channel_account_id, external_conversation_id, hermes_session_id,
    binding_state, initiation_source, client_request_id
  ) values (
    p_owner_id, p_conversation_id, v_conversation.profile_id, v_conversation.execution_profile_id,
    p_channel, btrim(p_channel_account_id), btrim(p_external_conversation_id), btrim(p_hermes_session_id),
    'pending', 'user', p_client_request_id
  ) returning * into v_binding;

  insert into public.conversation_audit_events (
    owner_id, conversation_id, binding_id, event_id, event_type,
    organization_profile_id, execution_profile_id, hermes_session_id, payload
  ) values (
    p_owner_id, p_conversation_id, v_binding.id,
    'replace:' || v_binding.id::text || ':' || v_binding.request_count::text,
    'replace', v_conversation.profile_id, v_conversation.execution_profile_id,
    btrim(p_hermes_session_id),
    jsonb_build_object(
      'initiationSource', 'user',
      'previousBindingId', v_previous.id,
      'previousHermesSessionId', v_previous.hermes_session_id,
      'requestCount', v_binding.request_count
    )
  ) on conflict (owner_id, event_id) do nothing;

  return query select v_binding.id, v_binding.binding_state, false,
                      v_previous.id, v_previous.binding_state;
end;
$$;

revoke all on function public.bibi_replace_conversation_binding(uuid, uuid, text, text, text, text, text) from public;
revoke all on function public.bibi_replace_conversation_binding(uuid, uuid, text, text, text, text, text) from anon;
revoke all on function public.bibi_replace_conversation_binding(uuid, uuid, text, text, text, text, text) from authenticated;
grant execute on function public.bibi_replace_conversation_binding(uuid, uuid, text, text, text, text, text) to service_role;

commit;
