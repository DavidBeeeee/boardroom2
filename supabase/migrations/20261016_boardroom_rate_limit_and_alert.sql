-- WO-20261016-evening (WBR-373, Developer 80 and 97): AI Boardroom burst rate
-- limit, refused-request logging and the boardroom_alert check.
--
-- Applied to the shared Studio Supabase (project zdtkwpzdwnzzmdwrvmka) on
-- 2026-10-16. Additive and reversible: the rollback is at the bottom.
--
-- 1. boardroom_request_events counts each member's chat and stage requests so
--    the routes can refuse a burst (lib/boardroom/ratelimit.ts). Narrow,
--    append-only from the client, indexed on exactly what the limit reads.
-- 2. boardroom_logs gains a "limit" event type, written when a request is
--    refused by the rate limit or the DeepSeek budget cap, so cap hits are
--    countable instead of invisible.
-- 3. boardroom_alert(hours) tells an admin whether generations are failing,
--    JSON is falling back, or workspaces are hitting the budget cap, against
--    thresholds, before a member reports it. Security definer so it can read
--    every workspace's logs, gated on public.users.is_admin, empty search_path,
--    revoked from public and anon.

create table if not exists public.boardroom_request_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.boardroom_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('chat', 'chat_stage')),
  created_at timestamptz not null default now()
);

create index if not exists boardroom_request_events_member_idx
  on public.boardroom_request_events (workspace_id, user_id, scope, created_at desc);

alter table public.boardroom_request_events enable row level security;

drop policy if exists "boardroom_members_read_own_request_events" on public.boardroom_request_events;
create policy "boardroom_members_read_own_request_events"
  on public.boardroom_request_events for select to authenticated
  using (user_id = (select auth.uid()) and public.boardroom_is_workspace_member(workspace_id));

drop policy if exists "boardroom_members_insert_own_request_events" on public.boardroom_request_events;
create policy "boardroom_members_insert_own_request_events"
  on public.boardroom_request_events for insert to authenticated
  with check (user_id = (select auth.uid()) and public.boardroom_is_workspace_member(workspace_id));

-- A member may clear their own counted requests older than a day; the route
-- does this occasionally so the table stays small. Nothing newer can be erased.
drop policy if exists "boardroom_members_prune_own_request_events" on public.boardroom_request_events;
create policy "boardroom_members_prune_own_request_events"
  on public.boardroom_request_events for delete to authenticated
  using (user_id = (select auth.uid()) and created_at < now() - interval '1 day');

revoke all on public.boardroom_request_events from anon;

alter table public.boardroom_logs drop constraint if exists boardroom_logs_event_type_check;
alter table public.boardroom_logs add constraint boardroom_logs_event_type_check
  check (event_type = any (array['turn'::text, 'deepseek_call'::text, 'state_write'::text, 'safety'::text, 'unsupported_claim'::text, 'limit'::text]));

create or replace function public.boardroom_alert(p_hours integer default 24)
returns table (
  metric text,
  events bigint,
  total_calls bigint,
  rate numeric,
  threshold numeric,
  breached boolean,
  window_hours integer
)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_hours integer := least(greatest(coalesce(p_hours, 24), 1), 168);
  v_since timestamptz := now() - make_interval(hours => v_hours);
  v_calls bigint;
  v_failures bigint;
  v_fallbacks bigint;
  v_budget bigint;
  v_rate bigint;
  v_injection bigint;
  -- A rate only alerts once there is enough traffic to mean something.
  v_min_calls constant bigint := 20;
begin
  if not exists (
    select 1 from public.users u
    where u.auth_id = (select auth.uid()) and coalesce(u.is_admin, false)
  ) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select
    count(*) filter (where l.event_type = 'deepseek_call' and l.status in ('success', 'generation_failure')),
    count(*) filter (where l.event_type = 'deepseek_call' and l.status = 'generation_failure'),
    count(*) filter (where l.event_type = 'deepseek_call' and l.status = 'parse_fallback'),
    count(*) filter (where l.event_type = 'limit' and l.stage = 'budget_cap'),
    count(*) filter (where l.event_type = 'limit' and l.stage = 'rate_limit'),
    count(*) filter (where l.event_type = 'safety' and l.detail ->> 'category' = 'injection')
  into v_calls, v_failures, v_fallbacks, v_budget, v_rate, v_injection
  from public.boardroom_logs l
  where l.created_at >= v_since;

  return query values
    ('generation_failure_rate', v_failures, v_calls,
      case when v_calls > 0 then round(v_failures::numeric / v_calls, 4) else 0 end,
      0.05::numeric,
      v_calls >= v_min_calls and v_failures::numeric / nullif(v_calls, 0) > 0.05,
      v_hours),
    ('parse_fallback_rate', v_fallbacks, v_calls,
      case when v_calls > 0 then round(v_fallbacks::numeric / v_calls, 4) else 0 end,
      0.10::numeric,
      v_calls >= v_min_calls and v_fallbacks::numeric / nullif(v_calls, 0) > 0.10,
      v_hours),
    ('budget_cap_hits', v_budget, v_calls, null::numeric, 1::numeric, v_budget >= 1, v_hours),
    ('rate_limit_hits', v_rate, v_calls, null::numeric, 25::numeric, v_rate >= 25, v_hours),
    ('injection_attempts', v_injection, v_calls, null::numeric, 10::numeric, v_injection >= 10, v_hours);
end;
$$;

revoke all on function public.boardroom_alert(integer) from public;
revoke all on function public.boardroom_alert(integer) from anon;
grant execute on function public.boardroom_alert(integer) to authenticated;

-- Rollback:
--   drop function if exists public.boardroom_alert(integer);
--   alter table public.boardroom_logs drop constraint boardroom_logs_event_type_check;
--   alter table public.boardroom_logs add constraint boardroom_logs_event_type_check
--     check (event_type = any (array['turn','deepseek_call','state_write','safety','unsupported_claim']));
--   (first delete any rows with event_type = 'limit')
--   drop table if exists public.boardroom_request_events;
