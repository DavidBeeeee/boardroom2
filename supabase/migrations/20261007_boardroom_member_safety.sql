-- WO-20261007-evening (WBR-373): AI Boardroom member safety.
--
-- 1. boardroom_logs gains a "safety" event type, written when a member's
--    message trips the crisis check and the advisor rounds are skipped.
-- 2. boardroom_workspace_owner_is_admin(workspace) answers, server side, whether
--    a workspace belongs to one of David's admin accounts. The engine uses it to
--    keep David's own advisor personas exactly as he wrote them and to give
--    every other workspace the clean versions. It is security definer because a
--    member cannot read auth.users, and it returns false unless the caller is a
--    member of that workspace, so it reveals nothing about anyone else's room.

alter table public.boardroom_logs drop constraint if exists boardroom_logs_event_type_check;
alter table public.boardroom_logs add constraint boardroom_logs_event_type_check
  check (event_type = any (array['turn'::text, 'deepseek_call'::text, 'state_write'::text, 'safety'::text]));

create or replace function public.boardroom_workspace_owner_is_admin(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select public.boardroom_is_workspace_member(target_workspace)
    and exists (
      select 1
      from public.boardroom_workspaces w
      join auth.users u on u.id = w.owner_user_id
      where w.id = target_workspace
        and lower(u.email) = any (array[
          'contact@davidbee.me',
          'davidkamau.t@gmail.com',
          'davidkamau@live.com',
          'email@davidbee.me'
        ])
    );
$$;

revoke all on function public.boardroom_workspace_owner_is_admin(uuid) from public;
grant execute on function public.boardroom_workspace_owner_is_admin(uuid) to authenticated;
