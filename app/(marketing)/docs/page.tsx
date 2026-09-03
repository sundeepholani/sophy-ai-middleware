import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeTabs, CodeBlock } from '@/components/marketing/code-tabs';

export const metadata: Metadata = {
  title: 'Docs — Sophy',
  description:
    'Sophy documentation for its multi-project console, project-owned Vercel Gateway credentials, Chat Completions, Responses, audio transcription, embeddings, images, tools, files, key policy, knowledgebases, evaluations, errors, and limits.',
};

const BASE_URL = 'https://sophy.in/v1';

const NAV_GROUPS = [
  {
    label: 'Getting started',
    items: [
      { id: 'introduction', label: 'Introduction' },
      { id: 'api-surfaces', label: 'API surfaces' },
      { id: 'authentication', label: 'Authentication' },
      { id: 'quickstart', label: 'Quickstart' },
    ],
  },
  {
    label: 'Language APIs',
    items: [
      { id: 'chat-completions', label: 'Chat Completions' },
      { id: 'responses', label: 'Responses API' },
      { id: 'multimodal', label: 'Multimodal input' },
      { id: 'tools', label: 'Tool calling' },
      { id: 'structured-output', label: 'Structured output' },
    ],
  },
  {
    label: 'Other APIs',
    items: [
      { id: 'audio-transcriptions', label: 'Audio transcription' },
      { id: 'embeddings', label: 'Embeddings' },
      { id: 'images', label: 'Image generation' },
      { id: 'files', label: 'Files' },
      { id: 'models', label: 'Models' },
    ],
  },
  {
    label: 'Policy and operations',
    items: [
      { id: 'key-policy', label: 'Key-owned policy' },
      { id: 'agent-mode', label: 'Agent mode' },
      { id: 'knowledgebases', label: 'Knowledgebases' },
      { id: 'operator-console', label: 'Operator console' },
    ],
  },
  {
    label: 'Reliability',
    items: [
      { id: 'errors', label: 'Errors' },
      { id: 'rate-limits', label: 'Limits and quota' },
    ],
  },
] as const;

function Method({ method, path }: { method: string; path: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 ring-1 ring-border">
      <span className="rounded-md bg-primary px-2 py-0.5 font-mono text-xs font-semibold text-primary-foreground">
        {method}
      </span>
      <code className="font-mono text-sm break-all text-foreground">{path}</code>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4 border-t pt-12 first:border-t-0 first:pt-0">
      <h2 className="font-heading text-2xl font-semibold tracking-tight">
        <Link href={`#${id}`} className="group inline-flex items-center gap-2">
          {title}
          <span
            aria-hidden
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            #
          </span>
        </Link>
      </h2>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-muted-foreground text-pretty">{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  );
}

function Note({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-relaxed">
      <p className="font-medium text-foreground">{title}</p>
      <div className="mt-1 text-muted-foreground">{children}</div>
    </div>
  );
}

function FieldTable({
  caption,
  rows,
}: {
  caption: string;
  rows: { name: string; type: string; note: React.ReactNode }[];
}) {
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-border">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/60">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Field
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Type
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Notes
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.name}-${index}`} className="border-t align-top">
              <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-foreground">
                {row.name}
              </td>
              <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-muted-foreground">
                {row.type}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ERROR_ROWS: { status: string; type: string; code: string; when: string }[] = [
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'functions_unsupported',
    when: 'Legacy Chat Completions `functions` was sent; use `tools`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'stateful_unsupported',
    when: 'Responses `previous_response_id` was sent; send the full input each call.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'tools_unsupported',
    when: 'Function tools were sent to a key configured for structured output.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_content_type',
    when: 'Audio transcription was not sent as multipart/form-data.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_multipart_form',
    when: 'The audio transcription multipart body could not be parsed.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'missing_file',
    when: 'The transcription multipart body did not contain a `file` field.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_file',
    when: 'The transcription `file` field was not a valid uploaded file.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'empty_file',
    when: 'The uploaded audio file contained no bytes.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_audio_format',
    when: 'The uploaded bytes were not recognized as an allowed audio format.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_language',
    when: 'The optional transcription `language` value was invalid.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_transcription_option',
    when: 'A client `prompt`, streaming, or timestamp option was sent.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'model_not_transcription',
    when: 'The key’s known model cannot handle buffered audio transcription, including realtime-only models.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'transcript_processor_required',
    when: 'The key has transcript-processing instructions but no processor model.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'processor_model_not_language',
    when: 'The configured transcript processor is a known non-language model.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_url',
    when: 'A Chat or Responses image/file part contains a malformed URL.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'model_not_image',
    when: 'Image generation was requested with a known non-image key model.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_response_format',
    when: 'Image output requested anything but `b64_json`, or transcription requested anything but `json`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'model_not_embedding',
    when: 'Embeddings were requested with a known non-embedding key model.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'token_input_unsupported',
    when: 'Pre-tokenized embedding input was sent; use strings.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_encoding_format',
    when: 'Embedding `encoding_format` was not `float` or `base64`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'dimensions_unsupported',
    when: '`dimensions` was sent to a non-OpenAI embedding model.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_file_type',
    when: 'The uploaded file content type is outside the allowlist.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'upstream_invalid_request',
    when: 'The model provider rejected the request as invalid; its actionable detail is returned.',
  },
  {
    status: '401',
    type: 'authentication_error',
    code: 'missing_api_key',
    when: 'No valid Bearer Authorization header was supplied.',
  },
  {
    status: '401',
    type: 'authentication_error',
    code: 'invalid_api_key',
    when: 'The key is malformed, unknown, revoked, expired, or belongs to an inactive project.',
  },
  {
    status: '402',
    type: 'insufficient_quota',
    code: 'quota_exceeded',
    when: 'The key reached its monthly proxy-traffic cost cap.',
  },
  {
    status: '403',
    type: 'invalid_request_error',
    code: 'file_access_denied',
    when: 'A request references a Sophy upload owned by another key.',
  },
  {
    status: '413',
    type: 'invalid_request_error',
    code: 'file_too_large',
    when: 'A file or audio upload exceeds 4 MiB (4,194,304 bytes).',
  },
  {
    status: '429',
    type: 'rate_limit_error',
    code: 'rate_limit_exceeded',
    when: 'The key RPM limit or an upstream provider rate/quota limit was reached.',
  },
  {
    status: '502',
    type: 'api_error',
    code: 'schema_validation_failed',
    when: 'A buffered structured response could not satisfy the key schema.',
  },
  {
    status: '502',
    type: 'api_error',
    code: 'upload_failed',
    when: 'Sophy could not persist a file upload.',
  },
  {
    status: '502',
    type: 'api_error',
    code: 'upstream_error',
    when: 'A transient upstream network or server failure occurred.',
  },
  {
    status: '503',
    type: 'api_error',
    code: 'project_gateway_unavailable',
    when: 'The key is valid, but its project has no usable Vercel AI Gateway credential.',
  },
];

const QUICKSTART_SAMPLES = [
  {
    label: 'python',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}",
    api_key="mw_live_…",
)

resp = client.chat.completions.create(
    model="sophy",  # ignored — the key owns the model
    messages=[{"role": "user", "content": "Hello, Sophy!"}],
)
print(resp.choices[0].message.content)`,
  },
  {
    label: 'javascript',
    code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${BASE_URL}",
  apiKey: "mw_live_…",
});

const resp = await client.chat.completions.create({
  model: "sophy",  // ignored — the key owns the model
  messages: [{ role: "user", content: "Hello, Sophy!" }],
});
console.log(resp.choices[0].message.content);`,
  },
  {
    label: 'curl',
    code: `curl ${BASE_URL}/chat/completions \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "sophy",
    "messages": [{"role": "user", "content": "Hello, Sophy!"}]
  }'`,
  },
];

export default function DocsPage() {
  return (
    <div className="mx-auto w-full max-w-7xl gap-12 px-4 py-12 sm:px-6 lg:grid lg:grid-cols-[220px_1fr] lg:px-8">
      <aside className="hidden lg:block">
        <nav
          aria-label="Documentation sections"
          className="sticky top-24 max-h-[calc(100vh-7rem)] space-y-5 overflow-y-auto pb-6"
        >
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <Link
                    key={item.id}
                    href={`#${item.id}`}
                    className="block rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 max-w-4xl">
        <details className="mb-10 rounded-xl bg-muted/50 p-4 ring-1 ring-border lg:hidden">
          <summary className="cursor-pointer text-sm font-medium">On this page</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </p>
                <div className="mt-1 space-y-1">
                  {group.items.map((item) => (
                    <Link
                      key={item.id}
                      href={`#${item.id}`}
                      className="block py-1 text-sm text-primary hover:underline"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>

        <header className="space-y-3">
          <p className="text-sm font-medium text-primary">Sophy documentation</p>
          <h1 className="font-heading text-4xl font-semibold tracking-tight">Build on a governed AI gateway</h1>
          <P>
            Use supported OpenAI client methods at <Code>{BASE_URL}</Code>. Each Sophy key is bound
            to one primary model and carries its policy, limits, and optional knowledge server-side.
          </P>
        </header>

        <div className="mt-12 space-y-12">
          <Section id="introduction" title="Introduction">
            <P>
              Sophy is an OpenAI-compatible gateway and operator console. Applications send input in
              familiar wire formats; Sophy authenticates the key, resolves its centrally managed
              configuration, calls the bound model through that key’s project-owned Vercel AI
              Gateway credential, and records project-attributed usage.
            </P>
            <P>
              Compatibility is intentionally scoped. Chat Completions and Responses cover text,
              streaming, multimodal input, and function-tool loops. Dedicated routes cover
              audio transcription, embeddings, image generation, short-lived file uploads, and the
              primary model bound to a key. The sections below call out differences from the full
              OpenAI platform.
            </P>
            <Method method="BASE URL" path={BASE_URL} />
          </Section>

          <Section id="api-surfaces" title="Supported API surfaces">
            <div className="overflow-x-auto rounded-xl ring-1 ring-border">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Supported Sophy API routes</caption>
                <thead className="bg-muted/60">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Method
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Route
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Required capability
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Compatibility boundary
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['POST', '/chat/completions', 'Language generation', 'Text, streaming, multimodal input, function tools'],
                    ['POST', '/responses', 'Language generation', 'Stateless; full input required on every call'],
                    ['POST', '/audio/transcriptions', 'Transcription', 'Multipart audio; JSON with raw or policy-processed text'],
                    ['POST', '/embeddings', 'Embedding', 'String input; float or base64 vectors'],
                    ['POST', '/images/generations', 'Image generation', 'Base64 image output only'],
                    ['POST', '/files', 'Any', '201 response; 4 MiB; cleanup-eligible after 24 hours'],
                    ['GET', '/models', 'Any', 'Returns only the primary model bound to this key'],
                  ].map(([method, path, model, note]) => (
                    <tr key={path} className="border-t align-top">
                      <td className="px-4 py-2.5 font-mono text-[13px] text-primary">{method}</td>
                      <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-foreground">
                        /v1{path}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{model}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note title="One key, one primary model">
              <p>
                Bind keys around workloads and call a route the primary model’s capabilities
                support. The client-sent <Code>model</Code> never switches that model. A
                transcription key may separately name a language model for key-owned transcript
                processing.
              </p>
            </Note>
          </Section>

          <Section id="authentication" title="Authentication">
            <P>
              Send the Sophy key as a Bearer token. Keys look like <Code>mw_live_…</Code> and are
              issued inside a project in the{' '}
              <Link href="/admin/login" className="text-primary underline-offset-4 hover:underline">
                Sophy console
              </Link>
              . Sign in with any verified email to create a renameable <Code>My Project</Code>, or
              join an existing project through an Admin invitation.
            </P>
            <CodeBlock label="header" code="Authorization: Bearer mw_live_…" />
            <P>
              Missing Bearer authentication returns <Code>401 missing_api_key</Code>. A malformed,
              unknown, revoked, expired, or inactive-project key returns{' '}
              <Code>401 invalid_api_key</Code>.
              Keys are checked against the database on every request, so edits and revocation apply
              immediately.
            </P>
            <Note title="Two credentials, separate jobs">
              <p>
                A Sophy API key authenticates your application to Sophy. A Project Admin separately
                connects a Vercel AI Gateway key that pays for and routes every AI operation in that
                project. Sophy never returns the stored Gateway secret.
              </p>
            </Note>
          </Section>

          <Section id="quickstart" title="Quickstart">
            <P>
              Change the base URL and API key, then call one of the supported methods. The
              placeholder <Code>model</Code> is required by some OpenAI SDK methods but Sophy uses
              the model bound to the key.
            </P>
            <CodeTabs samples={QUICKSTART_SAMPLES} />
          </Section>

          <Section id="chat-completions" title="Chat Completions">
            <Method method="POST" path={`${BASE_URL}/chat/completions`} />
            <FieldTable
              caption="Chat Completions request fields"
              rows={[
                {
                  name: 'messages',
                  type: 'array',
                  note: (
                    <>
                      Required and non-empty. Supports user, assistant, and tool turns plus text,
                      image, and file content. System/developer handling depends on{' '}
                      <Link href="#agent-mode" className="text-primary underline-offset-4 hover:underline">
                        Agent mode
                      </Link>
                      .
                    </>
                  ),
                },
                {
                  name: 'stream',
                  type: 'boolean',
                  note: 'Optional. Emits OpenAI chat.completion.chunk SSE frames.',
                },
                {
                  name: 'stream_options',
                  type: 'object',
                  note: (
                    <>
                      Optional. <Code>{'{ include_usage: true }'}</Code> adds a final usage-only
                      chunk.
                    </>
                  ),
                },
                {
                  name: 'tools',
                  type: 'array',
                  note: (
                    <>
                      Optional function definitions. Sophy returns calls but never executes them.
                      See <Link href="#tools" className="text-primary underline-offset-4 hover:underline">Tool calling</Link>.
                    </>
                  ),
                },
                {
                  name: 'tool_choice',
                  type: 'string | object',
                  note: (
                    <>
                      <Code>auto</Code>, <Code>none</Code>, <Code>required</Code>, or one named
                      function.
                    </>
                  ),
                },
              ]}
            />
            <P>
              <strong className="text-foreground">Key-owned or ignored:</strong>{' '}
              <Code>model</Code>, <Code>temperature</Code>, <Code>top_p</Code>,{' '}
              <Code>max_tokens</Code>, <Code>max_completion_tokens</Code>,{' '}
              <Code>response_format</Code>, <Code>n</Code>, and <Code>user</Code>. Sophy applies the
              key’s configured model and generation parameters instead.
            </P>
            <h3 className="font-heading pt-2 text-lg font-medium">Buffered response</h3>
            <CodeBlock
              label="json"
              code={`{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1735689600,
  "model": "anthropic/claude-sonnet-4.6",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello! How can I help?" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 9, "completion_tokens": 7, "total_tokens": 16 }
}`}
            />
            <h3 className="font-heading pt-2 text-lg font-medium">Streaming</h3>
            <P>
              A stream begins with an assistant-role chunk, emits text and/or tool-call deltas,
              finishes with a reason chunk, optionally emits usage, and ends with{' '}
              <Code>data: [DONE]</Code>.
            </P>
            <CodeBlock
              label="stream"
              code={`data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1735689600,"model":"anthropic/claude-sonnet-4.6","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1735689600,"model":"anthropic/claude-sonnet-4.6","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1735689600,"model":"anthropic/claude-sonnet-4.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]`}
            />
          </Section>

          <Section id="responses" title="Responses API">
            <Method method="POST" path={`${BASE_URL}/responses`} />
            <P>
              Use <Code>client.responses.create(...)</Code> for a Responses-compatible text,
              multimodal, streaming, or function-tool workflow. Sophy is stateless: send the full
              conversation and any prior function calls/results in <Code>input</Code> on every
              request.
            </P>
            <FieldTable
              caption="Responses API request fields"
              rows={[
                {
                  name: 'input',
                  type: 'string | array',
                  note: 'Required. Must yield at least one usable message or tool item; send the full state for this call.',
                },
                {
                  name: 'stream',
                  type: 'boolean',
                  note: 'Optional. Emits numbered, typed Responses SSE events.',
                },
                {
                  name: 'tools',
                  type: 'array',
                  note: 'Optional flat function-tool definitions. Non-function Responses tool types are ignored.',
                },
                {
                  name: 'tool_choice',
                  type: 'string | object',
                  note: 'Optional. auto, none, required, or one named function.',
                },
                {
                  name: 'instructions',
                  type: 'string',
                  note: (
                    <>
                      Used only when the key has{' '}
                      <Link href="#agent-mode" className="text-primary underline-offset-4 hover:underline">
                        Agent mode
                      </Link>{' '}
                      enabled; otherwise dropped.
                    </>
                  ),
                },
                {
                  name: 'previous_response_id',
                  type: 'string',
                  note: (
                    <>
                      Not supported. Returns <Code>400 stateful_unsupported</Code>.
                    </>
                  ),
                },
                {
                  name: 'store',
                  type: 'boolean',
                  note: 'Ignored. Sophy does not provide OpenAI-hosted response state and returns store: false.',
                },
              ]}
            />
            <P>
              <strong className="text-foreground">Key-owned or ignored:</strong>{' '}
              <Code>model</Code>, <Code>temperature</Code>, <Code>top_p</Code>,{' '}
              <Code>max_output_tokens</Code>, and <Code>text.format</Code>.
            </P>
            <CodeTabs
              samples={[
                {
                  label: 'python',
                  code: `from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}", api_key="mw_live_…")

resp = client.responses.create(
    model="sophy",
    input="Write a haiku about gateways.",
)
print(resp.output_text)`,
                },
                {
                  label: 'curl',
                  code: `curl ${BASE_URL}/responses \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"sophy","input":"Write a haiku about gateways."}'`,
                },
              ]}
            />
            <CodeBlock
              label="abridged json"
              code={`{
  "id": "resp_…",
  "object": "response",
  "created_at": 1735689600,
  "status": "completed",
  "model": "anthropic/claude-sonnet-4.6",
  "store": false,
  "output": [{
    "id": "msg_…",
    "type": "message",
    "status": "completed",
    "role": "assistant",
    "content": [{ "type": "output_text", "text": "Silent routes converge…", "annotations": [] }]
  }],
  "usage": {
    "input_tokens": 11,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens": 9,
    "output_tokens_details": { "reasoning_tokens": 0 },
    "total_tokens": 20
  }
}`}
            />
            <P>
              Streaming uses events such as <Code>response.created</Code>,{' '}
              <Code>response.output_text.delta</Code>,{' '}
              <Code>response.function_call_arguments.delta</Code>, and{' '}
              <Code>response.completed</Code>, each with an increasing{' '}
              <Code>sequence_number</Code>. There is no <Code>[DONE]</Code> sentinel.
            </P>
          </Section>

          <Section id="multimodal" title="Multimodal input">
            <P>
              Language keys can send public image/file URLs or URLs returned by{' '}
              <Link href="#files" className="text-primary underline-offset-4 hover:underline">
                <Code>POST /v1/files</Code>
              </Link>
              , provided the bound model supports the content type. Sophy ownership-checks its own
              uploads; public external URLs pass through to the model provider.
            </P>
            <CodeTabs
              samples={[
                {
                  label: 'chat',
                  code: `uploaded_url = "https://…/uploads/<project>/<key>/invoice-….pdf"
uploaded_filename = "invoice.pdf"

resp = client.chat.completions.create(
    model="sophy",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Summarize this document."},
            {
                "type": "file",
                "file": {
                    "file_url": uploaded_url,
                    "filename": uploaded_filename,
                },
            },
        ],
    }],
)`,
                },
                {
                  label: 'responses',
                  code: `uploaded_url = "https://…/uploads/<project>/<key>/photo-….png"

resp = client.responses.create(
    model="sophy",
    input=[{
        "role": "user",
        "content": [
            {"type": "input_text", "text": "What is shown here?"},
            {"type": "input_image", "image_url": uploaded_url},
        ],
    }],
)`,
                },
              ]}
            />
            <Note title="Model support still matters">
              <p>
                The model bound to the key must accept the media you send. The model catalog in the
                console exposes capabilities such as image analysis and file input.
              </p>
            </Note>
            <Note title="Image-input retention">
              <p>
                When content logging is enabled, Sophy retains the exact image value supplied to
                Chat or Responses for seven days, then replaces it with a placeholder in the
                30-day message log. An inline data URL contains the complete submitted bytes; for a
                public external URL, Sophy retains the URL rather than copying content owned by the
                external host. Turning content logging off retains neither form.
              </p>
            </Note>
          </Section>

          <Section id="tools" title="Tool / function calling">
            <P>
              Sophy passes function definitions to the bound language model and maps its requested
              calls back to the selected OpenAI wire format. Sophy never executes a tool. Your
              application runs it, then sends the result and full conversation state on the next
              call.
            </P>
            <CodeTabs
              samples={[
                {
                  label: 'chat',
                  code: `tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

first = client.chat.completions.create(
    model="sophy",
    tools=tools,
    messages=[{"role": "user", "content": "Weather in Paris?"}],
)
call = first.choices[0].message.tool_calls[0]

second = client.chat.completions.create(model="sophy", tools=tools, messages=[
    {"role": "user", "content": "Weather in Paris?"},
    first.choices[0].message,
    {"role": "tool", "tool_call_id": call.id, "content": "18°C, sunny"},
])`,
                },
                {
                  label: 'responses',
                  code: `tools = [{
    "type": "function",
    "name": "get_weather",
    "description": "Get weather for a city",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}]

first = client.responses.create(
    model="sophy",
    tools=tools,
    input="Weather in Paris?",
)
call = next(item for item in first.output if item.type == "function_call")

second = client.responses.create(model="sophy", tools=tools, input=[
    {"role": "user", "content": "Weather in Paris?"},
    {
        "type": "function_call",
        "call_id": call.call_id,
        "name": call.name,
        "arguments": call.arguments,
    },
    {
        "type": "function_call_output",
        "call_id": call.call_id,
        "output": "18°C, sunny",
    },
])`,
                },
              ]}
            />
            <P>
              Only function tools are supported; other Responses tool types are ignored. Chat uses the nested{' '}
              <Code>{'{ type: "function", function: { ... } }'}</Code> shape; Responses uses the
              flat <Code>{'{ type: "function", name, parameters }'}</Code> shape. Legacy Chat{' '}
              <Code>functions</Code> returns <Code>400 functions_unsupported</Code>.
            </P>
            <Note title="Tools and structured output are mutually exclusive">
              <p>
                A key with a JSON Schema rejects <Code>tools</Code> with{' '}
                <Code>400 tools_unsupported</Code> because both features compete for the model’s
                output channel.
              </p>
            </Note>
          </Section>

          <Section id="structured-output" title="Structured output">
            <P>
              An operator can attach a JSON Schema to a language key. Sophy normalizes the schema
              across supported model providers. Buffered calls use constrained generation,
              tolerant JSON extraction and retry, then validate the completed object; streaming
              uses schema-constrained generation with post-hoc validation.
            </P>
            <P>
              The schema lives on the key. Client-sent Chat <Code>response_format</Code> and
              Responses <Code>text.format</Code> do not replace it. Successful JSON is returned as
              the assistant text, so parse <Code>choices[0].message.content</Code> or{' '}
              <Code>response.output_text</Code>.
            </P>
            <Note title="Buffered and streaming failure behavior differs">
              <p>
                A buffered response that still fails validation returns{' '}
                <Code>502 schema_validation_failed</Code>. Streamed bytes cannot be retracted after
                a <Code>200</Code> begins; Sophy records a validation failure after completion, but
                the client may already have received non-conforming text.
              </p>
            </Note>
          </Section>

          <Section id="audio-transcriptions" title="Audio transcription">
            <Method method="POST" path={`${BASE_URL}/audio/transcriptions`} />
            <P>
              Bind the key’s primary model to a transcription model and send audio as{' '}
              <Code>multipart/form-data</Code>. Sophy returns raw text when no processing policy is
              set, or applies centrally managed instructions in a second language-model step and
              returns only that processed text.
            </P>
            <FieldTable
              caption="Audio transcription request fields"
              rows={[
                {
                  name: 'file',
                  type: 'File',
                  note: 'Required, non-empty, and at most 4 MiB (4,194,304 bytes).',
                },
                {
                  name: 'model',
                  type: 'string',
                  note: 'Optional for wire compatibility and ignored. The key’s primary transcription model wins.',
                },
                {
                  name: 'language',
                  type: 'string',
                  note: 'Optional two-letter ISO-639-1 language hint, such as en.',
                },
                {
                  name: 'response_format',
                  type: 'json',
                  note: 'Optional; defaults to json. Other OpenAI transcription formats are not supported in this version.',
                },
                {
                  name: 'advanced transcription options',
                  type: 'unsupported',
                  note: 'Client prompt, temperature, logprobs, stream, timestamps, diarization, include, chunking, and known-speaker fields are rejected with 400 unsupported_transcription_option.',
                },
              ]}
            />
            <P>
              Accepted audio formats are MP3/MPEG/MPGA, MP4/M4A, WAV, WebM, FLAC, and
              OGG. Sophy identifies the format from the file bytes instead of trusting its name
              or client-declared MIME type. Files outside that allowlist return{' '}
              <Code>400 unsupported_audio_format</Code>; files over the limit return{' '}
              <Code>413 file_too_large</Code>.
            </P>
            <CodeTabs
              samples={[
                {
                  label: 'python',
                  code: `from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}", api_key="mw_live_…")

with open("meeting.m4a", "rb") as audio:
    resp = client.audio.transcriptions.create(
        model="sophy",
        file=audio,
        language="en",
        response_format="json",
    )

print(resp.text)`,
                },
                {
                  label: 'curl',
                  code: `curl ${BASE_URL}/audio/transcriptions \\
  -H "Authorization: Bearer mw_live_…" \\
  -F "file=@meeting.m4a" \\
  -F "model=sophy" \\
  -F "language=en" \\
  -F "response_format=json"`,
                },
              ]}
            />
            <CodeBlock
              label="json"
              code={`{
  "text": "Decisions: launch on Friday and send the checklist today.",
  "processed": true,
  "language": "en",
  "duration": 8.4
}`}
            />
            <Note title="Processing policy controls what the client receives">
              <p>
                With a blank key system prompt, <Code>text</Code> and <Code>transcript</Code> are
                identical and <Code>processed</Code> is <Code>false</Code>. With a non-blank system
                prompt, the operator must also set <Code>params.transcriptProcessorModel</Code> to
                a language model. Sophy transcribes first, then applies the key-owned instructions
                to produce <Code>text</Code>. The raw <Code>transcript</Code> field is omitted so a
                client cannot bypass centrally managed processing such as redaction.{' '}
                <Code>language</Code> and <Code>duration</Code> appear only when the transcription
                provider returns them.
              </p>
            </Note>
            <Note title="Compatibility boundary">
              <p>
                This route returns JSON only. Client prompts, temperature, logprobs, streaming,
                timestamp granularities, diarization, chunking, known-speaker hints, subtitle text,
                and verbose transcription formats are not supported in this version.
              </p>
            </Note>
            <P>
              One uploaded clip consumes one RPM slot and counts as one client request. Sophy
              attributes transcription and processing to their actual models, while the processor
              component does not add a second client request. If content logging is enabled on the
              key, Sophy stores the filename, byte count, language hint, raw transcript, and final
              text—but never the audio bytes. Turn content logging off when unprocessed text must
              not be retained.
            </P>
          </Section>

          <Section id="embeddings" title="Embeddings">
            <Method method="POST" path={`${BASE_URL}/embeddings`} />
            <P>
              Bind the key to an embedding model and use the standard OpenAI embeddings method. The
              key-owned model is returned in the response, and usage records input tokens and
              estimated cost.
            </P>
            <FieldTable
              caption="Embeddings request fields"
              rows={[
                {
                  name: 'input',
                  type: 'string | string[]',
                  note: 'Required. One non-empty string or 1–2,048 non-empty strings.',
                },
                {
                  name: 'encoding_format',
                  type: 'float | base64',
                  note: 'Optional; defaults to float. Base64 contains little-endian float32 bytes.',
                },
                {
                  name: 'dimensions',
                  type: 'integer',
                  note: 'Optional, 1–100,000, and supported only for openai/* embedding models. Provider limits may be narrower.',
                },
                {
                  name: 'model',
                  type: 'string',
                  note: 'Ignored. The embedding model bound to the key wins.',
                },
                {
                  name: 'user',
                  type: 'string',
                  note: 'Ignored.',
                },
              ]}
            />
            <P>
              Pre-tokenized integer arrays are not portable across a gateway-bound model and return{' '}
              <Code>400 token_input_unsupported</Code>.
            </P>
            <CodeTabs
              samples={[
                {
                  label: 'python',
                  code: `from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}", api_key="mw_live_…")

resp = client.embeddings.create(
    model="sophy",
    input=["First document", "Second document"],
    encoding_format="float",
)
print(resp.data[0].embedding)`,
                },
                {
                  label: 'curl',
                  code: `curl ${BASE_URL}/embeddings \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "sophy",
    "input": ["First document", "Second document"],
    "encoding_format": "float"
  }'`,
                },
              ]}
            />
            <CodeBlock
              label="json"
              code={`{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.012, -0.044, 0.008] },
    { "object": "embedding", "index": 1, "embedding": [-0.031, 0.017, 0.052] }
  ],
  "model": "openai/text-embedding-3-small",
  "usage": { "prompt_tokens": 5, "total_tokens": 5 }
}`}
            />
          </Section>

          <Section id="images" title="Image generation">
            <Method method="POST" path={`${BASE_URL}/images/generations`} />
            <P>
              Bind the key to a supported image model. Generated images are returned inline as
              base64 and are not stored by Sophy.
            </P>
            <FieldTable
              caption="Image generation request fields"
              rows={[
                {
                  name: 'prompt',
                  type: 'string',
                  note: 'Required and non-empty.',
                },
                {
                  name: 'n',
                  type: 'integer',
                  note: 'Optional, from 1 to 10.',
                },
                {
                  name: 'size',
                  type: 'string',
                  note: 'Optional WIDTHxHEIGHT syntax with 2–5 digits per side, such as 1024x1024; provider support varies.',
                },
                {
                  name: 'response_format',
                  type: 'b64_json',
                  note: 'Optional. b64_json is the only supported format; url is rejected.',
                },
                {
                  name: 'quality / style',
                  type: 'string',
                  note: 'Optional provider-specific options.',
                },
                {
                  name: 'background / output_format',
                  type: 'string',
                  note: 'Optional provider-specific options; unsupported values may be ignored upstream.',
                },
                {
                  name: 'model / user',
                  type: 'string',
                  note: 'Ignored. The image model bound to the key wins.',
                },
              ]}
            />
            <CodeTabs
              samples={[
                {
                  label: 'python',
                  code: `from openai import OpenAI
import base64

client = OpenAI(base_url="${BASE_URL}", api_key="mw_live_…")

resp = client.images.generate(
    model="sophy",
    prompt="A red panda coding at a desk, watercolor",
    n=1,
    size="1024x1024",
)
with open("out.png", "wb") as f:
    f.write(base64.b64decode(resp.data[0].b64_json))`,
                },
                {
                  label: 'curl',
                  code: `curl ${BASE_URL}/images/generations \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"A red panda coding at a desk, watercolor","size":"1024x1024"}'`,
                },
              ]}
            />
            <CodeBlock
              label="json"
              code={`{
  "created": 1735689600,
  "data": [{ "b64_json": "iVBORw0KGgoAAAANSUhEUgAA…" }]
}`}
            />
          </Section>

          <Section id="files" title="Files">
            <Method method="POST" path={`${BASE_URL}/files`} />
            <P>
              Upload a file as <Code>multipart/form-data</Code> using the field name{' '}
              <Code>file</Code>. Success returns <Code>201</Code>. Use the returned URL in a Chat
              file/image part or a Responses <Code>input_file</Code>/<Code>input_image</Code> part.
            </P>
            <P>
              Accepted content types are PDF, PNG, JPEG, WebP, GIF, plain text, CSV, and JSON. The
              maximum size is 4 MiB (4,194,304 bytes). Uploads become eligible for batched cleanup
              after 24 hours, so they are request staging—not durable file storage or a precise
              expiry service.
            </P>
            <CodeBlock
              label="curl"
              code={`curl ${BASE_URL}/files \\
  -H "Authorization: Bearer mw_live_…" \\
  -F "file=@./invoice.pdf"`}
            />
            <CodeBlock
              label="201 json"
              code={`{
  "id": "https://…/uploads/<project>/<key>/invoice-….pdf",
  "url": "https://…/uploads/<project>/<key>/invoice-….pdf",
  "pathname": "uploads/<project>/<key>/invoice-….pdf",
  "filename": "invoice.pdf",
  "bytes": 48213,
  "contentType": "application/pdf"
}`}
            />
            <P>
              Upload URLs are public but unguessable so model providers can fetch them; treat each
              URL as a bearer URL, not a secret store. When a Sophy URL is submitted back through
              the API, Sophy checks its issuing key, and cross-key reuse returns{' '}
              <Code>403 file_access_denied</Code>.
            </P>
          </Section>

          <Section id="models" title="Models">
            <Method method="GET" path={`${BASE_URL}/models`} />
            <P>
              Returns exactly the primary model currently bound to the authenticated key in OpenAI
              list shape. This route does not return the full console catalog or an optional
              transcript processor, and it does not select a model for a later request.
            </P>
            <CodeBlock
              label="json"
              code={`{
  "object": "list",
  "data": [
    {
      "id": "anthropic/claude-sonnet-4.6",
      "object": "model",
      "created": 0,
      "owned_by": "sophy"
    }
  ]
}`}
            />
          </Section>

          <Section id="key-policy" title="Key-owned policy">
            <P>
              The key is Sophy’s unit of configuration. Operators can change its policy without
              changing or redeploying the client. The next request reads the latest values.
            </P>
            <FieldTable
              caption="Configuration stored on a Sophy key"
              rows={[
                {
                  name: 'model',
                  type: 'model id',
                  note: 'One primary model id. Use API routes supported by its catalog capabilities.',
                },
                {
                  name: 'system prompt',
                  type: 'string',
                  note: 'Authoritative prompt for language calls and optional transcript processing. Client prompts are dropped or rejected.',
                },
                {
                  name: 'transcript processor model',
                  type: 'language model id',
                  note: 'Optional params.transcriptProcessorModel. Required when a transcription key has a non-blank system prompt.',
                },
                {
                  name: 'generation params',
                  type: 'object',
                  note: 'Temperature, top-p, and max output tokens for language calls, including transcript processing.',
                },
                {
                  name: 'output schema',
                  type: 'JSON Schema',
                  note: 'Optional structured output policy for language calls.',
                },
                {
                  name: 'knowledgebase',
                  type: 'reference',
                  note: 'Optional grounding source for Chat and Responses.',
                },
                {
                  name: 'RPM / monthly cap',
                  type: 'number',
                  note: 'Optional request-rate and proxy-traffic cost controls.',
                },
                {
                  name: 'content logging',
                  type: 'boolean',
                  note: 'Captures Chat/Responses text and replies, embedding inputs, and transcription text for 30 days. Complete Chat/Responses image input values are discarded after 7 days and replaced by placeholders. Audio bytes and generated images are never stored.',
                },
                {
                  name: 'owner / status',
                  type: 'policy',
                  note: 'Console scope, active/revoked views, rotation, and immediate revocation.',
                },
              ]}
            />
            <P>
              Client values for model and generation parameters are silently ignored. Chat and
              Responses prompt behavior is controlled separately by Agent mode. Audio transcription
              rejects a client <Code>prompt</Code>; only the key-owned system prompt can request
              post-processing.
            </P>
            <P>
              When a language or transcript-processing call has an effective system prompt, Sophy
              prepends a fixed platform security preamble before the key and any applicable
              Agent-mode client instructions. Eligible multi-turn Anthropic requests also receive an
              ephemeral prompt-cache breakpoint; cache reads appear in Responses usage as{' '}
              <Code>cached_tokens</Code>.
            </P>
          </Section>

          <Section id="agent-mode" title="Agent mode">
            <P>
              Standard keys are governed mode: Sophy drops client <Code>system</Code> and{' '}
              <Code>developer</Code> messages plus Responses <Code>instructions</Code>, then uses
              the key-owned prompt.
            </P>
            <P>
              For a trusted server-side agent whose instructions must vary per request, an operator
              can enable <strong className="text-foreground">Agent mode</strong> on the key. Sophy
              keeps the key prompt ahead of client instructions (after Sophy’s fixed security
              preamble), then appends:
            </P>
            <ul className="list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-muted-foreground">
              <li>
                Chat: consecutive leading <Code>system</Code>/<Code>developer</Code> messages, up to
                the first non-system turn.
              </li>
              <li>
                Responses: <Code>instructions</Code>, followed by leading system/developer input
                items.
              </li>
            </ul>
            <P>
              Later system-role items in the conversation are still dropped. Model, generation
              parameters, schema, knowledge, budgets, and rate limits remain key-owned.
            </P>
            <Note title="Trust boundary">
              <p>
                Enable Agent mode only for server-side applications that construct their own
                message array. Client instructions become operator-level input; never forward
                end-user-authored leading system/developer content on an Agent-mode key.
              </p>
            </Note>
          </Section>

          <Section id="knowledgebases" title="Knowledgebases">
            <P>
              Project Admins can manage every project knowledgebase. Editors can create and manage
              knowledgebases they own. Both roles can build them from PDF, DOCX, Markdown, plain
              text, CSV, and JSON documents up to 4 MiB each. Sophy extracts, chunks, and embeds
              sources in the background.
            </P>
            <P>
              Knowledgebases are shareable inside their project. An Admin can attach one to any
              project key, while an Editor can attach one only to a key they own. The same
              collection can ground multiple permitted keys.
            </P>
            <P>
              On Chat or Responses requests with usable user text, Sophy embeds the latest user
              text (capped at its first 8,000 characters), retrieves the six closest chunks, and
              adds them to the effective prompt. Image- or file-only turns have no retrieval query.
              A transient retrieval timeout can continue without grounding. Missing, invalid, or
              billing-blocked project Gateway credentials fail closed before the model call; they
              never fall back to Sophy’s deployment credentials or another project.
            </P>
            <P>
              Knowledgebase ingestion and query-embedding spend is tracked separately from client
              proxy traffic in the console.
            </P>
          </Section>

          <Section id="operator-console" title="Operator console">
            <P>
              One passwordless identity can belong to multiple projects with an independent Admin
              or Editor role in each. The project in the URL is the tenant boundary, and every read,
              mutation, key, knowledgebase, log, evaluation, and audit event stays inside it.
            </P>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                {
                  title: 'Models',
                  body: 'Search and compare the catalog by provider, type, capabilities, context window, and estimated pricing.',
                },
                {
                  title: 'Projects and Gateway access',
                  body: 'Switch projects, choose a personal default, invite members, rename the project, and connect or rotate its encrypted Vercel Gateway credential.',
                },
                {
                  title: 'Sophy keys and knowledge',
                  body: 'Create and manage keys and knowledgebases within your role, then attach project knowledgebases to keys you are allowed to manage.',
                },
                {
                  title: 'Usage and logs',
                  body: 'Filter requests, tokens, estimated cost, latency, model mix, errors, and source-tagged spend.',
                },
                {
                  title: 'Champion vs challenger evals',
                  body: 'Shadow successful live text requests, blind-judge results, and compare quality, cost, latency, and projected impact.',
                },
              ].map((item) => (
                <div key={item.title} className="rounded-xl bg-muted/40 p-4 ring-1 ring-border">
                  <h3 className="font-heading text-base font-medium">{item.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
                </div>
              ))}
            </div>
            <Note title="Evaluation behavior and privacy">
              <p>
                Evals observe eligible successful text requests only; requests containing
                media/file content or supplying tools are skipped. While a run is active,
                replayable sample content is temporarily captured even when normal content logging
                is off, then purged when the run ends. Sophy recommends a winner but never switches
                the key automatically.
              </p>
            </Note>
          </Section>

          <Section id="errors" title="Errors and retries">
            <P>
              Before a response stream starts, Sophy-generated failures use the OpenAI error
              envelope below with <Code>Cache-Control: no-store</Code>. Field validation errors may
              use <Code>code: null</Code> and identify the field in <Code>param</Code>.
            </P>
            <CodeBlock
              label="json"
              code={`{
  "error": {
    "message": "Invalid API key.",
    "type": "authentication_error",
    "param": null,
    "code": "invalid_api_key"
  }
}`}
            />
            <div className="overflow-x-auto rounded-xl ring-1 ring-border">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Named Sophy API error codes</caption>
                <thead className="bg-muted/60">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Type
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Code
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_ROWS.map((row) => (
                    <tr key={row.code} className="border-t align-top">
                      <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-foreground">
                        {row.status}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-muted-foreground">
                        {row.type}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-muted-foreground">
                        {row.code}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{row.when}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <P>
              Upstream client-input rejections (400/413/422) become{' '}
              <Code>400 upstream_invalid_request</Code> with a safe, capped message. Upstream
              rate limits preserve <Code>429</Code> and forward <Code>Retry-After</Code> when
              present. A valid Sophy key whose project credential is missing, disconnected,
              invalid, billing-blocked, or undecryptable receives{' '}
              <Code>503 project_gateway_unavailable</Code>; Sophy makes no fallback upstream call.
              Transient network and server failures are hidden behind <Code>502 upstream_error</Code>.
            </P>
            <Note title="Errors after streaming starts">
              <p>
                Once an SSE response has begun with <Code>200</Code>, a later model failure cannot
                be replaced by a JSON error envelope. Chat still attempts a final{' '}
                <Code>[DONE]</Code> but may lack its normal finish/usage chunks; Responses may omit{' '}
                <Code>response.completed</Code>.
              </p>
            </Note>
          </Section>

          <Section id="rate-limits" title="Rate limits and monthly quota">
            <P>
              Chat, Responses, audio transcription, embeddings, and image generation enforce the
              key’s optional requests-per-minute limit and monthly cost cap before the paid model
              call. <Code>/files</Code> and <Code>/models</Code> do not consume those request
              counters.
            </P>
            <ul className="list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-muted-foreground">
              <li>
                RPM uses a fixed 60-second window. Exceeding it returns{' '}
                <Code>429 rate_limit_exceeded</Code> with <Code>Retry-After</Code> in seconds.
              </li>
              <li>
                Monthly quota uses the current UTC calendar month and counts client-attributable
                spend, including transcript processing. Reaching it returns{' '}
                <Code>402 quota_exceeded</Code>.
              </li>
              <li>
                Evaluation and knowledgebase spend is recorded under separate sources for
                visibility and does not consume a key’s proxy-traffic cap.
              </li>
            </ul>
            <P>
              Console cost values are gateway estimates for operational decisions, not a
              billing-grade ledger.
            </P>
          </Section>

          <div className="rounded-xl bg-muted/50 p-6 ring-1 ring-border">
            <P>
              Need a key or a policy change?{' '}
              <Link href="/admin/login" className="text-primary underline-offset-4 hover:underline">
                Sign in to the Sophy console
              </Link>
              .
            </P>
          </div>
        </div>
      </div>
    </div>
  );
}
