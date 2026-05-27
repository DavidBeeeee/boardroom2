# MVP Architecture

## Request flow

1. The browser signs in with Supabase Auth.
2. The browser sends the Supabase access token as a bearer token to Next.js API routes.
3. API routes create a Supabase client with that token, so Row Level Security applies to every query.
4. Every route validates workspace membership before reading or writing workspace data.
5. Chat routes build context from workspace guardrails, memory, recent messages, documents, and the active Advisor Work Card.
6. The server calls DeepSeek using `DEEPSEEK_API_KEY` when available, otherwise a client-provided key from the current browser session.
7. Generated messages, memory summaries, and Advisor Work Cards are persisted back to Supabase.

## Data boundaries

All client-owned product data carries `workspace_id`. RLS policies allow access only when the authenticated user appears in `workspace_members` for that workspace.

Documents are stored in the private `workspace-documents` bucket under:

```text
<workspace_id>/<file-id>-<safe-file-name>
```

The same workspace membership check is used for Storage object access.

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

## Out of scope for v1

- Gmail, Calendar, and Drive writes
- billing
- self-serve onboarding
- custom advisor builder
- model usage metering
