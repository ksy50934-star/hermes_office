-- Owner-scoped completion for durable Bibi meetings.
--
-- `bibi_start_meeting` wrote `status = 'running'` and nothing in the schema ever
-- wrote anything else. So a cloud meeting had no way to end: every meeting ever
-- opened stayed on the active list forever, the archive stayed empty, and the
-- console's close button had nothing to persist to.
--
-- Exactly two things end a meeting here:
--
--   * the owner ends it by hand, from their own meeting console;
--   * every participant's linked work item has reached a terminal state, and
--     there is at least one participant.
--
-- Both go through one function. The automatic condition is evaluated in the
-- database against the work rows themselves, so a client that merely claims the
-- work is finished cannot reach it. Manual completion stays available to the
-- owner regardless of where the work got to, because a meeting the owner has
-- walked away from is over whatever the queue thinks.
--
-- Nothing here writes to `work_items`. A meeting ending is a fact about the
-- meeting, never a reason to move somebody's terminal work back out of the
-- state their connector reported.

-- ---------------------------------------------------------------------------
-- Columns and constraints
-- ---------------------------------------------------------------------------

alter table public.bibi_meetings
  add column if not exists completion_mode text;

comment on column public.bibi_meetings.completion_mode is
  'How the meeting ended: manual (the owner closed it) or automatic (every participant work item was terminal). Null while running.';

alter table public.bibi_meetings
  drop constraint if exists bibi_meetings_completion_mode_check;
alter table public.bibi_meetings
  add constraint bibi_meetings_completion_mode_check
  check (completion_mode is null or completion_mode in ('manual', 'automatic'));

-- The archive reads `completed_at`, so a completed meeting without one would
-- render as a record with no time. Added NOT VALID: this migration must never
-- fail to apply because of a row written before the rule existed, and the
-- constraint still holds for every row written or updated from here on.
alter table public.bibi_meetings
  drop constraint if exists bibi_meetings_completed_at_present;
alter table public.bibi_meetings
  add constraint bibi_meetings_completed_at_present
  check (status <> 'complete' or completed_at is not null) not valid;

-- The active list and the archive are two queries over the same table split by
-- status, and both are already owner-filtered by RLS.
create index if not exists bibi_meetings_owner_status_idx
  on public.bibi_meetings (owner_id, status, completed_at desc);

-- ---------------------------------------------------------------------------
-- Write boundary
-- ---------------------------------------------------------------------------

-- Lifecycle-authoritative rows are not browser-writable. Completion is exposed
-- only through the narrowly scoped function below; no authenticated client can
-- turn running into complete/cancelled, revive cancelled work, or forge the
-- completion timestamp/mode with a direct table update.
drop policy if exists "bibi_meetings_update_own" on public.bibi_meetings;
revoke update on table public.bibi_meetings from authenticated;
drop trigger if exists bibi_meetings_client_update_guard on public.bibi_meetings;
drop function if exists public.bibi_meetings_client_update_guard();

-- Starting a meeting is a durable intake operation too. The original RPC had
-- no caller key, so a timeout followed by a retry created a second meeting and
-- a second participant work item for every profile.
alter table public.bibi_meetings
  add column if not exists client_request_id text;

create unique index if not exists bibi_meetings_owner_request_uidx
  on public.bibi_meetings (owner_id, client_request_id)
  where client_request_id is not null;

revoke execute on function public.bibi_start_meeting(text, text[]) from public;
revoke execute on function public.bibi_start_meeting(text, text[]) from authenticated;
drop function public.bibi_start_meeting(text, text[]);

create function public.bibi_start_meeting(
  p_topic text,
  p_profile_ids text[],
  p_client_request_id text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_request_id text := btrim(coalesce(p_client_request_id, ''));
  v_meeting uuid;
  v_profile text;
  v_work uuid;
begin
  if v_owner is null then raise exception 'AUTH_REQUIRED'; end if;
  if length(btrim(coalesce(p_topic, ''))) = 0 then raise exception 'MEETING_TOPIC_REQUIRED'; end if;
  if length(v_request_id) = 0 or length(v_request_id) > 200 then raise exception 'MEETING_REQUEST_ID_REQUIRED'; end if;
  if coalesce(array_length(p_profile_ids, 1), 0) = 0 then raise exception 'MEETING_PARTICIPANTS_REQUIRED'; end if;
  if exists (
    select 1 from unnest(p_profile_ids) profile_id
    where not exists (select 1 from public.bibi_profiles b where b.id = profile_id)
  ) then raise exception 'INVALID_BIBI_PROFILE'; end if;

  insert into public.bibi_meetings (owner_id, topic, client_request_id)
  values (v_owner, btrim(p_topic), v_request_id)
  on conflict (owner_id, client_request_id) where client_request_id is not null do nothing
  returning id into v_meeting;

  if v_meeting is null then
    select m.id into v_meeting
      from public.bibi_meetings m
     where m.owner_id = v_owner and m.client_request_id = v_request_id;
    if v_meeting is null then raise exception 'MEETING_IDEMPOTENCY_READBACK_FAILED'; end if;
    return v_meeting;
  end if;

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

revoke execute on function public.bibi_start_meeting(text, text[], text) from public;
grant execute on function public.bibi_start_meeting(text, text[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- Completion
-- ---------------------------------------------------------------------------

/**
 * Complete one meeting the caller owns.
 *
 * Idempotent: a meeting that is already complete is returned as it stands,
 * with its original `completed_at` and mode, and no second write happens. That
 * is what makes the close button safe to press twice, and safe for a realtime
 * handler to race against the button.
 *
 * Concurrency-safe: the row is locked with `for update` before its status is
 * read, so two callers arriving together serialize here instead of both
 * deciding the meeting was still running.
 *
 * `automatic` mode is not an error when the meeting is not eligible — the
 * caller is a UI reacting to a realtime event, and "not finished yet" is an
 * ordinary answer. It returns the meeting unchanged, still running, along with
 * the counts that say why.
 *
 * Out parameters are prefixed rather than named `id` / `status`, because an
 * unprefixed OUT column shadows the table column of the same name inside the
 * body and turns every later reference ambiguous.
 */
create or replace function public.bibi_complete_meeting(
  p_meeting_id uuid,
  p_mode text default 'manual'
)
returns table (
  meeting_id uuid,
  meeting_topic text,
  meeting_status text,
  meeting_created_at timestamptz,
  meeting_completed_at timestamptz,
  meeting_completion_mode text,
  participant_count integer,
  terminal_count integer,
  completed_now boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_mode text := lower(coalesce(nullif(btrim(p_mode), ''), 'manual'));
  v_meeting public.bibi_meetings%rowtype;
  v_participants integer := 0;
  v_terminal integer := 0;
begin
  if v_owner is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_meeting_id is null then raise exception 'MEETING_REQUIRED'; end if;
  if v_mode not in ('manual', 'automatic') then raise exception 'INVALID_COMPLETION_MODE'; end if;

  select * into v_meeting
    from public.bibi_meetings m
   where m.id = p_meeting_id and m.owner_id = v_owner
   for update;
  if v_meeting.id is null then raise exception 'MEETING_NOT_FOUND'; end if;

  -- A participant counts as terminal only when it actually links to a work item
  -- this owner can see and that work item is in a terminal state. A participant
  -- whose work item was detached counts as not terminal, which is the
  -- conservative reading: an unlinked participant is not evidence of finished
  -- work.
  select count(*)::integer,
         count(*) filter (
           where p.work_item_id is not null
             and w.id is not null
             and w.status in ('succeeded', 'failed', 'cancelled')
         )::integer
    into v_participants, v_terminal
    from public.bibi_meeting_participants p
    left join public.work_items w
      on w.id = p.work_item_id and w.owner_id = v_owner
   where p.meeting_id = v_meeting.id and p.owner_id = v_owner;

  -- Both archive states are terminal. A retry returns the durable row as-is;
  -- cancelled can never be revived or converted into a completed record.
  if v_meeting.status in ('complete', 'cancelled') then
    return query select v_meeting.id, v_meeting.topic, v_meeting.status, v_meeting.created_at,
                        v_meeting.completed_at, v_meeting.completion_mode,
                        v_participants, v_terminal, false;
    return;
  end if;

  if v_mode = 'automatic' and not (v_participants > 0 and v_terminal = v_participants) then
    return query select v_meeting.id, v_meeting.topic, v_meeting.status, v_meeting.created_at,
                        v_meeting.completed_at, v_meeting.completion_mode,
                        v_participants, v_terminal, false;
    return;
  end if;

  update public.bibi_meetings m
     set status = 'complete',
         completed_at = now(),
         completion_mode = v_mode
   where m.id = v_meeting.id
     and m.owner_id = v_owner
     and m.status = 'running'
  returning m.* into v_meeting;

  return query select v_meeting.id, v_meeting.topic, v_meeting.status, v_meeting.created_at,
                      v_meeting.completed_at, v_meeting.completion_mode,
                      v_participants, v_terminal, true;
end;
$$;

revoke execute on function public.bibi_complete_meeting(uuid, text) from public;
grant execute on function public.bibi_complete_meeting(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- Meetings that already finished but had no way to say so.
--
-- The predicate is *exactly* the automatic condition above — at least one
-- participant, and every participant linked to a terminal work item — so this
-- closes nothing the function would not have closed on its own. A meeting with
-- one participant still queued, or with a detached work item, is left running.
--
-- `completed_at` is the last real terminal moment recorded against the work,
-- floored at the meeting's own creation time. Stamping `now()` instead would
-- date a months-old meeting to the deploy that fixed it.
with participant_state as (
  select p.meeting_id,
         count(*) as participants,
         count(*) filter (
           where p.work_item_id is not null
             and w.id is not null
             and w.status in ('succeeded', 'failed', 'cancelled')
         ) as terminal,
         max(coalesce(w.updated_at, w.created_at)) as last_terminal_at
    from public.bibi_meeting_participants p
    left join public.work_items w
      on w.id = p.work_item_id and w.owner_id = p.owner_id
   group by p.meeting_id
)
update public.bibi_meetings m
   set status = 'complete',
       completed_at = greatest(s.last_terminal_at, m.created_at),
       completion_mode = 'automatic'
  from participant_state s
 where s.meeting_id = m.id
   and m.status = 'running'
   and s.participants > 0
   and s.terminal = s.participants
   and s.last_terminal_at is not null;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

-- `20260824000300` left work_results and work_evidence unpublished on the
-- reasoning that they are fetched on demand once a work item goes terminal.
-- That is no longer true: the meeting archive renders the result and evidence
-- rows themselves, and completion is decided from them, so a result landing
-- with no event meant an archive that stayed wrong until a manual refresh.
--
-- Publishing does not widen access. Realtime applies RLS, so a subscriber still
-- receives only the rows its own policies would have returned.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_results'
  ) then alter publication supabase_realtime add table public.work_results; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_evidence'
  ) then alter publication supabase_realtime add table public.work_evidence; end if;
end $$;

-- Realtime sends only the primary key on update unless the table replicates the
-- whole row. A completion arrives as an update, and the subscriber has to be
-- able to tell a completed meeting from a renamed one.
alter table public.bibi_meetings replica identity full;
alter table public.bibi_meeting_participants replica identity full;
