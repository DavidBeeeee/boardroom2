# AI Boardroom

AI Boardroom is part of Colorado Mastermind Studio. It uses Studio's Supabase login and app entitlements while keeping Boardroom conversations, documents, cards, and memory private to each workspace.

## Local setup

1. Apply the Boardroom migrations from the Studio repository to the Studio Supabase project.
2. Confirm the private `boardroom-documents` Storage bucket exists.
3. Copy `.env.example` to `.env.local` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - optional `DEEPSEEK_API_KEY`
   - optional `SUPABASE_SERVICE_ROLE_KEY` for import/admin scripts
5. Install dependencies and run:

```bash
npm install
npm run dev
```

## Access

Studio controls access through the `app_entitlements` table. Grant the `boardroom` entitlement from `/admin` or `/admin/boardroom`.

When an entitled user opens Boardroom for the first time, `boardroom_ensure_workspace` creates their private workspace and membership automatically. Revoking the entitlement blocks Boardroom immediately without deleting their saved work.

The SQL files in this repository's `supabase` folder describe the original standalone setup and are retained only as historical reference. Do not apply them to Studio.

## DeepSeek key strategy

The server uses `DEEPSEEK_API_KEY` when it exists. If not, the browser asks for a client DeepSeek key and sends it only with each request. Client keys are stored in `sessionStorage`, never in Supabase.

## Local import

After adding `SUPABASE_SERVICE_ROLE_KEY`, the import script can seed a specific Boardroom workspace:

```bash
npm run import:local -- --workspace-id <workspace-id>
```

The script imports local memory, actions/cards, session summaries, artifacts, and the master business document into the selected workspace.
