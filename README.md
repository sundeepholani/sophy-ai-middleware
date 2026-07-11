# Sophy

Sophy is a central AI gateway for an organization. Client applications use
Sophy-issued keys instead of holding provider credentials. Each key owns one
configured model plus its prompt, generation parameters, optional output schema,
knowledgebase, rate limit, and monthly USD budget. Operators can change that
configuration without changing or redeploying the client.

Sophy exposes a practical OpenAI-compatible surface for Chat Completions,
Responses, embeddings, image generation, model discovery, and temporary file
uploads. Outbound calls use Vercel AI Gateway; Sophy owns client keys, policy,
usage accounting, evaluations, and the admin console.

> Migrating an application? Give its developers
> [AI API Migration.md](AI%20API%20Migration.md).

## How requests work

```text
client (OpenAI SDK, baseURL=<sophy>/v1, apiKey=mw_live_...)
  -> authenticate the Sophy key
  -> enforce the key's rate limit and monthly budget
  -> apply the key's model, prompt, parameters, schema, and knowledgebase
  -> pass supported input/tools through Vercel AI Gateway
  -> return an OpenAI-shaped response and record usage
```

- **The key is the configuration.** A client-sent `model` is ignored on every
  surface. On Chat/Responses, the key's temperature, top-p, maximum output
  tokens, and prompt also win. By default, client `system`/`developer` messages
  and Responses `instructions` are ignored.
- **Agent mode is explicit.** An operator can enable it for a trusted server-side
  application. Sophy then appends leading client system/developer instructions
  after the key-owned prompt. Do not enable it for clients that forward
  end-user-authored system messages.
- **Tools are passthrough.** Function tools work on Chat Completions and
  Responses. Sophy returns model tool calls but never executes them; the client
  runs each tool and sends its result in the next request.
- **One key selects one model.** Bind separate keys to language, image, or
  embedding models as needed. `GET /v1/models` returns the one model configured
  for the presented key.
- **Configuration is live.** Edits and revocation are read from Postgres on each
  request, so they apply immediately without a config cache.

## Supported API surface

| Endpoint | Current behavior |
|---|---|
| `POST /v1/chat/completions` | Buffered or streaming text, multimodal input, function tools, tool-result turns, and key-configured structured output. Legacy top-level `functions` is not supported; use `tools`. |
| `POST /v1/responses` | Buffered or streaming text, multimodal input, function tools, tool-result turns, and key-configured structured output. It is stateless: `previous_response_id` is rejected, so send the full input each time. |
| `POST /v1/embeddings` | A string or up to 2,048 strings; `float` and `base64` encodings. Token-array inputs are not supported. `dimensions` is supported only for `openai/*` embedding models. |
| `POST /v1/images/generations` | Uses the key's image model and returns `b64_json` only. Supports 1-10 images and validates `WIDTHxHEIGHT` size strings; provider-specific options still depend on the selected model. Generated images are not stored by Sophy. |
| `POST /v1/files` | Multipart `file` upload, at most 4 MiB (4,194,304 bytes). Allowed types: PDF, PNG, JPEG, WebP, GIF, plain text, CSV, and JSON. Uploads become eligible for cleanup after 24 hours. |
| `GET /v1/models` | Returns the model configured on the authenticated key, not the full operator catalog. |

Tool calling and key-configured structured output cannot be used in the same
request because they compete for the model's output channel. Non-streaming
structured output fails closed when validation fails. Streaming output is
validated after completion, but already-streamed bytes cannot be retracted.

Validation and buffered failures return OpenAI-shaped errors. Common statuses
are `400` for an invalid or unsupported request, `401` for a
missing/invalid/revoked key, `402` for an exhausted monthly budget or upstream
credit, `403` for a cross-key file reference, `413` for an oversized upload,
`429` for a rate limit, and `502` for an upstream or structured-output failure.
A `Retry-After` header is included when available for rate limits. An upstream
failure after SSE streaming begins ends the stream; it cannot be replaced with a
JSON error response.

## Operate Sophy

The passwordless admin console is at `/admin`. The first administrator is
bootstrapped from `BOOTSTRAP_ADMIN_EMAIL`; admins can invite more users by
email. Admins see the whole organization, while editors see and manage only
their owned keys and related usage, logs, and evaluations.

- **Overview** — trailing-30-day requests, tokens, estimated cost, Sophy spend,
  and errors.
- **API Keys** — create, edit, rotate, revoke, search, and bulk-change keys.
  Configure model, prompt, generation parameters, agent mode, JSON schema,
  knowledgebase, monthly USD budget, RPM limit, ownership, and optional content
  logging. Secrets are shown once; rotation preserves configuration and history.
- **Models** — search and sort the gateway catalog by provider, type, context
  window, price, and capabilities such as image input, file input, tool use, and
  reasoning. The key picker can filter by the same capabilities.
- **Usage** — 7/30/90-day request, token, and estimated-cost analytics with
  key/model filters, absolute/share charts, and breakdowns by key, model, and
  source. Gateway cost is a real-time estimate, not a billing-grade invoice.
- **Logs** — recent proxy and evaluation calls with model, tokens, cost, kind,
  streaming status, and errors. Per-key content logging captures buffered Chat,
  buffered/streaming Responses, and embedding inputs for 30 days; streaming Chat
  and image generation record usage metadata only. Usage metadata remains after
  content expires.
- **Evals** — run champion-vs-challenger evaluations on live text traffic. A
  blind judge reports win rate, confidence interval, cost, latency, projected
  monthly impact, and a recommendation. Results update in the console and can be
  emailed; Sophy does not switch the model automatically. Evals skip requests
  containing media/file content or supplying tools. While a run is active, its
  text samples are captured independently of the key's content-logging setting
  and raw prompts/outputs are purged when the run completes or is cancelled.
- **Knowledgebases** — upload text, Markdown, CSV, JSON, PDF, or DOCX documents.
  The cron extracts, chunks, and embeds them; attached keys retrieve relevant
  passages for Chat Completions and Responses requests.
- **Users / Settings** — manage admin/editor roles and choose the evaluation judge
  model and summary-email recipient.

## Stack

Next.js 16 (App Router), AI SDK v6, Vercel AI Gateway, Supabase Postgres
(Drizzle), Vercel Blob, shadcn/ui, and iron-session.

## Provision on Vercel

1. Link the project and add Supabase:

   ```bash
   vercel link
   vercel integration add supabase
   ```

   The integration supplies pooled and direct Postgres URLs. For manual setup,
   use `DATABASE_URL` for the app and `DATABASE_URL_UNPOOLED` for migrations.
   Enable Vercel Blob and AI Gateway, then configure the required provider
   credentials in AI Gateway.

2. Configure the environment variables documented in `.env.example`:

   - `KEY_HASH_PEPPER`, `SESSION_PASSWORD`, and `CRON_SECRET`
   - `BOOTSTRAP_ADMIN_EMAIL` and the canonical production `APP_ORIGIN`
   - `BLOB_READ_WRITE_TOKEN`
   - `AI_GATEWAY_API_KEY` for local calls and cron-driven evaluation/KB work
   - ZeptoMail variables for production sign-in links and optional evaluation
     summaries

   Generate random secrets with `openssl rand -hex 32`.

3. Apply database migrations:

   ```bash
   pnpm db:migrate
   ```

## Develop

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm typecheck
pnpm test
pnpm build
```

The idempotent `/api/cron/rollup` job runs every 15 minutes. It rolls up usage,
purges 30-day request content, sweeps 24-hour client uploads, processes model
evaluations, and ingests knowledgebase documents. `CRON_SECRET` protects the
route, and a Postgres lock prevents overlapping runs; Redis is not used.

## Minimal client migration

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SOPHY_API_KEY,
  baseURL: "https://sophy.in/v1",
});

const response = await client.chat.completions.create({
  model: "sophy", // required by many SDKs, ignored by Sophy
  messages: [{ role: "user", content: "Hello" }],
});
```

See [AI API Migration.md](AI%20API%20Migration.md) for tools, agent mode,
multimodal input, files, embeddings, image generation, limits, and error handling.

## Verify end to end

1. Create a key and call the endpoint that matches its configured model type.
2. Change its model or prompt and confirm the next request uses the new config.
3. Test buffered and streaming Chat/Responses calls.
4. Pass function tools, execute the returned calls client-side, and send results.
5. If a schema is configured, verify a non-streaming reply is valid JSON.
6. Exercise embeddings or image generation with a matching key.
7. Exceed RPM and monthly USD budget limits; expect `429` and `402`.
8. Rotate or revoke a key; the old secret must fail immediately.
9. Upload a file and confirm another key cannot reuse its public-but-unguessable
   Sophy URL through the API.
10. Confirm admin cookies cannot authenticate `/v1/*` and API keys cannot access
    admin actions.

## Deploy

```bash
vercel deploy --prod
```

Proxy routes use the Node.js runtime. In production, request handlers use Vercel
OIDC for gateway authentication; `AI_GATEWAY_API_KEY` remains the local and cron
credential.
