-- Outbound-only projection of local Hermes tool inventory and runtime health.

create table public.bibi_plugin_inventory (
  owner_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid not null references public.connector_nodes (id) on delete cascade,
  profile_id text not null references public.bibi_profiles (id) on delete restrict,
  catalog jsonb not null default '[]'::jsonb check (jsonb_typeof(catalog) = 'array'),
  servers jsonb not null default '[]'::jsonb check (jsonb_typeof(servers) = 'array'),
  toolsets jsonb not null default '[]'::jsonb check (jsonb_typeof(toolsets) = 'array'),
  collection_errors jsonb not null default '[]'::jsonb check (jsonb_typeof(collection_errors) = 'array'),
  collected_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, profile_id)
);
create index bibi_plugin_inventory_node_idx on public.bibi_plugin_inventory (node_id, collected_at desc);

create table public.bibi_runtime_health (
  owner_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid not null references public.connector_nodes (id) on delete cascade,
  profile_id text not null references public.bibi_profiles (id) on delete restrict,
  hermes_version text,
  model text,
  provider text,
  gateway_status text not null default 'unknown' check (gateway_status in ('running', 'stopped', 'unknown', 'error')),
  active_sessions integer check (active_sessions is null or active_sessions >= 0),
  enabled_toolsets integer not null default 0 check (enabled_toolsets >= 0),
  disabled_toolsets integer not null default 0 check (disabled_toolsets >= 0),
  health_error text,
  collected_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, profile_id)
);
create index bibi_runtime_health_node_idx on public.bibi_runtime_health (node_id, collected_at desc);

alter table public.bibi_plugin_inventory enable row level security;
alter table public.bibi_plugin_inventory force row level security;
alter table public.bibi_runtime_health enable row level security;
alter table public.bibi_runtime_health force row level security;

create policy "bibi_plugin_inventory_select_owner" on public.bibi_plugin_inventory
  for select to authenticated using (owner_id = auth.uid());
create policy "bibi_runtime_health_select_owner" on public.bibi_runtime_health
  for select to authenticated using (owner_id = auth.uid());

alter publication supabase_realtime add table public.bibi_plugin_inventory;
alter publication supabase_realtime add table public.bibi_runtime_health;
