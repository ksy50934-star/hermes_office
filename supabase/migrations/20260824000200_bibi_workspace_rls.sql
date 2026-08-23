-- Bibi Workspace row level security.
--
-- The authorisation model in one sentence: a browser session may read its own
-- rows, may start a conversation and may file work, and may do nothing else.
-- Everything that decides state — lifecycle transitions, leases, evidence,
-- connector registration — is written by the API with the service role after it
-- has validated the transition.
--
-- FORCE is applied alongside ENABLE on every table. Without FORCE, the role
-- that owns the table bypasses its own policies, which silently defeats RLS for
-- anything running as that role.

-- ---------------------------------------------------------------------------
-- Enable and force
-- ---------------------------------------------------------------------------

alter table public.bibi_profiles enable row level security;
alter table public.bibi_profiles force row level security;

alter table public.connector_nodes enable row level security;
alter table public.connector_nodes force row level security;

alter table public.connector_credentials enable row level security;
alter table public.connector_credentials force row level security;

alter table public.conversations enable row level security;
alter table public.conversations force row level security;

alter table public.messages enable row level security;
alter table public.messages force row level security;

alter table public.work_items enable row level security;
alter table public.work_items force row level security;

alter table public.work_events enable row level security;
alter table public.work_events force row level security;

alter table public.work_results enable row level security;
alter table public.work_results force row level security;

alter table public.work_evidence enable row level security;
alter table public.work_evidence force row level security;

alter table public.command_leases enable row level security;
alter table public.command_leases force row level security;

-- ---------------------------------------------------------------------------
-- Roster: readable by any signed-in user, writable by nobody
-- ---------------------------------------------------------------------------

-- The roster is a product constant. Signed-in users read it; there is no
-- insert, update or delete policy, so the eighteen rows cannot be edited from
-- a client session even by their owner.
create policy "bibi_profiles_select_authenticated" on public.bibi_profiles
  for select to authenticated
  using (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- Connector: read-only to its owner
-- ---------------------------------------------------------------------------

-- Registration and heartbeats arrive over the connector API, which
-- authenticates a hashed bearer token. The browser only observes.
create policy "connector_nodes_select_own" on public.connector_nodes
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- public.connector_credentials intentionally has no policy. With RLS enabled
-- and forced and no policy present, every client role is denied; only the
-- service role, which bypasses RLS, can read or write a token hash.

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

create policy "conversations_select_own" on public.conversations
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "conversations_insert_own" on public.conversations
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "conversations_update_own" on public.conversations
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "conversations_delete_own" on public.conversations
  for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy "messages_select_own" on public.messages
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- messages has no insert policy at all. A chat turn is not just a stored row:
-- it must atomically become a command for a Bibi to answer. That happens in
-- bibi_send_chat_message, which the API calls as the service role. A direct
-- client insert would produce a message nothing would ever answer, and would
-- also let a browser fabricate an assistant reply.

-- ---------------------------------------------------------------------------
-- Work
-- ---------------------------------------------------------------------------

create policy "work_items_select_own" on public.work_items
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- Intake is the one write a browser makes. The guard trigger below normalises
-- the row so this insert cannot smuggle in a status, a lease or an attempt
-- count. There is deliberately no update or delete policy: cancelling and
-- every other transition goes through the API so the lifecycle stays
-- authoritative in one place.
create policy "work_items_insert_own" on public.work_items
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "work_events_select_own" on public.work_events
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "work_results_select_own" on public.work_results
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "work_evidence_select_own" on public.work_evidence
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "command_leases_select_own" on public.command_leases
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Intake guard
-- ---------------------------------------------------------------------------

-- Because the client holds an insert policy on work_items, it could otherwise
-- insert a row that already claims to be running, leased or succeeded. This
-- trigger rewrites every execution-controlled column on a client insert. The
-- service role is passed through untouched so the API can seed state after it
-- has validated a transition.
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
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bibi_work_items_client_insert_guard on public.work_items;

create trigger bibi_work_items_client_insert_guard
  before insert on public.work_items
  for each row
  execute function public.bibi_work_items_client_insert_guard();
