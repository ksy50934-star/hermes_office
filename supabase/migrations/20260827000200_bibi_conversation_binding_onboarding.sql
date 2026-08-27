-- Telegram binding onboarding: the user asks, the connector proves.
--
-- `20260824000800` created `conversation_bindings` with `binding_state`
-- defaulting to `'verified'`. That default is the whole security hole: any row
-- that reached the table without naming a state was trusted as a proven link
-- between a Supabase conversation and a Hermes Telegram session, and
-- `bibi_apply_message_projection` accepts exactly those rows. A binding is a
-- claim about identity on a machine the cloud cannot see, so nothing that the
-- browser or the API can write on its own may assert it.
--
-- The split this migration installs:
--
--   * The owner *requests* a binding. That request is always `pending`, and it
--     carries the identity the connector must go and confirm.
--   * The authenticated outbound connector *verifies* it, after it has proved
--     the exact Hermes session, its Telegram origin, and the execution profile
--     against the profile-local `state.db` it alone can read.
--   * Nothing else can reach `'verified'` at all. The guard trigger below
--     refuses the transition unless the transaction is inside the connector
--     verification function, so a direct service-role UPDATE — the one write
--     path RLS cannot catch — fails closed too.
--
-- Cancelling is a state change, never a delete: `projected_messages`, `messages`
-- and the audit trail are the record of a conversation that really happened, and
-- unbinding a channel is not a reason to lose it.
--
-- The discovery tables at the bottom exist so the onboarding UI can offer real
-- Telegram sessions instead of asking the owner to type a raw identifier. They
-- deliberately hold no message body, no title and no excerpt: discovery reports
-- that a session exists and how it is addressed, never what was said in it.

-- ---------------------------------------------------------------------------
-- Binding request state
-- ---------------------------------------------------------------------------

alter table public.conversation_bindings
  alter column binding_state set default 'pending';

alter table public.conversation_bindings
  add column if not exists initiation_source text not null default 'user',
  add column if not exists client_request_id text,
  add column if not exists request_count integer not null default 1,
  add column if not exists verified_by_node_id uuid references public.connector_nodes (id) on delete set null,
  add column if not exists verification_code text,
  add column if not exists verification_error text,
  add column if not exists verification_attempts integer not null default 0,
  add column if not exists last_verification_at timestamptz,
  add column if not exists cancelled_at timestamptz;

comment on column public.conversation_bindings.initiation_source is
  'Who asked for this binding. A user-initiated row may only ever be created pending.';
comment on column public.conversation_bindings.verified_by_node_id is
  'The connector node that proved the Telegram session identity. Null unless verified.';

alter table public.conversation_bindings
  drop constraint if exists conversation_bindings_initiation_source_check;
alter table public.conversation_bindings
  add constraint conversation_bindings_initiation_source_check
  check (initiation_source in ('user', 'connector'));

alter table public.conversation_bindings
  drop constraint if exists conversation_bindings_request_count_check;
alter table public.conversation_bindings
  add constraint conversation_bindings_request_count_check
  check (request_count > 0);

alter table public.conversation_bindings
  drop constraint if exists conversation_bindings_verification_attempts_check;
alter table public.conversation_bindings
  add constraint conversation_bindings_verification_attempts_check
  check (verification_attempts >= 0);

-- A failed or revoked verification is a durable owner-visible fact. Expand the
-- audit vocabulary before remediating legacy rows so the migration itself can
-- record why an apparently verified binding was blocked.
alter table public.conversation_audit_events
  drop constraint if exists conversation_audit_events_event_type_check;
alter table public.conversation_audit_events
  add constraint conversation_audit_events_event_type_check
  check (event_type in (
    'pair', 'bind', 'verify_failed', 'project', 'resume', 'resume_blocked',
    'release', 'replace', 'deliver', 'unbind', 'retention', 'archive', 'delete'
  ));

-- Legacy releases allowed `verified` without connector proof. Such rows must
-- lose projection authority before the new constraint is validated. The audit
-- insert is deterministic/idempotent so a retried migration cannot duplicate
-- the event.
insert into public.conversation_audit_events (
  owner_id, conversation_id, binding_id, event_id, event_type,
  organization_profile_id, execution_profile_id, hermes_session_id, payload
)
select
  b.owner_id, b.conversation_id, b.id,
  'verify_failed:legacy-unproved:' || b.id::text,
  'verify_failed', b.organization_profile_id, b.execution_profile_id,
  b.hermes_session_id,
  jsonb_build_object('code', 'LEGACY_UNPROVED_VERIFICATION', 'migration', '20260827000200')
from public.conversation_bindings b
where b.binding_state = 'verified'
  and (b.verified_at is null or b.verified_by_node_id is null)
on conflict (owner_id, event_id) do nothing;

update public.conversation_bindings
   set binding_state = 'blocked',
       verified_at = null,
       verified_by_node_id = null,
       verification_code = 'LEGACY_UNPROVED_VERIFICATION',
       verification_error = 'Legacy verified binding had no connector proof.',
       verification_attempts = verification_attempts + 1,
       last_verification_at = now(),
       updated_at = now()
 where binding_state = 'verified'
   and (verified_at is null or verified_by_node_id is null);

update public.conversations c
   set sync_status = 'blocked',
       sync_error = 'LEGACY_UNPROVED_VERIFICATION',
       updated_at = now()
 where exists (
   select 1 from public.conversation_bindings b
    where b.owner_id = c.owner_id
      and b.conversation_id = c.id
      and b.binding_state = 'blocked'
      and b.verification_code = 'LEGACY_UNPROVED_VERIFICATION'
 );

-- A legacy pending row is unproved by definition. Clear stale proof remnants
-- before validating the pending-state invariant too.
update public.conversation_bindings
   set verified_at = null,
       verified_by_node_id = null,
       updated_at = now()
 where binding_state = 'pending'
   and (verified_at is not null or verified_by_node_id is not null);

alter table public.conversation_bindings
  drop constraint if exists conversation_bindings_verified_requires_connector_proof;
alter table public.conversation_bindings
  add constraint conversation_bindings_verified_requires_connector_proof
  check (binding_state <> 'verified' or (verified_at is not null and verified_by_node_id is not null))
  not valid;
alter table public.conversation_bindings
  validate constraint conversation_bindings_verified_requires_connector_proof;

alter table public.conversation_bindings
  drop constraint if exists conversation_bindings_pending_is_unproven;
alter table public.conversation_bindings
  add constraint conversation_bindings_pending_is_unproven
  check (binding_state <> 'pending' or (verified_at is null and verified_by_node_id is null))
  not valid;
alter table public.conversation_bindings
  validate constraint conversation_bindings_pending_is_unproven;

-- The idempotency key for "create this binding". A retried request after a
-- dropped response returns the original row instead of racing the unique
-- identity constraint.
create unique index if not exists conversation_bindings_client_request_idx
  on public.conversation_bindings (owner_id, client_request_id)
  where client_request_id is not null;

create index if not exists conversation_bindings_pending_idx
  on public.conversation_bindings (owner_id, binding_state, created_at)
  where binding_state = 'pending';

-- ---------------------------------------------------------------------------
-- The fail-closed guard
-- ---------------------------------------------------------------------------

-- `bibi.binding_verification` is set transaction-locally by
-- `bibi_verify_conversation_binding` and by nothing else. A plain UPDATE — from
-- the browser under a future policy, from the API with the service role, from
-- psql — never sets it, so it never reaches 'verified'.
--
-- Named to sort before `bibi_validate_conversation_binding`: Postgres fires
-- BEFORE ROW triggers in name order, and this one must decide first.
create or replace function public.bibi_guard_binding_verification()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.initiation_source = 'user' and new.binding_state <> 'pending' then
    raise exception 'a user initiated binding may only be created pending'
      using errcode = 'check_violation';
  end if;

  if new.binding_state = 'verified'
     and (tg_op = 'INSERT' or old.binding_state is distinct from 'verified') then
    if coalesce(current_setting('bibi.binding_verification', true), '') <> 'connector' then
      raise exception 'binding verification requires the authenticated connector'
        using errcode = 'check_violation';
    end if;
    if new.verified_at is null or new.verified_by_node_id is null then
      raise exception 'binding verification requires connector proof'
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bibi_guard_binding_verification on public.conversation_bindings;
create trigger bibi_guard_binding_verification
  before insert or update on public.conversation_bindings
  for each row execute function public.bibi_guard_binding_verification();

-- ---------------------------------------------------------------------------
-- Owner initiation: pending only
-- ---------------------------------------------------------------------------

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

  -- Same submission twice: return the row the first one made.
  if p_client_request_id is not null then
    select * into v_binding from public.conversation_bindings
     where owner_id = p_owner_id and client_request_id = p_client_request_id;
    if v_binding.id is not null then
      return query select v_binding.id, v_binding.binding_state, true, false;
      return;
    end if;
  end if;

  select * into v_binding from public.conversation_bindings
   where owner_id = p_owner_id
     and channel = p_channel
     and channel_account_id = p_channel_account_id
     and external_conversation_id = p_external_conversation_id
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

    -- Retry after a blocked or cancelled attempt. The error is cleared here so
    -- the UI stops showing a reason that no longer applies to the new attempt.
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

-- ---------------------------------------------------------------------------
-- Owner cancellation: unbind the channel, keep every canonical message
-- ---------------------------------------------------------------------------

create or replace function public.bibi_cancel_conversation_binding(
  p_owner_id uuid,
  p_binding_id uuid,
  p_reason text
)
returns table (binding_id uuid, binding_state text, already_unbound boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.conversation_bindings%rowtype;
begin
  select * into v_binding from public.conversation_bindings
   where id = p_binding_id and owner_id = p_owner_id
   for update;
  if v_binding.id is null then
    raise exception 'binding not found for owner' using errcode = 'no_data_found';
  end if;
  if v_binding.binding_state = 'unbound' then
    return query select v_binding.id, v_binding.binding_state, true;
    return;
  end if;

  update public.conversation_bindings
     set binding_state = 'unbound',
         cancelled_at = now(),
         verified_at = null,
         verified_by_node_id = null,
         verification_code = null,
         verification_error = null
   where id = v_binding.id
  returning * into v_binding;

  -- The channel is gone; the conversation is not. Nothing here touches
  -- projected_messages, messages or the audit log.
  update public.conversations
     set sync_status = 'local-only',
         sync_error = null,
         telegram_mirroring_enabled = false,
         updated_at = now()
   where id = v_binding.conversation_id and owner_id = p_owner_id;

  insert into public.conversation_audit_events (
    owner_id, conversation_id, binding_id, event_id, event_type,
    organization_profile_id, execution_profile_id, hermes_session_id, payload
  ) values (
    p_owner_id, v_binding.conversation_id, v_binding.id,
    'unbind:' || v_binding.id::text || ':' || v_binding.request_count::text,
    'unbind', v_binding.organization_profile_id, v_binding.execution_profile_id,
    v_binding.hermes_session_id,
    jsonb_build_object('reason', coalesce(p_reason, 'owner cancelled'))
  ) on conflict (owner_id, event_id) do nothing;

  return query select v_binding.id, v_binding.binding_state, false;
end;
$$;

revoke all on function public.bibi_cancel_conversation_binding(uuid, uuid, text) from public;
revoke all on function public.bibi_cancel_conversation_binding(uuid, uuid, text) from anon;
revoke all on function public.bibi_cancel_conversation_binding(uuid, uuid, text) from authenticated;
grant execute on function public.bibi_cancel_conversation_binding(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Connector verification: the only path to 'verified'
-- ---------------------------------------------------------------------------

create or replace function public.bibi_verify_conversation_binding(
  p_owner_id uuid,
  p_connector_node_id uuid,
  p_binding_id uuid,
  p_channel_account_id text,
  p_external_conversation_id text,
  p_hermes_session_id text,
  p_execution_profile_id text,
  p_evidence jsonb
)
returns table (binding_id uuid, binding_state text, duplicate boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.conversation_bindings%rowtype;
begin
  if not exists (
    select 1 from public.connector_nodes
     where id = p_connector_node_id and owner_id = p_owner_id
  ) then
    raise exception 'connector node not found for owner' using errcode = 'no_data_found';
  end if;

  select * into v_binding from public.conversation_bindings
   where id = p_binding_id and owner_id = p_owner_id
   for update;
  if v_binding.id is null then
    raise exception 'binding not found for owner' using errcode = 'no_data_found';
  end if;
  -- The connector has to name back the exact identity it was asked about. A
  -- verification for some other session is not a verification of this one,
  -- including an idempotent retry against an already-verified row.
  if v_binding.channel_account_id is distinct from p_channel_account_id
     or v_binding.external_conversation_id is distinct from p_external_conversation_id
     or v_binding.hermes_session_id is distinct from p_hermes_session_id
     or v_binding.execution_profile_id is distinct from p_execution_profile_id then
    raise exception 'binding verification identity mismatch' using errcode = 'check_violation';
  end if;

  if v_binding.binding_state = 'verified' then
    if v_binding.verified_at is null or v_binding.verified_by_node_id is null then
      raise exception 'verified binding is missing connector proof' using errcode = 'check_violation';
    end if;
    return query select v_binding.id, v_binding.binding_state, true;
    return;
  end if;
  if v_binding.binding_state <> 'pending' then
    raise exception 'only a pending binding may be verified' using errcode = 'check_violation';
  end if;

  perform set_config('bibi.binding_verification', 'connector', true);

  update public.conversation_bindings
     set binding_state = 'verified',
         verified_at = now(),
         verified_by_node_id = p_connector_node_id,
         verification_code = null,
         verification_error = null,
         verification_attempts = verification_attempts + 1,
         last_verification_at = now()
   where id = v_binding.id
  returning * into v_binding;

  perform set_config('bibi.binding_verification', '', true);

  update public.conversations
     set sync_status = 'syncing', sync_error = null, updated_at = now()
   where id = v_binding.conversation_id and owner_id = p_owner_id;

  insert into public.conversation_audit_events (
    owner_id, conversation_id, binding_id, event_id, event_type,
    organization_profile_id, execution_profile_id, hermes_session_id, payload
  ) values (
    p_owner_id, v_binding.conversation_id, v_binding.id,
    'bind:' || v_binding.id::text || ':' || v_binding.verification_attempts::text,
    'bind', v_binding.organization_profile_id, v_binding.execution_profile_id,
    v_binding.hermes_session_id,
    jsonb_build_object('connectorNodeId', p_connector_node_id, 'evidence', coalesce(p_evidence, '{}'::jsonb))
  ) on conflict (owner_id, event_id) do nothing;

  return query select v_binding.id, v_binding.binding_state, false;
end;
$$;

revoke all on function public.bibi_verify_conversation_binding(uuid, uuid, uuid, text, text, text, text, jsonb) from public;
revoke all on function public.bibi_verify_conversation_binding(uuid, uuid, uuid, text, text, text, text, jsonb) from anon;
revoke all on function public.bibi_verify_conversation_binding(uuid, uuid, uuid, text, text, text, text, jsonb) from authenticated;
grant execute on function public.bibi_verify_conversation_binding(uuid, uuid, uuid, text, text, text, text, jsonb) to service_role;

create or replace function public.bibi_fail_conversation_binding(
  p_owner_id uuid,
  p_connector_node_id uuid,
  p_binding_id uuid,
  p_code text,
  p_detail text
)
returns table (binding_id uuid, binding_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.conversation_bindings%rowtype;
begin
  if coalesce(btrim(p_code), '') = '' then
    raise exception 'a verification failure needs a reason code' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.connector_nodes
     where id = p_connector_node_id and owner_id = p_owner_id
  ) then
    raise exception 'connector node not found for owner' using errcode = 'no_data_found';
  end if;

  select * into v_binding from public.conversation_bindings
   where id = p_binding_id and owner_id = p_owner_id
   for update;
  if v_binding.id is null then
    raise exception 'binding not found for owner' using errcode = 'no_data_found';
  end if;
  if v_binding.binding_state <> 'pending' then
    return query select v_binding.id, v_binding.binding_state;
    return;
  end if;

  update public.conversation_bindings
     set binding_state = 'blocked',
         verification_code = p_code,
         verification_error = left(coalesce(p_detail, ''), 500),
         verification_attempts = verification_attempts + 1,
         last_verification_at = now()
   where id = v_binding.id
  returning * into v_binding;

  update public.conversations
     set sync_status = 'blocked', sync_error = p_code, updated_at = now()
   where id = v_binding.conversation_id and owner_id = p_owner_id;

  insert into public.conversation_audit_events (
    owner_id, conversation_id, binding_id, event_id, event_type,
    organization_profile_id, execution_profile_id, hermes_session_id, payload
  ) values (
    p_owner_id, v_binding.conversation_id, v_binding.id,
    'verify_failed:' || v_binding.id::text || ':' || v_binding.verification_attempts::text,
    'verify_failed', v_binding.organization_profile_id, v_binding.execution_profile_id,
    v_binding.hermes_session_id,
    jsonb_build_object('code', p_code, 'connectorNodeId', p_connector_node_id)
  ) on conflict (owner_id, event_id) do nothing;

  return query select v_binding.id, v_binding.binding_state;
end;
$$;

revoke all on function public.bibi_fail_conversation_binding(uuid, uuid, uuid, text, text) from public;
revoke all on function public.bibi_fail_conversation_binding(uuid, uuid, uuid, text, text) from anon;
revoke all on function public.bibi_fail_conversation_binding(uuid, uuid, uuid, text, text) from authenticated;
grant execute on function public.bibi_fail_conversation_binding(uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Connector-reported eligible Telegram sessions
-- ---------------------------------------------------------------------------

-- Identity and reachability only. There is deliberately no title, body, excerpt
-- or preview column here: onboarding needs to know that a session exists and
-- how it is addressed, and reading what was said in it would put private
-- Telegram content in the cloud for the sake of a picker.
create table if not exists public.bibi_telegram_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid references public.connector_nodes (id) on delete set null,
  organization_profile_id text not null references public.bibi_profiles (id) on delete restrict,
  execution_profile_id text not null
    check (execution_profile_id = 'default' or execution_profile_id ~ '^bibi-(0[2-9]|1[0-8])$'),
  hermes_session_id text not null check (length(hermes_session_id) between 1 and 200),
  channel text not null default 'telegram' check (channel = 'telegram'),
  channel_account_id text,
  external_conversation_id text,
  identity_complete boolean not null default false,
  session_state text not null default 'active'
    check (session_state in ('active', 'archived', 'expired')),
  message_count integer not null default 0 check (message_count >= 0),
  last_activity_at timestamptz,
  collected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, execution_profile_id, hermes_session_id),
  check (not (organization_profile_id = 'bibi-01' and execution_profile_id <> 'default')),
  check (not (organization_profile_id <> 'bibi-01' and execution_profile_id <> organization_profile_id)),
  check (identity_complete = (channel_account_id is not null and external_conversation_id is not null))
);
create index if not exists bibi_telegram_sessions_owner_idx
  on public.bibi_telegram_sessions (owner_id, execution_profile_id, last_activity_at desc);

-- One row per profile saying when discovery last ran and whether it worked. A
-- profile with no sessions and no scan row is "never looked", which the UI has
-- to be able to tell apart from "looked and found none".
create table if not exists public.bibi_telegram_session_scans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid references public.connector_nodes (id) on delete set null,
  organization_profile_id text not null references public.bibi_profiles (id) on delete restrict,
  execution_profile_id text not null
    check (execution_profile_id = 'default' or execution_profile_id ~ '^bibi-(0[2-9]|1[0-8])$'),
  session_count integer not null default 0 check (session_count >= 0),
  eligible_count integer not null default 0 check (eligible_count >= 0),
  scan_error text,
  scanned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, execution_profile_id),
  check (not (organization_profile_id = 'bibi-01' and execution_profile_id <> 'default')),
  check (not (organization_profile_id <> 'bibi-01' and execution_profile_id <> organization_profile_id))
);
create index if not exists bibi_telegram_session_scans_owner_idx
  on public.bibi_telegram_session_scans (owner_id, execution_profile_id);

alter table public.bibi_telegram_sessions enable row level security;
alter table public.bibi_telegram_sessions force row level security;
alter table public.bibi_telegram_session_scans enable row level security;
alter table public.bibi_telegram_session_scans force row level security;

drop policy if exists "bibi_telegram_sessions_select_own" on public.bibi_telegram_sessions;
create policy "bibi_telegram_sessions_select_own" on public.bibi_telegram_sessions
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "bibi_telegram_session_scans_select_own" on public.bibi_telegram_session_scans;
create policy "bibi_telegram_session_scans_select_own" on public.bibi_telegram_session_scans
  for select to authenticated using (owner_id = (select auth.uid()));

create or replace function public.bibi_record_telegram_session_scan(
  p_owner_id uuid,
  p_connector_node_id uuid,
  p_organization_profile_id text,
  p_execution_profile_id text,
  p_sessions jsonb,
  p_scan_error text,
  p_scanned_at timestamptz
)
returns table (session_count integer, eligible_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_count integer;
  v_eligible_count integer;
begin
  if not exists (
    select 1 from public.connector_nodes
     where id = p_connector_node_id and owner_id = p_owner_id
  ) then
    raise exception 'connector node not found for owner' using errcode = 'no_data_found';
  end if;

  with source as (
    select * from jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb)) as s(
      "hermesSessionId" text,
      "channelAccountId" text,
      "externalConversationId" text,
      "sessionState" text,
      "messageCount" integer,
      "lastActivityAt" timestamptz
    )
  ), upserted as (
    insert into public.bibi_telegram_sessions (
      owner_id, node_id, organization_profile_id, execution_profile_id,
      hermes_session_id, channel, channel_account_id, external_conversation_id,
      identity_complete, session_state, message_count, last_activity_at,
      collected_at, updated_at
    )
    select p_owner_id, p_connector_node_id, p_organization_profile_id, p_execution_profile_id,
           s."hermesSessionId", 'telegram', s."channelAccountId", s."externalConversationId",
           s."channelAccountId" is not null and s."externalConversationId" is not null,
           coalesce(s."sessionState", 'active'), coalesce(s."messageCount", 0), s."lastActivityAt",
           coalesce(p_scanned_at, now()), now()
      from source s
     where coalesce(btrim(s."hermesSessionId"), '') <> ''
    on conflict (owner_id, execution_profile_id, hermes_session_id) do update
      set node_id = excluded.node_id,
          organization_profile_id = excluded.organization_profile_id,
          channel_account_id = excluded.channel_account_id,
          external_conversation_id = excluded.external_conversation_id,
          identity_complete = excluded.identity_complete,
          session_state = excluded.session_state,
          message_count = excluded.message_count,
          last_activity_at = excluded.last_activity_at,
          collected_at = excluded.collected_at,
          updated_at = now()
    returning hermes_session_id, identity_complete
  )
  select count(*)::integer, count(*) filter (where identity_complete)::integer
    into v_session_count, v_eligible_count
    from upserted;

  -- A session that has disappeared from the Mac must disappear from the picker.
  delete from public.bibi_telegram_sessions t
   where t.owner_id = p_owner_id
     and t.execution_profile_id = p_execution_profile_id
     and t.hermes_session_id not in (
       select coalesce(btrim(item->>'hermesSessionId'), '')
         from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) item
     );

  insert into public.bibi_telegram_session_scans (
    owner_id, node_id, organization_profile_id, execution_profile_id,
    session_count, eligible_count, scan_error, scanned_at, updated_at
  ) values (
    p_owner_id, p_connector_node_id, p_organization_profile_id, p_execution_profile_id,
    coalesce(v_session_count, 0), coalesce(v_eligible_count, 0),
    left(nullif(btrim(coalesce(p_scan_error, '')), ''), 500),
    coalesce(p_scanned_at, now()), now()
  )
  on conflict (owner_id, execution_profile_id) do update
    set node_id = excluded.node_id,
        organization_profile_id = excluded.organization_profile_id,
        session_count = excluded.session_count,
        eligible_count = excluded.eligible_count,
        scan_error = excluded.scan_error,
        scanned_at = excluded.scanned_at,
        updated_at = now();

  return query select coalesce(v_session_count, 0), coalesce(v_eligible_count, 0);
end;
$$;

revoke all on function public.bibi_record_telegram_session_scan(uuid, uuid, text, text, jsonb, text, timestamptz) from public;
revoke all on function public.bibi_record_telegram_session_scan(uuid, uuid, text, text, jsonb, text, timestamptz) from anon;
revoke all on function public.bibi_record_telegram_session_scan(uuid, uuid, text, text, jsonb, text, timestamptz) from authenticated;
grant execute on function public.bibi_record_telegram_session_scan(uuid, uuid, text, text, jsonb, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------

-- Realtime respects row level security, so publishing these does not widen
-- access: every one of them is select-own for `authenticated` and nothing else.
-- Without them the canonical timeline only moves when the browser refetches by
-- hand, which is exactly the gap this phase closes.
do $$
declare
  t text;
begin
  foreach t in array array[
    'conversations', 'conversation_bindings', 'projected_messages',
    'projection_checkpoints', 'bibi_telegram_sessions', 'bibi_telegram_session_scans'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- Updates and deletes carry only the primary key unless the table replicates
-- the whole row, and every one of these is reconciled on its full row.
alter table public.conversations replica identity full;
alter table public.conversation_bindings replica identity full;
alter table public.projected_messages replica identity full;
alter table public.projection_checkpoints replica identity full;
alter table public.bibi_telegram_sessions replica identity full;
alter table public.bibi_telegram_session_scans replica identity full;
