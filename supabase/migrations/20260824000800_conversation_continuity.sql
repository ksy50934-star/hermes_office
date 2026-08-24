-- Cross-channel conversation continuity (forward-only).
-- Supabase is an owner-scoped projection; the profile-local Hermes state.db
-- remains the execution/context record. No table in this migration grants a
-- browser write path.

alter table public.conversations
  add column if not exists execution_profile_id text
    check (execution_profile_id is null or execution_profile_id = 'default' or execution_profile_id ~ '^bibi-(0[2-9]|1[0-8])$'),
  add column if not exists origin_channel text not null default 'web'
    check (origin_channel in ('web', 'telegram')),
  add column if not exists sync_status text not null default 'local-only'
    check (sync_status in ('local-only', 'syncing', 'synced', 'offline', 'failed', 'blocked')),
  add column if not exists sync_error text,
  add column if not exists telegram_mirroring_enabled boolean not null default false;

update public.conversations c
   set execution_profile_id = p.execution_profile
  from public.bibi_profiles p
 where p.id = c.profile_id
   and c.execution_profile_id is null;

alter table public.conversations
  alter column execution_profile_id set not null;

alter table public.conversations
  drop constraint if exists conversations_ceo_execution_mapping;
alter table public.conversations
  add constraint conversations_ceo_execution_mapping
  check (not (profile_id = 'bibi-01' and execution_profile_id <> 'default'));
alter table public.conversations
  drop constraint if exists conversations_specialist_execution_mapping;
alter table public.conversations
  add constraint conversations_specialist_execution_mapping
  check (not (profile_id <> 'bibi-01' and execution_profile_id <> profile_id));

create table public.conversation_bindings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  organization_profile_id text not null references public.bibi_profiles (id) on delete restrict,
  execution_profile_id text not null
    check (execution_profile_id = 'default' or execution_profile_id ~ '^bibi-(0[2-9]|1[0-8])$'),
  channel text not null check (channel in ('telegram', 'web')),
  channel_account_id text not null,
  external_conversation_id text not null,
  hermes_session_id text not null check (length(hermes_session_id) between 1 and 200),
  binding_state text not null default 'verified'
    check (binding_state in ('pending', 'verified', 'blocked', 'unbound')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not (organization_profile_id = 'bibi-01' and execution_profile_id <> 'default')),
  check (not (organization_profile_id <> 'bibi-01' and execution_profile_id <> organization_profile_id)),
  unique (owner_id, channel, channel_account_id, external_conversation_id),
  unique (owner_id, execution_profile_id, hermes_session_id),
  unique (conversation_id, channel)
);
create index conversation_bindings_owner_idx on public.conversation_bindings (owner_id, conversation_id);

alter table public.work_items
  add column if not exists binding_id uuid references public.conversation_bindings (id) on delete restrict,
  add column if not exists hermes_session_id text,
  add column if not exists channel_origin text check (channel_origin is null or channel_origin in ('telegram', 'web')),
  add column if not exists continuation_status text not null default 'unbound'
    check (continuation_status in ('unbound', 'bound', 'blocked')),
  add column if not exists turn_idempotency_key text,
  add column if not exists execution_started_at timestamptz,
  add column if not exists execution_completed_at timestamptz,
  add column if not exists reconciliation_status text not null default 'not-required'
    check (reconciliation_status in ('not-required', 'pending', 'reconciled', 'blocked'));

create unique index work_items_turn_idempotency_key_idx
  on public.work_items (owner_id, turn_idempotency_key)
  where turn_idempotency_key is not null;

create index work_items_bound_session_idx
  on public.work_items (owner_id, hermes_session_id, status)
  where hermes_session_id is not null;

create or replace function public.bibi_send_chat_message(
  p_owner_id uuid,
  p_conversation_id uuid,
  p_client_message_id text,
  p_body text
)
returns table (message_id uuid, work_item_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_binding public.conversation_bindings%rowtype;
  v_message_id uuid;
  v_work_item_id uuid;
  v_client_request_id text := 'chat:' || p_client_message_id;
begin
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'chat message body is empty' using errcode = 'check_violation';
  end if;
  select * into v_conversation from public.conversations
   where id = p_conversation_id and owner_id = p_owner_id;
  if v_conversation.id is null then
    raise exception 'conversation not found for owner' using errcode = 'no_data_found';
  end if;

  select * into v_binding from public.conversation_bindings
   where owner_id = p_owner_id and conversation_id = p_conversation_id
     and channel = 'telegram'
     and binding_state = 'verified'
   order by created_at
   limit 1;
  if v_conversation.origin_channel = 'telegram' and v_binding.id is null then
    raise exception 'verified binding required for Telegram-origin conversation' using errcode = 'check_violation';
  end if;

  insert into public.messages (owner_id, conversation_id, profile_id, role, body, client_message_id)
  values (p_owner_id, p_conversation_id, v_conversation.profile_id, 'user', p_body, p_client_message_id)
  on conflict (conversation_id, client_message_id) do nothing returning id into v_message_id;
  if v_message_id is null then
    select id into v_message_id from public.messages
     where conversation_id = p_conversation_id and client_message_id = p_client_message_id;
    select id into v_work_item_id from public.work_items
     where owner_id = p_owner_id and client_request_id = v_client_request_id;
    return query select v_message_id, v_work_item_id, true;
    return;
  end if;

  insert into public.work_items (
    owner_id, profile_id, client_request_id, title, brief, kind, status,
    conversation_id, request_message_id, binding_id, hermes_session_id,
    channel_origin, continuation_status
  ) values (
    p_owner_id, v_conversation.profile_id, v_client_request_id,
    left(btrim(p_body), 80), p_body, 'chat', 'assigned',
    p_conversation_id, v_message_id, v_binding.id, v_binding.hermes_session_id,
    v_binding.channel, case when v_binding.id is null then 'unbound' else 'bound' end
  ) returning id into v_work_item_id;
  update public.conversations set last_message_at = now(), updated_at = now()
   where id = p_conversation_id and owner_id = p_owner_id;
  return query select v_message_id, v_work_item_id, false;
end;
$$;

revoke all on function public.bibi_send_chat_message(uuid, uuid, text, text) from public;
revoke all on function public.bibi_send_chat_message(uuid, uuid, text, text) from anon;
revoke all on function public.bibi_send_chat_message(uuid, uuid, text, text) from authenticated;
grant execute on function public.bibi_send_chat_message(uuid, uuid, text, text) to service_role;

create table public.projected_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  binding_id uuid not null references public.conversation_bindings (id) on delete cascade,
  organization_profile_id text not null references public.bibi_profiles (id) on delete restrict,
  execution_profile_id text not null
    check (execution_profile_id = 'default' or execution_profile_id ~ '^bibi-(0[2-9]|1[0-8])$'),
  hermes_session_id text not null,
  channel text not null check (channel in ('telegram', 'web')),
  origin_channel text not null check (origin_channel in ('telegram', 'web')),
  canonical_message_key text not null check (length(canonical_message_key) between 1 and 500),
  canonical_turn_id uuid references public.work_items (id) on delete restrict,
  lifecycle_state text not null default 'active'
    check (lifecycle_state in ('active', 'deleted', 'archived', 'retention')),
  source_message_id bigint not null check (source_message_id >= 0),
  source_sequence bigint not null check (source_sequence >= 0),
  source_timestamp timestamptz not null,
  role text not null check (role in ('user', 'assistant')),
  body text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  projected_at timestamptz not null default now(),
  sync_status text not null default 'synced'
    check (sync_status in ('syncing', 'synced', 'offline', 'failed', 'blocked')),
  unique (owner_id, execution_profile_id, hermes_session_id, source_message_id),
  unique (binding_id, source_sequence)
);
create index projected_messages_owner_idx on public.projected_messages (owner_id, conversation_id, source_sequence);
create unique index projected_messages_canonical_key_idx
  on public.projected_messages (owner_id, conversation_id, canonical_message_key);

create table public.projection_checkpoints (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  binding_id uuid not null references public.conversation_bindings (id) on delete cascade,
  organization_profile_id text not null references public.bibi_profiles (id) on delete restrict,
  execution_profile_id text not null
    check (execution_profile_id = 'default' or execution_profile_id ~ '^bibi-(0[2-9]|1[0-8])$'),
  hermes_session_id text not null,
  last_source_message_id bigint not null default 0 check (last_source_message_id >= 0),
  last_source_sequence bigint not null default 0 check (last_source_sequence >= 0),
  last_content_sha256 text check (last_content_sha256 is null or last_content_sha256 ~ '^[0-9a-f]{64}$'),
  sync_status text not null default 'offline'
    check (sync_status in ('syncing', 'synced', 'offline', 'failed', 'blocked')),
  last_error text,
  updated_at timestamptz not null default now(),
  unique (binding_id),
  unique (owner_id, execution_profile_id, hermes_session_id),
  check (not (organization_profile_id = 'bibi-01' and execution_profile_id <> 'default')),
  check (not (organization_profile_id <> 'bibi-01' and execution_profile_id <> organization_profile_id))
);
create index projection_checkpoints_owner_idx on public.projection_checkpoints (owner_id, binding_id);

create table public.conversation_resume_leases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  binding_id uuid not null references public.conversation_bindings (id) on delete cascade,
  work_item_id uuid not null references public.work_items (id) on delete cascade,
  attempt integer not null check (attempt > 0),
  turn_idempotency_key text not null,
  execution_profile_id text not null
    check (execution_profile_id = 'default' or execution_profile_id ~ '^bibi-(0[2-9]|1[0-8])$'),
  hermes_session_id text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  unique (work_item_id)
);
create index conversation_resume_leases_owner_idx on public.conversation_resume_leases (owner_id, conversation_id);
create unique index conversation_resume_leases_active_session_idx
  on public.conversation_resume_leases (owner_id, execution_profile_id, hermes_session_id)
  where released_at is null;

drop function if exists public.bibi_claim_work(uuid, uuid, integer, integer);
create function public.bibi_claim_work(
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
  update public.conversation_resume_leases
     set released_at = now(), release_reason = 'lease expired'
   where owner_id = p_owner_id and released_at is null and expires_at < now();
  update public.command_leases
     set released_at = now(), release_reason = 'lease expired'
   where owner_id = p_owner_id and released_at is null and expires_at < now();
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
            and r.execution_profile_id = (select execution_profile from public.bibi_profiles where id = w.profile_id)
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
    on conflict (owner_id, execution_profile_id, hermes_session_id) where released_at is null do nothing
    returning id, work_item_id
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
    on conflict (work_item_id, attempt) do nothing returning work_item_id
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

create or replace function public.bibi_renew_resume_lease(
  p_owner_id uuid,
  p_work_item_id uuid,
  p_expires_at timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.conversation_resume_leases
     set expires_at = p_expires_at
   where owner_id = p_owner_id and work_item_id = p_work_item_id
     and released_at is null and expires_at >= now();
  if not found and exists (
    select 1 from public.work_items
     where owner_id = p_owner_id and id = p_work_item_id and hermes_session_id is not null
  ) then
    raise exception 'active resume lease not found' using errcode = 'check_violation';
  end if;
end;
$$;
revoke all on function public.bibi_renew_resume_lease(uuid, uuid, timestamptz) from public;
revoke all on function public.bibi_renew_resume_lease(uuid, uuid, timestamptz) from anon;
revoke all on function public.bibi_renew_resume_lease(uuid, uuid, timestamptz) from authenticated;
grant execute on function public.bibi_renew_resume_lease(uuid, uuid, timestamptz) to service_role;

create or replace function public.bibi_release_resume_lease(p_owner_id uuid, p_work_item_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.conversation_resume_leases
     set released_at = now(), release_reason = p_reason
   where owner_id = p_owner_id and work_item_id = p_work_item_id and released_at is null;
end;
$$;
revoke all on function public.bibi_release_resume_lease(uuid, uuid, text) from public;
revoke all on function public.bibi_release_resume_lease(uuid, uuid, text) from anon;
revoke all on function public.bibi_release_resume_lease(uuid, uuid, text) from authenticated;
grant execute on function public.bibi_release_resume_lease(uuid, uuid, text) to service_role;

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
  select * into v_work from public.work_items
   where id = p_work_item_id and owner_id = p_owner_id
   for update;
  if v_work.id is null then
    raise exception 'work item not found for owner' using errcode = 'no_data_found';
  end if;

  if exists (
    select 1 from public.work_events
     where owner_id = p_owner_id and work_item_id = p_work_item_id and event_id = p_event_id
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
    returning id into v_result_id;

    select execution_profile into v_execution_profile
      from public.bibi_profiles where id = v_work.profile_id;
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

  update public.work_items
     set status = v_next_status,
         result_id = case when p_event_type = 'succeed' then v_result_id else result_id end,
         error = case when p_event_type = 'fail' then p_error when p_event_type = 'succeed' then null else error end,
         blocked_reason = case when p_event_type = 'block' then p_reason when p_event_type in ('release', 'succeed') then null else blocked_reason end,
         execution_started_at = case when p_event_type = 'start' then p_at else execution_started_at end,
         execution_completed_at = case when p_event_type in ('succeed', 'fail') then p_at else execution_completed_at end,
         reconciliation_status = case when p_event_type in ('succeed', 'fail') then 'reconciled' else reconciliation_status end,
         lease_id = case when p_event_type in ('succeed', 'fail', 'release', 'block') then null else lease_id end,
         node_id = case when p_event_type in ('succeed', 'fail', 'release', 'block') then null else node_id end,
         lease_expires_at = case when p_event_type in ('succeed', 'fail', 'release', 'block') then null else lease_expires_at end,
         updated_at = p_at
   where id = p_work_item_id and owner_id = p_owner_id;

  if p_event_type in ('succeed', 'fail', 'release', 'block') then
    update public.command_leases
       set released_at = p_at, release_reason = p_event_type
     where owner_id = p_owner_id and work_item_id = p_work_item_id
       and connector_node_id = p_connector_node_id and attempt = p_attempt and released_at is null;
    update public.conversation_resume_leases
       set released_at = p_at, release_reason = p_event_type
     where owner_id = p_owner_id and work_item_id = p_work_item_id
       and attempt = p_attempt and turn_idempotency_key = p_turn_idempotency_key and released_at is null;
  end if;

  return query select false, v_next_status, v_result_id;
end;
$$;

revoke all on function public.bibi_apply_work_report(uuid, uuid, uuid, text, text, integer, text, text, text, text, text, jsonb, jsonb, timestamptz) from public;
revoke all on function public.bibi_apply_work_report(uuid, uuid, uuid, text, text, integer, text, text, text, text, text, jsonb, jsonb, timestamptz) from anon;
revoke all on function public.bibi_apply_work_report(uuid, uuid, uuid, text, text, integer, text, text, text, text, text, jsonb, jsonb, timestamptz) from authenticated;
grant execute on function public.bibi_apply_work_report(uuid, uuid, uuid, text, text, integer, text, text, text, text, text, jsonb, jsonb, timestamptz) to service_role;

create table public.conversation_audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  binding_id uuid references public.conversation_bindings (id) on delete set null,
  event_id text not null,
  event_type text not null
    check (event_type in ('pair', 'bind', 'project', 'resume', 'resume_blocked', 'release', 'replace', 'deliver', 'unbind', 'retention', 'archive', 'delete')),
  organization_profile_id text not null references public.bibi_profiles (id) on delete restrict,
  execution_profile_id text not null
    check (execution_profile_id = 'default' or execution_profile_id ~ '^bibi-(0[2-9]|1[0-8])$'),
  hermes_session_id text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check (not (organization_profile_id = 'bibi-01' and execution_profile_id <> 'default')),
  check (not (organization_profile_id <> 'bibi-01' and execution_profile_id <> organization_profile_id)),
  unique (owner_id, event_id)
);
create index conversation_audit_events_owner_idx on public.conversation_audit_events (owner_id, conversation_id, created_at);

create or replace function public.bibi_validate_conversation_binding()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_owner uuid;
  c_profile text;
  c_execution text;
begin
  select owner_id, profile_id, execution_profile_id
    into c_owner, c_profile, c_execution
    from public.conversations
   where id = new.conversation_id;
  if c_owner is distinct from new.owner_id
     or c_profile is distinct from new.organization_profile_id
     or c_execution is distinct from new.execution_profile_id then
    raise exception 'binding owner/profile mismatch' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger bibi_validate_conversation_binding
  before insert or update on public.conversation_bindings
  for each row execute function public.bibi_validate_conversation_binding();

create or replace function public.bibi_validate_projected_message()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  b public.conversation_bindings%rowtype;
  w public.work_items%rowtype;
begin
  select * into b from public.conversation_bindings where id = new.binding_id;
  if b.id is null
     or b.owner_id is distinct from new.owner_id
     or b.conversation_id is distinct from new.conversation_id
     or b.organization_profile_id is distinct from new.organization_profile_id
     or b.execution_profile_id is distinct from new.execution_profile_id
     or b.hermes_session_id is distinct from new.hermes_session_id
     or b.channel is distinct from new.channel then
    raise exception 'projection owner/profile mismatch' using errcode = 'check_violation';
  end if;
  if new.canonical_turn_id is not null then
    select * into w from public.work_items where id = new.canonical_turn_id;
    if w.id is null or w.owner_id is distinct from new.owner_id
       or w.conversation_id is distinct from new.conversation_id
       or w.binding_id is distinct from new.binding_id
       or new.origin_channel <> 'web'
       or (new.role = 'user' and new.canonical_message_key <> 'web:' || w.request_message_id::text)
       or (new.role = 'assistant' and new.canonical_message_key <> 'assistant:' || w.id::text) then
      raise exception 'projection canonical turn mismatch' using errcode = 'check_violation';
    end if;
  elsif new.origin_channel is distinct from b.channel
     or new.canonical_message_key <> 'telegram:' || new.execution_profile_id || ':' || new.hermes_session_id || ':' || new.source_message_id::text then
    raise exception 'projection provenance mismatch' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger bibi_validate_projected_message
  before insert or update on public.projected_messages
  for each row execute function public.bibi_validate_projected_message();

create or replace function public.bibi_validate_conversation_audit_event()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  c public.conversations%rowtype;
  b public.conversation_bindings%rowtype;
begin
  select * into c from public.conversations where id = new.conversation_id;
  if c.id is null or c.owner_id is distinct from new.owner_id
     or c.profile_id is distinct from new.organization_profile_id
     or c.execution_profile_id is distinct from new.execution_profile_id then
    raise exception 'audit owner/profile mismatch' using errcode = 'check_violation';
  end if;
  if new.binding_id is not null then
    select * into b from public.conversation_bindings where id = new.binding_id;
    if b.id is null or b.owner_id is distinct from new.owner_id
       or b.conversation_id is distinct from new.conversation_id then
      raise exception 'audit owner/profile mismatch' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger bibi_validate_conversation_audit_event
  before insert on public.conversation_audit_events
  for each row execute function public.bibi_validate_conversation_audit_event();

create or replace function public.bibi_reject_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'conversation audit events are append-only' using errcode = 'check_violation';
end;
$$;

create trigger bibi_reject_audit_mutation
  before update or delete on public.conversation_audit_events
  for each row execute function public.bibi_reject_audit_mutation();

create or replace function public.bibi_apply_message_projection(
  p_owner_id uuid,
  p_binding_id uuid,
  p_conversation_id uuid,
  p_organization_profile_id text,
  p_execution_profile_id text,
  p_hermes_session_id text,
  p_channel text,
  p_messages jsonb
)
returns table (accepted integer, duplicates integer, checkpoint bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.conversation_bindings%rowtype;
  v_input_count integer := jsonb_array_length(p_messages);
  v_accepted integer;
  v_checkpoint bigint;
begin
  select * into v_binding
    from public.conversation_bindings
   where id = p_binding_id
     and owner_id = p_owner_id
     and conversation_id = p_conversation_id
     and organization_profile_id = p_organization_profile_id
     and execution_profile_id = p_execution_profile_id
     and hermes_session_id = p_hermes_session_id
     and channel = p_channel
     and binding_state = 'verified';
  if v_binding.id is null then
    raise exception 'projection binding owner/profile mismatch' using errcode = 'check_violation';
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
              projected_at = now(), sync_status = 'synced'
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
    last_content_sha256, sync_status, last_error, updated_at
  )
  values (
    p_owner_id, p_binding_id, p_organization_profile_id, p_execution_profile_id,
    p_hermes_session_id, v_checkpoint, v_checkpoint,
    p_messages->(jsonb_array_length(p_messages) - 1)->>'contentSha256', 'synced', null, now()
  )
  on conflict (binding_id) do update
    set last_source_message_id = greatest(public.projection_checkpoints.last_source_message_id, excluded.last_source_message_id),
        last_source_sequence = greatest(public.projection_checkpoints.last_source_sequence, excluded.last_source_sequence),
        last_content_sha256 = excluded.last_content_sha256,
        sync_status = 'synced', last_error = null, updated_at = now()
  returning last_source_message_id into v_checkpoint;

  update public.conversations
     set sync_status = 'synced', sync_error = null, last_message_at = now(), updated_at = now()
   where id = p_conversation_id and owner_id = p_owner_id;

  insert into public.conversation_audit_events (
    owner_id, conversation_id, binding_id, event_id, event_type,
    organization_profile_id, execution_profile_id, hermes_session_id, payload
  ) values (
    p_owner_id, p_conversation_id, p_binding_id,
    'projection:' || p_binding_id::text || ':' || v_checkpoint::text,
    'project', p_organization_profile_id, p_execution_profile_id, p_hermes_session_id,
    jsonb_build_object('checkpoint', v_checkpoint, 'accepted', v_accepted)
  ) on conflict (owner_id, event_id) do nothing;

  return query select v_accepted, v_input_count - v_accepted, v_checkpoint;
end;
$$;

revoke all on function public.bibi_apply_message_projection(uuid, uuid, uuid, text, text, text, text, jsonb) from public;
revoke all on function public.bibi_apply_message_projection(uuid, uuid, uuid, text, text, text, text, jsonb) from anon;
revoke all on function public.bibi_apply_message_projection(uuid, uuid, uuid, text, text, text, text, jsonb) from authenticated;
grant execute on function public.bibi_apply_message_projection(uuid, uuid, uuid, text, text, text, text, jsonb) to service_role;

alter table public.conversation_bindings enable row level security;
alter table public.conversation_bindings force row level security;
alter table public.projected_messages enable row level security;
alter table public.projected_messages force row level security;
alter table public.projection_checkpoints enable row level security;
alter table public.projection_checkpoints force row level security;
alter table public.conversation_resume_leases enable row level security;
alter table public.conversation_resume_leases force row level security;
alter table public.conversation_audit_events enable row level security;
alter table public.conversation_audit_events force row level security;

create policy "conversation_bindings_select_own" on public.conversation_bindings
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "projected_messages_select_own" on public.projected_messages
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "projection_checkpoints_select_own" on public.projection_checkpoints
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "conversation_resume_leases_select_own" on public.conversation_resume_leases
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "conversation_audit_events_select_own" on public.conversation_audit_events
  for select to authenticated using (owner_id = (select auth.uid()));
