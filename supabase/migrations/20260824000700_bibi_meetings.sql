-- Durable Bibi meeting rooms and profile-targeted meeting work.

create table if not exists public.bibi_meetings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  topic text not null check (length(btrim(topic)) > 0),
  status text not null default 'running' check (status in ('running', 'complete', 'cancelled')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists bibi_meetings_owner_created_idx
  on public.bibi_meetings (owner_id, created_at desc);

create table if not exists public.bibi_meeting_participants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  meeting_id uuid not null references public.bibi_meetings (id) on delete cascade,
  profile_id text not null references public.bibi_profiles (id) on delete restrict,
  work_item_id uuid unique,
  created_at timestamptz not null default now(),
  unique (meeting_id, profile_id)
);

alter table public.work_items
  drop constraint if exists work_items_kind_check;
alter table public.work_items
  add constraint work_items_kind_check check (kind in ('work', 'chat', 'meeting'));
alter table public.work_items
  add column if not exists meeting_id uuid references public.bibi_meetings (id) on delete cascade;

alter table public.bibi_meeting_participants
  drop constraint if exists bibi_meeting_participants_work_item_id_fkey;
alter table public.bibi_meeting_participants
  add constraint bibi_meeting_participants_work_item_id_fkey
  foreign key (work_item_id) references public.work_items (id) on delete set null;

alter table public.work_items
  drop constraint if exists work_items_meeting_requires_meeting;
alter table public.work_items
  add constraint work_items_meeting_requires_meeting
  check (kind <> 'meeting' or meeting_id is not null);

create index if not exists work_items_meeting_idx
  on public.work_items (meeting_id, created_at) where meeting_id is not null;

alter table public.bibi_meetings enable row level security;
alter table public.bibi_meetings force row level security;
alter table public.bibi_meeting_participants enable row level security;
alter table public.bibi_meeting_participants force row level security;

create policy "bibi_meetings_select_own" on public.bibi_meetings
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "bibi_meetings_insert_own" on public.bibi_meetings
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "bibi_meeting_participants_select_own" on public.bibi_meeting_participants
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "bibi_meeting_participants_insert_own" on public.bibi_meeting_participants
  for insert to authenticated with check (owner_id = (select auth.uid()));

-- Extend the existing intake guard without weakening chat dispatch. Ordinary
-- browser intake is still forced to `work`; `meeting` survives only when it
-- references a meeting owned by the authenticated caller. Chat remains
-- service-role-only and can never be forged by this path.
create or replace function public.bibi_work_items_client_insert_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_valid_meeting boolean := false;
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;

  if new.kind = 'meeting' and new.meeting_id is not null then
    select exists (
      select 1 from public.bibi_meetings m
      where m.id = new.meeting_id and m.owner_id = v_owner
    ) into v_valid_meeting;
  end if;

  new.owner_id := v_owner;
  new.status := case when new.profile_id is null then 'intake' else 'assigned' end;
  new.attempt := 0;
  new.lease_id := null;
  new.node_id := null;
  new.lease_expires_at := null;
  new.result_id := null;
  new.error := null;
  new.blocked_reason := null;
  new.kind := case when v_valid_meeting then 'meeting' else 'work' end;
  new.meeting_id := case when v_valid_meeting then new.meeting_id else null end;
  new.conversation_id := null;
  new.request_message_id := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.bibi_start_meeting(p_topic text, p_profile_ids text[])
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_meeting uuid;
  v_profile text;
  v_work uuid;
begin
  if v_owner is null then raise exception 'AUTH_REQUIRED'; end if;
  if length(btrim(coalesce(p_topic, ''))) = 0 then raise exception 'MEETING_TOPIC_REQUIRED'; end if;
  if coalesce(array_length(p_profile_ids, 1), 0) = 0 then raise exception 'MEETING_PARTICIPANTS_REQUIRED'; end if;
  if exists (
    select 1 from unnest(p_profile_ids) profile_id
    where not exists (select 1 from public.bibi_profiles b where b.id = profile_id)
  ) then raise exception 'INVALID_BIBI_PROFILE'; end if;

  insert into public.bibi_meetings (owner_id, topic)
  values (v_owner, btrim(p_topic)) returning id into v_meeting;

  for v_profile in select distinct unnest(p_profile_ids) loop
    insert into public.work_items (
      owner_id, profile_id, client_request_id, title, brief, kind, meeting_id
    ) values (
      v_owner,
      v_profile,
      'meeting:' || v_meeting::text || ':' || v_profile,
      '[회의] ' || btrim(p_topic),
      '회의 주제: ' || btrim(p_topic) || E'\n\n담당 역할의 관점에서 핵심 판단, 근거, 제안 액션을 명확히 답하세요.',
      'meeting',
      v_meeting
    ) returning id into v_work;

    insert into public.bibi_meeting_participants (owner_id, meeting_id, profile_id, work_item_id)
    values (v_owner, v_meeting, v_profile, v_work);
  end loop;

  return v_meeting;
end;
$$;

grant execute on function public.bibi_start_meeting(text, text[]) to authenticated;

-- Realtime is owner-filtered by RLS. Add each table once.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bibi_meetings'
  ) then alter publication supabase_realtime add table public.bibi_meetings; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bibi_meeting_participants'
  ) then alter publication supabase_realtime add table public.bibi_meeting_participants; end if;
end $$;
