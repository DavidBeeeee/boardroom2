# AI Boardroom MVP

Hosted MVP for the local AI Boardroom. It keeps the current advisors and product loop while moving auth, storage, documents, messages, cards, and memory into Supabase.

## Local setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Create a private Storage bucket named `workspace-documents`.
4. Copy `.env.example` to `.env.local` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - optional `DEEPSEEK_API_KEY`
   - optional `SUPABASE_SERVICE_ROLE_KEY` for import/admin scripts
5. Install dependencies and run:

```bash
npm install
npm run dev
```

## Manual onboarding

For v1, create clients manually:

1. User signs in once through Supabase Auth.
2. In Supabase, create a row in `workspaces`.
3. Add the user's `auth.users.id` to `workspace_members`.
4. The workspace appears in the dashboard.

You can also adapt `supabase/manual-onboarding-template.sql`.

## DeepSeek key strategy

The server uses `DEEPSEEK_API_KEY` when it exists. If not, the browser asks for a client DeepSeek key and sends it only with each request. Client keys are stored in `sessionStorage`, never in Supabase.

## Local import

After adding `SUPABASE_SERVICE_ROLE_KEY`, seed David's current local state:

```bash
npm run import:local -- --workspace-id <workspace-id>
```

The script imports local memory, actions/cards, session summaries, artifacts, and the master business document into the selected workspace.
