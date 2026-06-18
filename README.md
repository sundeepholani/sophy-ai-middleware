# AI Middleware

A central **AI gateway proxy** for your organization. Client systems stop holding
their own OpenAI/Anthropic keys and instead call this middleware with a key it
issues. **Each key carries its own model + system prompt + quota**, all editable
from a UI with **no client change and no redeploy**. You also get central
usage/cost visibility.

It exposes an **OpenAI-compatible** API, so existing clients only change
`base_url` + `api_key`. Outbound calls go through the **Vercel AI Gateway**
(provider keys held there as BYOK); everything above it — your client keys, their
per-key config, quotas, and the admin console — is owned here.

> Design rationale, alternatives considered, and the adversarial review are in
> the plan: `~/.claude/plans/we-are-implementing-ai-snug-mitten.md`.

## How it works

```
client (OpenAI SDK, baseURL=<mw>/v1, api_key=mw_live_…)
  -> auth the key  (the key carries: model, system prompt, params, schema, quota)
  -> rate limit -> quota pre-check
  -> inject the key's system prompt (drop client system) -> reject tools
  -> AI Gateway -> provider
  -> map to OpenAI response ; record usage
```

- **The key is the whole config.** The `model` field a client sends is **ignored** —
  the key's configured model always wins. Edit a key's model/prompt in the UI and
  it applies on the next request (config is read straight off the key, no cache).
- **Stores:** Postgres (Supabase) is the source of truth and also runs the
  hot-path counters (rate limit via an atomic counter table; quota as a sum over
  `usage_events`; cron lock via a `locks` row). Vercel Blob holds uploaded files.
  (No Redis, no routes/prompts tables — the whole stack is Supabase + Vercel.)

## Stack

Next.js 16 (App Router) · AI SDK v6 · Vercel AI Gateway · Supabase Postgres (Drizzle)
· Vercel Blob · shadcn/ui · iron-session.

## Provision (Vercel)

1. **Link the project** and add Marketplace integrations:
   ```bash
   vercel link
   vercel integration add supabase   # Postgres -> POSTGRES_URL / POSTGRES_URL_NON_POOLING
   ```
   The Supabase integration auto-sets `POSTGRES_URL` (pooled) and
   `POSTGRES_URL_NON_POOLING` (direct); a manual setup uses `DATABASE_URL` /
   `DATABASE_URL_UNPOOLED` (Supabase → Project Settings → Database → Connection
   string: transaction pooler `:6543` for the app, direct `:5432` for migrations).
   Enable **Vercel Blob** (-> `BLOB_READ_WRITE_TOKEN`) and **AI Gateway** in the
   dashboard. In AI Gateway, add your org's **OpenAI/Anthropic keys as BYOK**.
2. **Set secrets** (generate with `openssl rand -hex 32`):
   `KEY_HASH_PEPPER`, `SESSION_PASSWORD`, `CRON_SECRET`, and the admin login:
   ```bash
   # admin password hash:
   node -e "console.log(require('bcryptjs').hashSync(process.argv[1],12))" 'your-admin-password'
   # -> ADMIN_PASSWORD_HASH ; also set ADMIN_USERNAME (default "admin")
   ```
   See `.env.example` for the full list. Locally, copy it to `.env.local`.
3. **Migrate the database:**
   ```bash
   pnpm db:migrate     # applies drizzle/ migrations (uses DATABASE_URL_UNPOOLED)
   ```

## Develop

```bash
pnpm install
pnpm dev               # http://localhost:3000  (-> /admin)
pnpm typecheck         # tsc --noEmit
pnpm test              # vitest unit tests
pnpm build             # production build
```

Cron is configured in `vercel.ts` (`/api/cron/rollup`, every 15 min) — idempotent
usage rollups + stale-blob sweep, guarded by `CRON_SECRET` + a Redis lock.

## Operate (admin console)

`/admin` (sign in with the configured admin credentials):

- **API Keys** — the one screen that matters. Create or edit a key with its
  **model** (dropdown), **system prompt**, optional advanced fields (temperature,
  max tokens, output JSON schema), and quota (monthly token cap + RPM). New keys
  are shown once. Revoke is instant. Edits apply on the next request.
- **Usage / Logs** — token & cost trends and recent requests.

## Migrate a client system

The entire client-side change:

```ts
// BEFORE
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'system', content: 'You are…' }, { role: 'user', content: q }],
});

// AFTER
const openai = new OpenAI({
  apiKey: process.env.MIDDLEWARE_KEY,           // key issued by the middleware
  baseURL: 'https://<your-mw-host>/v1',
});
await openai.chat.completions.create({
  model: 'anything',                            // ignored — the key sets the model
  messages: [{ role: 'user', content: q }],     // operator owns the system prompt
});
```

Notes: the `model` field is ignored (the key's model wins); client `system`
messages are dropped (the key's system prompt is used); **tool/function calling
is rejected with a 400**; large files use `POST /v1/files` (multipart, ≤4 MB) and
the returned URL as a content part.

## Verify end-to-end

With a key created (model + system prompt):

1. **Smoke** — point an OpenAI SDK at `/v1`, key = the issued `mw_*` key (the
   `model` field can be anything); get a completion.
2. **Model switch** — change the key's model in the UI; re-run; confirm the new
   provider served it (Logs) with no client change/redeploy.
3. **Prompt update** — edit the key's system prompt; confirm new behavior on the
   next request.
4. **Structured** — set a key's output JSON schema; confirm validated JSON; bad
   output returns an OpenAI-shaped error, never a 200 with invalid JSON.
5. **Streaming + abort** — stream, disconnect after the first frame; a
   `usage_event` with non-zero tokens is still recorded (drain via
   `consumeStream` + `onFinish`).
6. **Limits** — exceed RPM -> 429; exceed monthly token cap -> 402.
7. **Revocation** — revoke a key; next request -> 401 immediately.
8. **Tools** — send `tools:[…]` -> OpenAI-shaped 400.
9. **Files** — upload via `/v1/files`, reference the URL; another key can't.
10. **Auth separation** — admin cookie rejected on `/v1/*`; `mw_*` key
    rejected on `/api/admin/*`.

## Deploy

```bash
vercel deploy --prod
```

Proxy routes run on the Node.js runtime with `maxDuration = 800`. In production,
proxy→Gateway auth uses Vercel OIDC automatically; `AI_GATEWAY_API_KEY` is the
local/fallback path.
