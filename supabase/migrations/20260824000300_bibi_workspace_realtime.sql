-- Bibi Workspace realtime publication.
--
-- Realtime respects row level security, so publishing a table does not widen
-- access: a subscriber still only receives rows its policies would have
-- returned. Only the tables the workspace actually subscribes to are published,
-- because every published table costs replication bandwidth on every change.
--
-- Deliberately not published: connector_credentials (no client policy at all),
-- work_results and work_evidence (fetched on demand when a work item reaches a
-- terminal state, not streamed), and bibi_profiles (a constant).

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

-- Work lifecycle: the board updates as the connector reports progress.
alter publication supabase_realtime add table public.work_items;
alter publication supabase_realtime add table public.work_events;

-- Chat: assistant turns arrive from the connector, not from this browser.
alter publication supabase_realtime add table public.messages;

-- Connector health: drives the ONLINE / OFFLINE / QUEUED badges.
alter publication supabase_realtime add table public.connector_nodes;

-- Realtime sends only primary keys on update and delete unless the table has
-- REPLICA IDENTITY FULL. The workspace reconciles on the full row, so set it
-- for the tables whose updates matter.
alter table public.work_items replica identity full;
alter table public.connector_nodes replica identity full;
