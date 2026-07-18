# Studio Architecture

## Request flow

1. The browser uses the existing Colorado Mastermind Studio Supabase session.
2. The browser sends the Supabase access token as a bearer token to Next.js API routes.
3. API routes create a Supabase client with that token, so Row Level Security applies to every query.
4. Every route validates both the active `boardroom` entitlement and workspace membership before reading or writing data.
5. Chat routes build context from workspace guardrails, memory, recent messages, documents, and the active Advisor Work Card.
6. The server calls DeepSeek using `DEEPSEEK_API_KEY` when available, otherwise a client-provided key from the current browser session.
7. Generated messages, memory summaries, and Advisor Work Cards are persisted back to Supabase.

## Data boundaries

All client-owned product data carries `workspace_id`. Boardroom tables use the `boardroom_` prefix. RLS policies require an active Studio entitlement and a row in `boardroom_workspace_members` for that workspace.

Documents are stored in the private `boardroom-documents` bucket under:

```text
<workspace_id>/<file-id>-<safe-file-name>
```

The same entitlement and workspace membership checks apply to Storage object access.

## Fresh Start

Fresh Start deletes:

- messages
- conversations
- advisor cards
- generated memory entries

Fresh Start preserves:

- uploaded documents
- workspace settings
- workspace members

## Studio boundaries

- Gmail, Calendar, and Drive writes
- billing
- Systeme.io webhook automation
- custom advisor builder
- model usage metering
