-- Replace these values after the client has created a Supabase Auth account.
-- Get the user id from Supabase Dashboard -> Authentication -> Users.

with created_workspace as (
  insert into public.workspaces (name, slug, owner_user_id)
  values ('David Bee Boardroom', 'david-bee', '00000000-0000-0000-0000-000000000000')
  returning id
),
created_member as (
  insert into public.workspace_members (workspace_id, user_id, role)
  select id, '00000000-0000-0000-0000-000000000000', 'owner'
  from created_workspace
  returning workspace_id
)
insert into public.workspace_settings (workspace_id, guardrails, advisor_settings)
select workspace_id, '', '{}'::jsonb
from created_member;
