-- WO-20260927-evening, Stream A: AI Boardroom observability (Developer 71-80, 99, 73, 89).
--
-- Applied to the shared Studio Supabase (project zdtkwpzdwnzzmdwrvmka) on
-- 2026-09-28. Kept here as the source of record; the boardroom_* tables live in
-- that shared project rather than in supabase/schema.sql (the legacy standalone
-- schema).
--
-- boardroom_logs is an append-only diagnostic log. Every conversation turn,
-- every DeepSeek call outcome (success | generation_failure | parse_fallback),
-- and every state-changing write to a boardroom_* table records a row, so a
-- broken generation or a dropped write is diagnosable and an incident is
-- detectable before a member reports it. Token columns back the server-side
-- DeepSeek cost/usage bound; the model column records the served model version
-- with each generation.

create table if not exists public.boardroom_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.boardroom_workspaces(id) on delete cascade,
  conversation_id uuid references public.boardroom_conversations(id) on delete set null,
  event_type text not null check (event_type in ('turn','deepseek_call','state_write')),
  stage text not null default '',
  speaker text not null default '',
  status text not null default 'success',
  model text not null default '',
  latency_ms integer,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  detail jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists boardroom_logs_workspace_created_idx
  on public.boardroom_logs (workspace_id, created_at desc);
create index if not exists boardroom_logs_event_status_idx
  on public.boardroom_logs (event_type, status);
create index if not exists boardroom_logs_conversation_idx
  on public.boardroom_logs (conversation_id);

alter table public.boardroom_logs enable row level security;

-- Members of the workspace may read their own workspace's logs.
create policy "boardroom_members_read_logs"
  on public.boardroom_logs
  for select
  to authenticated
  using (public.boardroom_is_workspace_member(workspace_id));

-- Members may append log rows for their own workspace. Append-only: no update or
-- delete policy is defined, so logs cannot be rewritten from the client. The
-- service role bypasses RLS for server-side maintenance.
create policy "boardroom_members_insert_logs"
  on public.boardroom_logs
  for insert
  to authenticated
  with check (public.boardroom_is_workspace_member(workspace_id));
