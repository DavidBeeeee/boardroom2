-- WO-20261002-evening, Stream A: AI Boardroom idempotency + optimistic concurrency
-- (Developer 6, 9, 13, 15, 16, 18, 20, 33).
--
-- Applied to the shared Studio Supabase (project zdtkwpzdwnzzmdwrvmka, the live
-- "SeenInSeven" project) on 2026-10-03. The boardroom_* tables live in that
-- project, not in the paused standalone "Boardroom V2" project and not in the
-- legacy supabase/schema.sql.
--
-- This migration closes the biggest data-integrity gaps the morning score found:
--
--   1. Idempotency for member-initiated state-changing writes. Today a resent or
--      double-clicked request re-runs generation, bills DeepSeek again, and
--      re-inserts messages, cards and memory. A one-time key per action now makes
--      a repeat a no-op that replays the first response. (Developer 13,15,16,33)
--   2. Optimistic concurrency on advisor cards, the member-editable rows two
--      people can clobber. Each card carries a version that bumps on every
--      update; a write that names a stale version touches zero rows and the app
--      refuses it instead of silently overwriting. (Developer 9,18,20)
--   3. An impossible-state guard: the decision-reached success marker can only
--      exist on a saved assistant tony_close turn, never on any other row.
--      (Developer 6)

-- 1. Idempotency keys ---------------------------------------------------------

create table if not exists public.boardroom_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.boardroom_workspaces(id) on delete cascade,
  scope text not null,
  idempotency_key text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  response jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, scope, idempotency_key)
);

create index if not exists boardroom_idempotency_workspace_created_idx
  on public.boardroom_idempotency_keys (workspace_id, created_at desc);

alter table public.boardroom_idempotency_keys enable row level security;

-- Members may claim (insert), read, and finalize (update) their own workspace's
-- keys through their RLS-scoped client. A key is never deleted from the client;
-- the handler releases a failed claim via update to a fresh retry path only by
-- deleting its own in_progress row, which the delete policy below allows.
drop policy if exists "boardroom_members_read_idempotency" on public.boardroom_idempotency_keys;
create policy "boardroom_members_read_idempotency"
  on public.boardroom_idempotency_keys
  for select
  to authenticated
  using (public.boardroom_is_workspace_member(workspace_id));

drop policy if exists "boardroom_members_insert_idempotency" on public.boardroom_idempotency_keys;
create policy "boardroom_members_insert_idempotency"
  on public.boardroom_idempotency_keys
  for insert
  to authenticated
  with check (public.boardroom_is_workspace_member(workspace_id));

drop policy if exists "boardroom_members_update_idempotency" on public.boardroom_idempotency_keys;
create policy "boardroom_members_update_idempotency"
  on public.boardroom_idempotency_keys
  for update
  to authenticated
  using (public.boardroom_is_workspace_member(workspace_id));

-- A failed claim (work threw) is released so the same key can be retried. Only
-- the still-in_progress row can be removed; a completed replay row is permanent.
drop policy if exists "boardroom_members_delete_idempotency" on public.boardroom_idempotency_keys;
create policy "boardroom_members_delete_idempotency"
  on public.boardroom_idempotency_keys
  for delete
  to authenticated
  using (public.boardroom_is_workspace_member(workspace_id) and status = 'in_progress');

-- 2. Optimistic concurrency on advisor cards ----------------------------------

alter table public.boardroom_advisor_cards
  add column if not exists version integer not null default 1;

-- Every update bumps the version, so a client that read version N and writes
-- back expecting N will touch zero rows once anyone else has already written.
create or replace function public.boardroom_bump_version()
returns trigger language plpgsql as $$
begin
  new.version = old.version + 1;
  return new;
end;
$$;

drop trigger if exists boardroom_advisor_cards_bump_version on public.boardroom_advisor_cards;
create trigger boardroom_advisor_cards_bump_version
  before update on public.boardroom_advisor_cards
  for each row execute function public.boardroom_bump_version();

-- 3. Impossible-state guard: decision-reached only on assistant tony_close -----

alter table public.boardroom_messages
  drop constraint if exists boardroom_messages_decision_requires_close;
alter table public.boardroom_messages
  add constraint boardroom_messages_decision_requires_close
  check (
    coalesce(metadata->>'decision_reached', '') <> 'true'
    or (role = 'assistant' and stage = 'tony_close')
  );
