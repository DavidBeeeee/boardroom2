create extension if not exists "pgcrypto";

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  owner_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  guardrails text not null default '',
  advisor_settings jsonb not null default '{}'::jsonb,
  fresh_start_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  name text not null,
  mime_type text not null default 'text/plain',
  storage_path text not null,
  extracted_text text not null default '',
  byte_size bigint not null default 0,
  status text not null default 'ready' check (status in ('processing', 'ready', 'failed')),
  error text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null default 'Boardroom',
  channel text not null default 'brainstorming',
  mode jsonb not null default '{"depth":"normal","lane":"business"}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  speaker text not null default 'System',
  content text not null,
  stage text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.advisor_cards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  source_message_id uuid references public.messages(id) on delete set null,
  type text not null default 'local_doc',
  work_type text not null default 'manual',
  title text not null,
  advisor text not null default 'Tony',
  priority integer not null default 3,
  status text not null default 'suggested' check (status in ('suggested', 'active', 'done', 'trash')),
  context text not null default '',
  desired_output text not null default '',
  label text not null default '',
  source_decision text not null default '',
  inputs jsonb not null default '{}'::jsonb,
  external_target text not null default '',
  artifact text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.memory_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null default 'summary',
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_workspaces_updated_at on public.workspaces;
create trigger touch_workspaces_updated_at before update on public.workspaces
for each row execute function public.touch_updated_at();

drop trigger if exists touch_workspace_settings_updated_at on public.workspace_settings;
create trigger touch_workspace_settings_updated_at before update on public.workspace_settings
for each row execute function public.touch_updated_at();

drop trigger if exists touch_conversations_updated_at on public.conversations;
create trigger touch_conversations_updated_at before update on public.conversations
for each row execute function public.touch_updated_at();

drop trigger if exists touch_advisor_cards_updated_at on public.advisor_cards;
create trigger touch_advisor_cards_updated_at before update on public.advisor_cards
for each row execute function public.touch_updated_at();

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace
    and wm.user_id = auth.uid()
  );
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.documents enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.advisor_cards enable row level security;
alter table public.memory_entries enable row level security;

drop policy if exists "members read workspaces" on public.workspaces;
create policy "members read workspaces" on public.workspaces
for select using (public.is_workspace_member(id));

drop policy if exists "members read memberships" on public.workspace_members;
create policy "members read memberships" on public.workspace_members
for select using (public.is_workspace_member(workspace_id));

drop policy if exists "members read settings" on public.workspace_settings;
create policy "members read settings" on public.workspace_settings
for select using (public.is_workspace_member(workspace_id));

drop policy if exists "admins update settings" on public.workspace_settings;
create policy "admins update settings" on public.workspace_settings
for update using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = workspace_settings.workspace_id
    and wm.user_id = auth.uid()
    and wm.role in ('owner', 'admin')
  )
);

drop policy if exists "members read documents" on public.documents;
create policy "members read documents" on public.documents
for select using (public.is_workspace_member(workspace_id));

drop policy if exists "members insert documents" on public.documents;
create policy "members insert documents" on public.documents
for insert with check (public.is_workspace_member(workspace_id) and uploaded_by = auth.uid());

drop policy if exists "members delete documents" on public.documents;
create policy "members delete documents" on public.documents
for delete using (public.is_workspace_member(workspace_id));

drop policy if exists "members read conversations" on public.conversations;
create policy "members read conversations" on public.conversations
for select using (public.is_workspace_member(workspace_id));

drop policy if exists "members insert conversations" on public.conversations;
create policy "members insert conversations" on public.conversations
for insert with check (public.is_workspace_member(workspace_id) and created_by = auth.uid());

drop policy if exists "members update conversations" on public.conversations;
create policy "members update conversations" on public.conversations
for update using (public.is_workspace_member(workspace_id));

drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
for select using (public.is_workspace_member(workspace_id));

drop policy if exists "members insert messages" on public.messages;
create policy "members insert messages" on public.messages
for insert with check (public.is_workspace_member(workspace_id));

drop policy if exists "members read cards" on public.advisor_cards;
create policy "members read cards" on public.advisor_cards
for select using (public.is_workspace_member(workspace_id));

drop policy if exists "members insert cards" on public.advisor_cards;
create policy "members insert cards" on public.advisor_cards
for insert with check (public.is_workspace_member(workspace_id));

drop policy if exists "members update cards" on public.advisor_cards;
create policy "members update cards" on public.advisor_cards
for update using (public.is_workspace_member(workspace_id));

drop policy if exists "members delete cards" on public.advisor_cards;
create policy "members delete cards" on public.advisor_cards
for delete using (public.is_workspace_member(workspace_id));

drop policy if exists "members read memory" on public.memory_entries;
create policy "members read memory" on public.memory_entries
for select using (public.is_workspace_member(workspace_id));

drop policy if exists "members insert memory" on public.memory_entries;
create policy "members insert memory" on public.memory_entries
for insert with check (public.is_workspace_member(workspace_id));

drop policy if exists "members delete memory" on public.memory_entries;
create policy "members delete memory" on public.memory_entries
for delete using (public.is_workspace_member(workspace_id));

-- Storage bucket policies. Create a private bucket named "workspace-documents" first.
drop policy if exists "members read workspace files" on storage.objects;
create policy "members read workspace files" on storage.objects
for select using (
  bucket_id = 'workspace-documents'
  and public.is_workspace_member((storage.foldername(name))[1]::uuid)
);

drop policy if exists "members upload workspace files" on storage.objects;
create policy "members upload workspace files" on storage.objects
for insert with check (
  bucket_id = 'workspace-documents'
  and public.is_workspace_member((storage.foldername(name))[1]::uuid)
);

drop policy if exists "members delete workspace files" on storage.objects;
create policy "members delete workspace files" on storage.objects
for delete using (
  bucket_id = 'workspace-documents'
  and public.is_workspace_member((storage.foldername(name))[1]::uuid)
);
