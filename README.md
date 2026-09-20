# Sophy

Sophy is a multi-project AI control plane. Client applications use Sophy-issued
keys instead of holding provider credentials. Each project connects its own
Vercel AI Gateway key, and each Sophy key owns one primary model plus its prompt,
generation parameters, optional output schema, knowledgebase, rate limit, and
monthly USD budget. A transcription key can also name a language model that
applies the key-owned prompt to the raw transcript. Operators can change that
configuration without changing or redeploying the client.

Sophy exposes a practical OpenAI-compatible surface for Chat Completions,
Responses, audio transcription, embeddings, image generation, model discovery,
and temporary file uploads, plus a native `POST /v1/evaluate` route for
evaluation models, which no OpenAI client method can reach. Outbound calls use
Vercel AI Gateway; Sophy owns client keys, policy, usage accounting,
evaluations, and the admin console.

> Migrating an application? Give its developers
> [AI API Migration.md](AI%20API%20Migration.md).

## How requests work

```text
client (OpenAI SDK, baseURL=<sophy>/v1, apiKey=mw_live_...)
  -> authenticate the Sophy key
  -> resolve its active project and that project's encrypted Gateway credential
  -> enforce the key's rate limit and monthly budget
  -> apply the key's model, prompt, parameters, schema, and knowledgebase
  -> pass supported input/tools through Vercel AI Gateway
  -> for configured transcription keys, apply the prompt to the raw transcript
  -> return an OpenAI-shaped response and record usage
```

- **The key is the configuration.** A client-sent `model` is ignored on every
  surface. On Chat/Responses, the key's temperature, top-p, maximum output
  tokens, and prompt also win. By default, client `system`/`developer` messages
  and Responses `instructions` are ignored. Audio transcription rejects a
  client `prompt`; the key's system prompt controls optional transcript
  processing instead.
- **Agent mode is explicit.** An operator can enable it for a trusted server-side
  application. Sophy then appends leading client system/developer instructions
  after the key-owned prompt. Do not enable it for clients that forward
  end-user-authored system messages.
- **Tools are passthrough.** Function tools work on Chat Completions and
  Responses. Sophy returns model tool calls but never executes them; the client
  runs each tool and sends its result in the next request.
- **One key selects one primary model.** Bind separate keys to language,
  transcription, image, embedding, or evaluation models as needed. A
  transcription key can optionally select a language model only for
  post-processing. `GET /v1/models` returns the primary model configured for the
  presented key.
- **Configuration is live.** Edits and revocation are read from Postgres on each
  request, so they apply immediately without a config cache.

## Supported API surface

| Endpoint | Current behavior |
|---|---|
| `POST /v1/chat/completions` | Buffered or streaming text, multimodal input, function tools, tool-result turns, and key-configured structured output. Legacy top-level `functions` is not supported; use `tools`. |
| `POST /v1/responses` | Buffered or streaming text, multimodal input, function tools, tool-result turns, and key-configured structured output. It is stateless: `previous_response_id` is rejected, so send the full input each time. |
| `POST /v1/audio/transcriptions` | Multipart audio transcription for MP3/MPEG/MPGA, MP4/M4A, WAV, WebM, FLAC, or OGG files up to 4 MiB. Returns raw text when no processing policy is set, or only the policy-processed text when the key has a system prompt plus a language processor model. |
| `POST /v1/embeddings` | A string or up to 2,048 strings; `float` and `base64` encodings. Token-array inputs are not supported. `dimensions` is supported only for `openai/*` embedding models. |
| `POST /v1/evaluate` | Native, not OpenAI-compatible: no OpenAI client method reaches evaluation models. Send a `state` (string, object, or array) plus 1-32 named `boolean`, `choice`, or `score` questions and receive one typed answer each with token usage. `state` is capped at 200,000 serialized characters; the call is buffered, never streamed. |
| `POST /v1/images/generations` | Uses the key's image model and returns `b64_json` only. Supports 1-10 images and validates `WIDTHxHEIGHT` size strings; provider-specific options still depend on the selected model. Generated images are not stored by Sophy. |
| `POST /v1/files` | Multipart `file` upload, at most 4 MiB (4,194,304 bytes). Allowed types: PDF, PNG, JPEG, WebP, GIF, plain text, CSV, and JSON. Uploads become eligible for cleanup after 24 hours. |
| `GET /v1/models` | Returns the model configured on the authenticated key, not the full operator catalog. |

Tool calling and key-configured structured output cannot be used in the same
request because they compete for the model's output channel. Non-streaming
structured output fails closed when validation fails. Streaming output is
validated after completion, but already-streamed bytes cannot be retracted.

Validation and buffered failures return OpenAI-shaped errors. Common statuses
are `400` for an invalid or unsupported request, `401` for a
missing/invalid/revoked key or inactive project, `402` for an exhausted Sophy-key
monthly budget, `403` for a cross-key file reference, `413` for an oversized file
or audio upload, `429` for a rate limit, `502` for a transient upstream
(including transient transcription or processing) or structured-output failure, and
`503 project_gateway_unavailable` when the key is valid but its project has no
usable Vercel Gateway credential.
A `Retry-After` header is included when available for rate limits. An upstream
failure after SSE streaming begins ends the stream; it cannot be replaced with a
JSON error response.

## Operate Sophy

The passwordless console is at `/admin`. Any verified email can create an account;
independent signup creates a renameable `My Project` and makes that person its
Admin. Invitation-first signup joins only the invited project and makes it the
person's default. The same identity can be an Admin in one project and an Editor
in another. Project Admins see the whole current project, while Editors manage
only their owned keys and knowledgebases and see only their related usage, logs,
and evaluations.

- **Overview** — trailing-30-day requests, tokens, estimated cost, Sophy spend,
  and errors.
- **Projects** — switch without changing your personal default, set any active
  membership as default, create or rename projects, manage members/invitations,
  and connect, validate, rotate, or disconnect the project-owned Vercel Gateway
  credential. AI work and Sophy-key creation stay paused until it is healthy.
- **Sophy API Keys** — create, edit, rotate, revoke, search, and bulk-change keys.
  Configure primary model, prompt, optional transcript processor model, generation
  parameters, agent mode, JSON schema, knowledgebase, monthly USD budget, RPM
  limit, ownership, and optional content logging. Secrets are shown once; rotation
  preserves configuration and history.
- **Models** — search and sort the gateway catalog by provider, type, context
  window, price, and capabilities such as transcription, image input, file input,
  tool use, and reasoning. The key picker can filter by the same capabilities.
- **Usage** — 7/30/90-day request, token, and estimated-cost analytics with
  key/model filters, absolute/share charts, and breakdowns by key, model, and
  source. Gateway cost is a real-time estimate, not a billing-grade invoice.
- **Logs** — recent client requests plus transcript-processor, evaluation, and
  knowledgebase component calls, with model, tokens, cost, kind, streaming
  status, and errors. Per-key content logging captures Chat and Responses
  messages/replies, embedding inputs, transcription text, and evaluation
  state/questions/answers for 30 days.
  Complete Chat/Responses image input values use a shorter seven-day window and
  are then replaced by placeholders; inline data URLs include their bytes, while
  an external URL remains only a reference to externally owned content.
  Transcription audio bytes and generated images are never stored. Usage metadata
  remains after content expires.
- **Evals** — run champion-vs-challenger evaluations on live text traffic. A
  blind judge reports win rate, confidence interval, cost, latency, projected
  monthly impact, and a recommendation. Results update in the console and can be
  emailed; Sophy does not switch the model automatically. Evals skip requests
  containing media/file content or supplying tools. While a run is active, its
  text samples are captured independently of the key's content-logging setting
  and raw prompts/outputs are purged when the run completes or is cancelled.
- **Knowledgebases** — Project Admins manage every project collection; Editors
  can create and manage collections they own. Upload text, Markdown, CSV, JSON,
  PDF, or DOCX documents. The cron extracts, chunks, and embeds them; Editors can
  attach project knowledgebases to keys they own, and attached keys retrieve
  relevant passages for Chat Completions and Responses requests.
- **Members / Project settings** — manage per-project Admin/Editor roles, the
  project name and Gateway connection, and project-specific evaluation judge and
  summary-email settings.

## Stack

Node.js 22 or newer, Next.js 16 (App Router), AI SDK v6 with an isolated v7
transcription adapter, Vercel AI Gateway, Supabase Postgres (Drizzle), Vercel
Blob, shadcn/ui, and iron-session.

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
   - The canonical production `APP_ORIGIN`
   - `BLOB_READ_WRITE_TOKEN`
   - `PROJECT_GATEWAY_ENCRYPTION_KEY`, `PROJECT_GATEWAY_ENCRYPTION_KEY_VERSION`,
     and `PROJECT_GATEWAY_FINGERPRINT_KEY` for encrypted project credentials;
     keep the fingerprint key immutable after first use unless every active
     credential is re-fingerprinted in one coordinated rotation
   - `AI_GATEWAY_API_KEY` only for the time-limited legacy migration bridge
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
discards seven-day image input values, purges 30-day request content, sweeps
expired client uploads (24 hours by default, extended to the matching seven-day
window for content-logged image references), processes model evaluations, and
ingests knowledgebase documents. `CRON_SECRET` protects the route, and a
Postgres lock prevents overlapping runs; Redis is not used.

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
multimodal input, files, audio transcription, embeddings, image generation,
evaluation models, limits, and error handling.

## Verify end to end

1. Create a key and call the endpoint that matches its configured model type.
2. Change its model or prompt and confirm the next request uses the new config.
3. Test buffered and streaming Chat/Responses calls.
4. Pass function tools, execute the returned calls client-side, and send results.
5. If a schema is configured, verify a non-streaming reply is valid JSON.
6. Exercise audio transcription, embeddings, image generation, or `/v1/evaluate`
   with a matching key.
7. For a transcription key, verify a blank system prompt returns the raw
   transcript unchanged, then configure a system prompt and language processor
   model and verify the client receives only the processed `text`.
8. Exceed RPM and monthly USD budget limits; expect `429` and `402`.
9. Rotate or revoke a key; the old secret must fail immediately.
10. Upload a file and confirm another key cannot reuse its public-but-unguessable
   Sophy URL through the API.
11. Confirm admin cookies cannot authenticate `/v1/*` and API keys cannot access
    admin actions.
12. Test two projects with distinct Vercel Gateway keys and verify live requests,
    structured retries, KB embeddings, and eval work record only the correct
    project and immutable Gateway-credential ID.

## Deploy

```bash
vercel deploy --prod
```

Proxy routes use the Node.js runtime. Tenant AI work always uses the explicit,
encrypted Gateway credential resolved from the Sophy key's project. It never
falls back to deployment OIDC, a global key, or another project's credential.
`AI_GATEWAY_API_KEY` exists only for the migration-only legacy bridge and should
be removed after that project's Admin connects its dedicated project key.

## License

[MIT](LICENSE).
