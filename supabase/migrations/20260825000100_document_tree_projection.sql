-- Owner-scoped projection of safe bibi-world directory metadata.
-- Folder names only: no file contents, hidden runtime state, or local absolute paths.

create table public.bibi_document_trees (
  owner_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid not null references public.connector_nodes (id) on delete cascade,
  profile_id text not null references public.bibi_profiles (id) on delete restrict,
  directories jsonb not null default '[]'::jsonb check (jsonb_typeof(directories) = 'array'),
  collection_error text,
  collected_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, profile_id)
);
create index bibi_document_trees_node_idx on public.bibi_document_trees (node_id, collected_at desc);

alter table public.bibi_document_trees enable row level security;
alter table public.bibi_document_trees force row level security;

create policy "bibi_document_trees_select_owner" on public.bibi_document_trees
  for select to authenticated using (owner_id = auth.uid());

alter publication supabase_realtime add table public.bibi_document_trees;
