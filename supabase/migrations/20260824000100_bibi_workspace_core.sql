-- Bibi Workspace core schema.
--
-- Forward-only. This migration creates the durable spine of the workspace:
-- the eighteen organisational role slots and their physical profile mapping,
-- the local Mac connector registry, chat, and the work
-- intake/execution/evidence tables.
--
-- Two rules shape every table here:
--   1. Every user row carries owner_id so row level security has something to
--      scope on. RLS itself is installed in the next migration.
--   2. Nothing in this schema stores a local Mac artifact verbatim. Evidence
--      references a hash and a Storage object; it never holds a local path,
--      a credential or a raw profile state file.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Organisational roster and its mapping to physical profiles
-- ---------------------------------------------------------------------------

-- Two identifier spaces live in this table, and conflating them is the main
-- hazard in this schema:
--
--   id                  organisational role slot, exactly bibi-01 .. bibi-18.
--                       This is what a user assigns work to.
--   execution_profile   the physical Hermes profile that actually runs it.
--                       CEO비비 (bibi-01) runs on `default` (~/.hermes), not on
--                       a profile named bibi-01. A directory called bibi-01
--                       does exist on the Mac, but it is a rollback original
--                       and is deliberately not an execution target — which is
--                       why the check constraint below excludes it.
create table if not exists public.bibi_profiles (
  id text primary key check (id ~ '^bibi-(0[1-9]|1[0-8])$'),
  ordinal smallint not null unique check (ordinal between 1 and 18),
  execution_profile text not null unique
    check (execution_profile = 'default' or execution_profile ~ '^bibi-(0[2-9]|1[0-8])$'),
  display_name text not null,
  -- Every role is canonical, sourced from the read-only bibi-world profile
  -- declarations, so none of these may be null.
  role text not null,
  mandate text not null,
  reports_to text not null,
  role_source text not null default 'CONFIRMED' check (role_source in ('CONFIRMED', 'UNCONFIRMED')),
  is_primary_surface boolean not null default false,
  created_at timestamptz not null default now()
);

-- bibi-01 is the CEO surface, and there can only ever be one.
create unique index if not exists bibi_profiles_primary_surface_idx
  on public.bibi_profiles (is_primary_surface)
  where is_primary_surface;

insert into public.bibi_profiles (id, ordinal, execution_profile, display_name, role, mandate, reports_to, role_source, is_primary_surface)
values
  ('bibi-01',  1, 'default', 'CEO비비', 'CEO비비', '전사 총괄, 업무 배정·조정·종결, 사용자와 최상위 소통', 'user', 'CONFIRMED', true),
  ('bibi-02',  2, 'bibi-02', '개발자비비', '개발자비비', '개발 천재 비비의 개발·자동화·기술 구현 책임', 'bibi-01', 'CONFIRMED', false),
  ('bibi-03',  3, 'bibi-03', '업로더비비', '업로더비비', '블로그·SNS 편집·업로드·저장·발행 준비', 'bibi-01', 'CONFIRMED', false),
  ('bibi-04',  4, 'bibi-04', '유튜버비비', '유튜버비비', 'YouTube 제작 연계·업로드·공개 검증', 'bibi-01', 'CONFIRMED', false),
  ('bibi-05',  5, 'bibi-05', '업로더2비비', '업로더2비비', '분리된 계정·브랜드의 블로그·SNS 업로드', 'bibi-01', 'CONFIRMED', false),
  ('bibi-06',  6, 'bibi-06', '디자이너비비', '디자이너비비', '모든 디자인·이미지·시각 자산 제작', 'bibi-01', 'CONFIRMED', false),
  ('bibi-07',  7, 'bibi-07', '김비서비비', '김비서비비', '개인 비서·Mac 실무·일정·일상 실행 지원', 'bibi-01', 'CONFIRMED', false),
  ('bibi-08',  8, 'bibi-08', '마음비비', '마음비비', '심리·철학·회고·마인드 관리', 'bibi-01', 'CONFIRMED', false),
  ('bibi-09',  9, 'bibi-09', '마케터비비', '마케터비비', '마케팅 기획·실행 방향·독립 피드백', 'bibi-01', 'CONFIRMED', false),
  ('bibi-10', 10, 'bibi-10', '검수비비', '검수비비', '모든 주체의 독립 검수·승인·반려', 'bibi-01', 'CONFIRMED', false),
  ('bibi-11', 11, 'bibi-11', '크론비비', '크론비비', '모든 예약·크론 업무 관리', 'bibi-01', 'CONFIRMED', false),
  ('bibi-12', 12, 'bibi-12', '운영비비', '운영비비', 'Mac mini·Hermes·프로필·비비 조직 운영', 'bibi-01', 'CONFIRMED', false),
  ('bibi-13', 13, 'bibi-13', '학습비비', '학습비비', '사용자와 조직의 지식 학습·기억 큐레이션', 'bibi-01', 'CONFIRMED', false),
  ('bibi-14', 14, 'bibi-14', '리서치비비', '리서치비비', '모든 전문 리서치·출처 검증', 'bibi-01', 'CONFIRMED', false),
  ('bibi-15', 15, 'bibi-15', '서류비비', '서류비비', '회사·개인 서류 제작 전담', 'bibi-01', 'CONFIRMED', false),
  ('bibi-16', 16, 'bibi-16', '사업개발비비', '사업개발비비', '전략기획·사업개발·컨설팅', 'bibi-01', 'CONFIRMED', false),
  ('bibi-17', 17, 'bibi-17', '문제해결사비비', '문제해결사비비', '모든 반복 실패·정체·장애의 독립 복구', 'bibi-01', 'CONFIRMED', false),
  ('bibi-18', 18, 'bibi-18', '일상비비', '일상비비', '사용자의 일상·직관적 명령을 수행하고 CEO비비의 전사 우선순위와 조정에 따른다', 'bibi-01', 'CONFIRMED', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Local Mac connector
-- ---------------------------------------------------------------------------

create table if not exists public.connector_nodes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  label text not null,
  platform text not null default 'macos',
  -- The only supported topology. A VPS-resident connector is not a variant of
  -- this product; it is a different product.
  connector_mode text not null default 'outbound-local-mac'
    check (connector_mode = 'outbound-local-mac'),
  status text not null default 'unknown'
    check (status in ('online', 'stale', 'offline', 'unknown')),
  last_heartbeat_at timestamptz,
  -- *Physical* profiles this node actually observed ('default', 'bibi-02'..).
  -- An empty array means "nothing reported", which the UI renders as OFFLINE,
  -- not as a full roster.
  reported_profile_ids text[] not null default '{}',
  connector_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists connector_nodes_owner_id_idx on public.connector_nodes (owner_id);

-- Connector bearer tokens. Hashed at rest; the plaintext is displayed once at
-- issue time and never persisted. This table has no client policy at all, so a
-- browser session cannot read it even with a valid JWT.
create table if not exists public.connector_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  connector_node_id uuid not null references public.connector_nodes (id) on delete cascade,
  token_hash text not null unique,
  token_prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists connector_credentials_owner_id_idx on public.connector_credentials (owner_id);

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Independent profile identity: a conversation belongs to exactly one role
  -- slot and is never merged with another profile's history.
  profile_id text not null references public.bibi_profiles (id) on delete restrict,
  title text not null default '',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_owner_id_idx on public.conversations (owner_id);
create index if not exists conversations_owner_profile_idx on public.conversations (owner_id, profile_id, last_message_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  profile_id text not null references public.bibi_profiles (id) on delete restrict,
  role text not null check (role in ('user', 'assistant', 'system')),
  body text not null,
  -- Set by the browser so a resend after a dropped response cannot post twice.
  client_message_id text,
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id)
);

create index if not exists messages_owner_id_idx on public.messages (owner_id);
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Work intake and execution
-- ---------------------------------------------------------------------------

create table if not exists public.work_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  profile_id text references public.bibi_profiles (id) on delete restrict,
  -- Intake idempotency key. Enforced here rather than only in the client so a
  -- retried POST cannot create a second work item.
  client_request_id text not null,
  title text not null check (length(btrim(title)) > 0),
  brief text not null default '',
  status text not null default 'intake'
    check (status in ('intake', 'assigned', 'leased', 'running', 'blocked', 'succeeded', 'failed', 'cancelled')),
  attempt integer not null default 0 check (attempt >= 0),
  lease_id uuid,
  node_id uuid references public.connector_nodes (id) on delete set null,
  lease_expires_at timestamptz,
  result_id uuid,
  error text,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, client_request_id)
);

create index if not exists work_items_owner_id_idx on public.work_items (owner_id);
create index if not exists work_items_dispatch_idx on public.work_items (owner_id, status, created_at)
  where status in ('assigned', 'leased', 'running');

-- The append-only lifecycle log. event_id is the connector's or the API's own
-- idempotency key: replaying a delivery is a primary-key conflict, not a
-- second state transition.
create table if not exists public.work_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  work_item_id uuid not null references public.work_items (id) on delete cascade,
  event_id text not null,
  event_type text not null
    check (event_type in ('assign', 'lease', 'start', 'succeed', 'fail', 'release', 'block', 'unblock', 'cancel')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (work_item_id, event_id)
);

create index if not exists work_events_owner_id_idx on public.work_events (owner_id);
create index if not exists work_events_work_item_idx on public.work_events (work_item_id, created_at);

create table if not exists public.work_results (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  work_item_id uuid not null references public.work_items (id) on delete cascade,
  summary text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists work_results_owner_id_idx on public.work_results (owner_id);

-- Evidence is a reference, never a copy of local state. storage_path points at
-- a Supabase Storage object the connector uploaded deliberately; inline_excerpt
-- is a redacted snippet. Neither may carry a local filesystem path.
create table if not exists public.work_evidence (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  work_item_id uuid not null references public.work_items (id) on delete cascade,
  -- The physical profile that produced this artifact. Stored alongside the
  -- work item's role slot so evidence names both identities, never one.
  execution_profile_id text,
  kind text not null check (kind in ('command', 'artifact', 'log', 'screenshot', 'link')),
  label text not null,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  storage_path text,
  inline_excerpt text,
  created_at timestamptz not null default now()
);

create index if not exists work_evidence_owner_id_idx on public.work_evidence (owner_id);
create index if not exists work_evidence_work_item_idx on public.work_evidence (work_item_id, created_at);

-- A lease is the right to execute one attempt of one work item. It is granted
-- to exactly one connector node and expires on its own, so a Mac that sleeps
-- mid-task releases the work instead of stranding it.
create table if not exists public.command_leases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  work_item_id uuid not null references public.work_items (id) on delete cascade,
  connector_node_id uuid not null references public.connector_nodes (id) on delete cascade,
  attempt integer not null check (attempt > 0),
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  unique (work_item_id, attempt)
);

create index if not exists command_leases_owner_id_idx on public.command_leases (owner_id);

-- One live lease per work item. A partial unique index is what actually
-- prevents two connector nodes from running the same job concurrently.
create unique index if not exists command_leases_active_idx
  on public.command_leases (work_item_id)
  where released_at is null;
