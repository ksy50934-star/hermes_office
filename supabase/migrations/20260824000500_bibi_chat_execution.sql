-- Executable chat.
--
-- A chat turn is not a stored row that something else might later notice. It is
-- a command: the user's message and the work item that will run it are created
-- in one atomic call, so a turn can never exist without a command to answer it,
-- and a command can never exist without the turn that asked for it.
--
-- Chat commands reuse the work lifecycle, the leases and the idempotency the
-- work board already has. They are tagged `kind = 'chat'` so the board can show
-- deliberate work without being flooded by every sentence the user types.

-- ---------------------------------------------------------------------------
-- Chat dispatch columns
-- ---------------------------------------------------------------------------

alter table public.work_items
  add column if not exists kind text not null default 'work'
    check (kind in ('work', 'chat')),
  add column if not exists conversation_id uuid references public.conversations (id) on delete cascade,
  add column if not exists request_message_id uuid references public.messages (id) on delete set null;

-- A chat command with no conversation would have nowhere to put its reply.
alter table public.work_items
  drop constraint if exists work_items_chat_requires_conversation;
alter table public.work_items
  add constraint work_items_chat_requires_conversation
  check (kind <> 'chat' or conversation_id is not null);

-- The board reads `kind = 'work'`; the chat panel reads one conversation.
create index if not exists work_items_board_idx
  on public.work_items (owner_id, kind, created_at desc);
create index if not exists work_items_conversation_idx
  on public.work_items (conversation_id, created_at)
  where conversation_id is not null;

-- ---------------------------------------------------------------------------
-- Client insert guard
-- ---------------------------------------------------------------------------

-- Extends the guard from the RLS migration. A browser holds an insert policy on
-- work_items for ordinary intake; without this it could insert a row claiming to
-- be a chat command bound to any conversation.
create or replace function public.bibi_work_items_client_insert_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  new.owner_id := (select auth.uid());
  new.status := case when new.profile_id is null then 'intake' else 'assigned' end;
  new.attempt := 0;
  new.lease_id := null;
  new.node_id := null;
  new.lease_expires_at := null;
  new.result_id := null;
  new.error := null;
  new.blocked_reason := null;
  -- Chat commands are only ever created by bibi_send_chat_message, which runs
  -- as the service role and is exempt above.
  new.kind := 'work';
  new.conversation_id := null;
  new.request_message_id := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic send
-- ---------------------------------------------------------------------------

-- Returns the existing turn and command unchanged when the same
-- client_message_id arrives twice, so a resend after a dropped response is a
-- no-op rather than a duplicate question.
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
  v_profile_id text;
  v_message_id uuid;
  v_work_item_id uuid;
  v_client_request_id text := 'chat:' || p_client_message_id;
begin
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'chat message body is empty' using errcode = 'check_violation';
  end if;

  -- Scoped by owner: another account's conversation simply does not resolve.
  select c.profile_id into v_profile_id
    from public.conversations c
   where c.id = p_conversation_id
     and c.owner_id = p_owner_id;

  if v_profile_id is null then
    raise exception 'conversation not found for owner' using errcode = 'no_data_found';
  end if;

  insert into public.messages (owner_id, conversation_id, profile_id, role, body, client_message_id)
  values (p_owner_id, p_conversation_id, v_profile_id, 'user', p_body, p_client_message_id)
  on conflict (conversation_id, client_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select m.id into v_message_id
      from public.messages m
     where m.conversation_id = p_conversation_id
       and m.client_message_id = p_client_message_id;

    select w.id into v_work_item_id
      from public.work_items w
     where w.owner_id = p_owner_id
       and w.client_request_id = v_client_request_id;

    return query select v_message_id, v_work_item_id, true;
    return;
  end if;

  -- Assigned, not intake: a chat turn already knows who must answer it.
  insert into public.work_items (
    owner_id, profile_id, client_request_id, title, brief,
    kind, status, conversation_id, request_message_id
  )
  values (
    p_owner_id, v_profile_id, v_client_request_id,
    left(btrim(p_body), 80), p_body,
    'chat', 'assigned', p_conversation_id, v_message_id
  )
  returning id into v_work_item_id;

  update public.conversations
     set last_message_at = now(), updated_at = now()
   where id = p_conversation_id;

  return query select v_message_id, v_work_item_id, false;
end;
$$;

revoke all on function public.bibi_send_chat_message(uuid, uuid, text, text) from public;
revoke all on function public.bibi_send_chat_message(uuid, uuid, text, text) from anon;
revoke all on function public.bibi_send_chat_message(uuid, uuid, text, text) from authenticated;
grant execute on function public.bibi_send_chat_message(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Assistant write-back
-- ---------------------------------------------------------------------------

-- The reply's client_message_id is derived from the work item, so a redelivered
-- success report conflicts instead of posting a second answer.
create or replace function public.bibi_record_assistant_message(
  p_owner_id uuid,
  p_work_item_id uuid,
  p_body text
)
returns table (message_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_profile_id text;
  v_message_id uuid;
  v_client_message_id text := 'assistant:' || p_work_item_id::text;
begin
  select w.conversation_id, w.profile_id into v_conversation_id, v_profile_id
    from public.work_items w
   where w.id = p_work_item_id
     and w.owner_id = p_owner_id
     and w.kind = 'chat';

  if v_conversation_id is null then
    raise exception 'chat work item not found for owner' using errcode = 'no_data_found';
  end if;

  insert into public.messages (owner_id, conversation_id, profile_id, role, body, client_message_id)
  values (p_owner_id, v_conversation_id, v_profile_id, 'assistant', p_body, v_client_message_id)
  on conflict (conversation_id, client_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select m.id into v_message_id
      from public.messages m
     where m.conversation_id = v_conversation_id
       and m.client_message_id = v_client_message_id;
    return query select v_message_id, true;
    return;
  end if;

  update public.conversations
     set last_message_at = now(), updated_at = now()
   where id = v_conversation_id;

  return query select v_message_id, false;
end;
$$;

revoke all on function public.bibi_record_assistant_message(uuid, uuid, text) from public;
revoke all on function public.bibi_record_assistant_message(uuid, uuid, text) from anon;
revoke all on function public.bibi_record_assistant_message(uuid, uuid, text) from authenticated;
grant execute on function public.bibi_record_assistant_message(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Claim now carries the chat context
-- ---------------------------------------------------------------------------

-- The claim now returns `kind` and `conversation_id` as well, so the OUT row
-- type is not the one migration 004 created. PostgreSQL refuses to widen a
-- returns-table signature in place (42P13: cannot change return type of
-- existing function), so `create or replace` alone aborts the whole migration
-- on any database where 004 already applied. The old function has to be dropped
-- by its exact argument signature first.
--
-- Nothing else in the schema depends on it -- only the connector API calls it
-- over RPC -- so this is a plain drop, never `cascade`. The drop also discards
-- the privileges granted in 004, which is why the revoke/grant block below the
-- new definition is mandatory rather than a repetition: without it the
-- recreated function would fall back to the default `execute` grant to public
-- and hand a browser session a security-definer function that bypasses RLS.
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
  recorded as (
    insert into public.command_leases (owner_id, work_item_id, connector_node_id, attempt, expires_at)
    select p_owner_id, l.id, p_connector_node_id, l.attempt + 1, v_expires_at
      from leased l
    on conflict (work_item_id, attempt) do nothing
    returning work_item_id
  )
  select l.id, l.profile_id, l.kind, l.conversation_id, l.title, l.brief,
         l.attempt + 1, l.lease_id, l.lease_expires_at
    from leased l
   where exists (select 1 from recorded r where r.work_item_id = l.id);
end;
$$;

-- Reapplied after the drop above: the recreated function starts with no
-- privilege history of its own.
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from public;
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from anon;
revoke all on function public.bibi_claim_work(uuid, uuid, integer, integer) from authenticated;
grant execute on function public.bibi_claim_work(uuid, uuid, integer, integer) to service_role;
