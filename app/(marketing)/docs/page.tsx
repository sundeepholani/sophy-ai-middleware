import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeTabs, CodeBlock } from '@/components/marketing/code-tabs';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'API Reference — Sophy',
  description:
    'Sophy API reference: an OpenAI-compatible gateway at https://sophy.in/v1. Authentication, chat completions, responses, tool calling, models, files, errors, and rate limits.',
};

const BASE_URL = 'https://sophy.in/v1';

const NAV: { id: string; label: string }[] = [
  { id: 'introduction', label: 'Introduction' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'quickstart', label: 'Quickstart' },
  { id: 'chat-completions', label: 'Chat Completions' },
  { id: 'responses', label: 'Responses API' },
  { id: 'tools', label: 'Tool calling' },
  { id: 'models', label: 'Models' },
  { id: 'files', label: 'Files' },
  { id: 'key-behavior', label: 'Key-owned behavior' },
  { id: 'errors', label: 'Errors' },
  { id: 'rate-limits', label: 'Rate limits & quota' },
];

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
          <span className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
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

function FieldTable({
  rows,
}: {
  rows: { name: string; type: string; note: React.ReactNode }[];
}) {
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-muted/60">
          <tr>
            <th className="px-4 py-2.5 font-medium">Field</th>
            <th className="px-4 py-2.5 font-medium">Type</th>
            <th className="px-4 py-2.5 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t align-top">
              <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-foreground">
                {r.name}
              </td>
              <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-muted-foreground">
                {r.type}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ERROR_ROWS: { status: string; type: string; code: string; when: string }[] = [
  { status: '401', type: 'authentication_error', code: 'missing_api_key', when: 'No Authorization header.' },
  { status: '401', type: 'authentication_error', code: 'invalid_api_key', when: 'Key is malformed, unknown, revoked, or expired.' },
  { status: '400', type: 'invalid_request_error', code: 'tools_unsupported', when: 'Tools sent to a key configured for structured output.' },
  { status: '400', type: 'invalid_request_error', code: 'functions_unsupported', when: 'Legacy `functions` parameter used — send `tools` instead.' },
  { status: '400', type: 'invalid_request_error', code: 'stateful_unsupported', when: '`previous_response_id` used — Sophy is stateless.' },
  { status: '403', type: 'invalid_request_error', code: 'file_access_denied', when: 'Referencing a file uploaded by a different key.' },
  { status: '413', type: 'invalid_request_error', code: 'file_too_large', when: 'Upload exceeds the 4 MB limit.' },
  { status: '429', type: 'rate_limit_error', code: 'rate_limit_exceeded', when: 'Per-key requests-per-minute limit hit (see Retry-After).' },
  { status: '402', type: 'insufficient_quota', code: 'quota_exceeded', when: 'Monthly cost cap for the key reached.' },
  { status: '502', type: 'api_error', code: 'schema_validation_failed', when: 'Model output failed the key’s JSON Schema.' },
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
    model="sophy",   # ignored — the key owns the model
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
  model: "sophy",   // ignored — the key owns the model
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
      {/* Sidebar */}
      <aside className="hidden lg:block">
        <nav className="sticky top-24 space-y-1">
          <p className="px-3 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            On this page
          </p>
          {NAV.map((item) => (
            <Link
              key={item.id}
              href={`#${item.id}`}
              className="block rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Content */}
      <div className="min-w-0 max-w-3xl space-y-12">
        <header className="space-y-3">
          <h1 className="font-heading text-4xl font-semibold tracking-tight">API Reference</h1>
          <P>
            Sophy speaks the OpenAI API. Point any OpenAI SDK at{' '}
            <Code>{BASE_URL}</Code> with your Sophy key and your existing code works unchanged.
          </P>
        </header>

        <Section id="introduction" title="Introduction">
          <P>
            Sophy is an OpenAI-compatible gateway. Each key carries its own model, system prompt,
            parameters, optional JSON Schema, and optional knowledgebase — all server-side. You send
            requests in the OpenAI wire format; Sophy resolves the configuration from your key,
            routes to the model through the Vercel AI Gateway, and accounts for usage.
          </P>
          <P>
            <strong className="text-foreground">You send:</strong> messages / input, whether to{' '}
            <Code>stream</Code>, and (optionally) <Code>tools</Code>.{' '}
            <strong className="text-foreground">The key owns:</strong> the model, system prompt, and
            generation parameters — so any <Code>model</Code>, <Code>system</Code> message,{' '}
            <Code>temperature</Code>, <Code>top_p</Code>, or <Code>max_tokens</Code> you send is
            silently overridden.
          </P>
          <Method method="BASE URL" path={BASE_URL} />
        </Section>

        <Section id="authentication" title="Authentication">
          <P>
            Authenticate with your Sophy key in the <Code>Authorization</Code> header as a bearer
            token. Keys look like <Code>mw_live_…</Code> and are issued in the{' '}
            <Link href="/admin/login" className="text-primary underline-offset-4 hover:underline">
              operator console
            </Link>{' '}
            — there is no self-serve signup.
          </P>
          <CodeBlock label="header" code={`Authorization: Bearer mw_live_…`} />
          <P>
            A missing key returns <Code>401 missing_api_key</Code>; an invalid, revoked, or expired
            key returns <Code>401 invalid_api_key</Code>. Revocation is immediate — the key is
            validated against the database on every request.
          </P>
        </Section>

        <Section id="quickstart" title="Quickstart">
          <P>Change two lines — the base URL and the API key — and make your first call.</P>
          <CodeTabs samples={QUICKSTART_SAMPLES} />
        </Section>

        <Section id="chat-completions" title="Chat Completions">
          <Method method="POST" path={`${BASE_URL}/chat/completions`} />
          <P>The standard OpenAI Chat Completions surface. Honored request fields:</P>
          <FieldTable
            rows={[
              { name: 'messages', type: 'array', note: 'Required. The conversation. user / assistant / tool roles are kept; system messages are dropped (the key owns the prompt).' },
              { name: 'stream', type: 'boolean', note: <>Optional. Stream the response as SSE chunks.</> },
              { name: 'stream_options', type: 'object', note: <>Optional. <Code>{`{ include_usage: true }`}</Code> adds a final usage chunk.</> },
              { name: 'tools', type: 'array', note: <>Optional. Function tool definitions, passed through to the model. See <Link href="#tools" className="text-primary underline-offset-4 hover:underline">Tool calling</Link>.</> },
              { name: 'tool_choice', type: 'string | object', note: <><Code>auto</Code>, <Code>none</Code>, <Code>required</Code>, or <Code>{`{ type: "function", function: { name } }`}</Code>.</> },
            ]}
          />
          <P>
            <strong className="text-foreground">Ignored (key-owned):</strong> <Code>model</Code>,{' '}
            <Code>system</Code> messages, <Code>temperature</Code>, <Code>top_p</Code>,{' '}
            <Code>max_tokens</Code>.
          </P>
          <h3 className="font-heading pt-2 text-lg font-medium">Response</h3>
          <CodeBlock
            label="json"
            code={`{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1735689600,
  "model": "anthropic/claude-sonnet-4.6",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello! How can I help?" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 9, "completion_tokens": 7, "total_tokens": 16 }
}`}
          />
          <h3 className="font-heading pt-2 text-lg font-medium">Streaming</h3>
          <P>
            With <Code>stream: true</Code>, Sophy emits OpenAI <Code>chat.completion.chunk</Code>{' '}
            events as <Code>data:</Code> lines, terminated by a <Code>data: [DONE]</Code> sentinel.
          </P>
          <CodeBlock
            label="stream"
            code={`data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]`}
          />
        </Section>

        <Section id="responses" title="Responses API">
          <Method method="POST" path={`${BASE_URL}/responses`} />
          <P>
            The OpenAI Responses surface, for clients using <Code>client.responses.create(...)</Code>
            . Send the full <Code>input</Code> each call — Sophy is{' '}
            <strong className="text-foreground">stateless</strong>, so{' '}
            <Code>previous_response_id</Code> is rejected with{' '}
            <Code>400 stateful_unsupported</Code>. As on the chat surface, the key owns the model and{' '}
            <Code>instructions</Code>.
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
  -d '{ "model": "sophy", "input": "Write a haiku about gateways." }'`,
              },
            ]}
          />
          <P>
            Streaming uses typed SSE events (<Code>response.created</Code>,{' '}
            <Code>response.output_text.delta</Code>, <Code>response.completed</Code>, …), each with an
            incrementing <Code>sequence_number</Code>. There is no <Code>[DONE]</Code> sentinel — the
            stream ends at <Code>response.completed</Code>.
          </P>
        </Section>

        <Section id="tools" title="Tool / function calling">
          <P>
            Sophy passes your tool definitions to the model and returns the model’s tool calls — it
            never executes tools. Your client runs the function and sends the result back on the next
            turn (the standard OpenAI tool loop). Works on both Chat Completions and the Responses
            API.
          </P>
          <CodeBlock
            label="python"
            code={`tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

# 1) Model decides to call the tool → finish_reason == "tool_calls"
first = client.chat.completions.create(model="sophy", tools=tools,
    messages=[{"role": "user", "content": "Weather in Paris?"}])
call = first.choices[0].message.tool_calls[0]

# 2) You run the tool, then send the result back
second = client.chat.completions.create(model="sophy", tools=tools, messages=[
    {"role": "user", "content": "Weather in Paris?"},
    first.choices[0].message,
    {"role": "tool", "tool_call_id": call.id, "content": "18°C, sunny"},
])
print(second.choices[0].message.content)`}
          />
          <P>
            Tool calling is mutually exclusive with structured output: a key configured with a JSON
            Schema rejects <Code>tools</Code> with <Code>400 tools_unsupported</Code>. The legacy
            top-level <Code>functions</Code> parameter is not supported (<Code>400
            functions_unsupported</Code>) — use <Code>tools</Code>.
          </P>
        </Section>

        <Section id="models" title="Models">
          <Method method="GET" path={`${BASE_URL}/models`} />
          <P>
            Returns the single model bound to your key, in OpenAI list shape. (The model is chosen on
            the key, not per request.)
          </P>
          <CodeBlock
            label="json"
            code={`{
  "object": "list",
  "data": [
    { "id": "anthropic/claude-sonnet-4.6", "object": "model", "created": 0, "owned_by": "sophy" }
  ]
}`}
          />
        </Section>

        <Section id="files" title="Files">
          <Method method="POST" path={`${BASE_URL}/files`} />
          <P>
            Upload an image or document as <Code>multipart/form-data</Code> (field name{' '}
            <Code>file</Code>) and reference the returned URL in a multimodal request. Limits: max{' '}
            <strong className="text-foreground">4 MB</strong>; allowed types are PDF, PNG, JPEG, WebP,
            GIF, plain text, CSV, and JSON. Uploads are scoped to the issuing key — referencing
            another key’s file returns <Code>403 file_access_denied</Code>.
          </P>
          <CodeBlock
            label="curl"
            code={`curl ${BASE_URL}/files \\
  -H "Authorization: Bearer mw_live_…" \\
  -F "file=@./invoice.pdf"`}
          />
          <CodeBlock
            label="json"
            code={`{
  "id": "https://…/uploads/<key>/invoice.pdf",
  "url": "https://…/uploads/<key>/invoice.pdf",
  "filename": "invoice.pdf",
  "bytes": 48213,
  "contentType": "application/pdf"
}`}
          />
        </Section>

        <Section id="key-behavior" title="Key-owned behavior">
          <P>
            Three things are configured on the key and applied automatically — you do not control
            them per request:
          </P>
          <ul className="space-y-3 text-[15px] text-muted-foreground">
            <li>
              <strong className="text-foreground">Model, prompt &amp; parameters.</strong> The key
              owns the model, system prompt, temperature, top-p, and max output tokens. Client-sent
              values for these are ignored, so an operator can repoint a model or revise a prompt
              without any client change.
            </li>
            <li>
              <strong className="text-foreground">Structured output.</strong> If the key has a JSON
              Schema attached, every response is validated against it and returned as JSON. Output
              that fails validation returns <Code>502 schema_validation_failed</Code>.
            </li>
            <li>
              <strong className="text-foreground">Knowledgebase grounding.</strong> If the key has a
              knowledgebase attached, Sophy retrieves the most relevant snippets for each request and
              folds them into the system prompt automatically — your request body stays the same.
            </li>
          </ul>
        </Section>

        <Section id="errors" title="Errors">
          <P>
            Errors use the OpenAI envelope. All error responses are sent with{' '}
            <Code>Cache-Control: no-store</Code>.
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
              <thead className="bg-muted/60">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Code</th>
                  <th className="px-4 py-2.5 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {ERROR_ROWS.map((r) => (
                  <tr key={r.code} className="border-t align-top">
                    <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-foreground">
                      {r.status}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-muted-foreground">
                      {r.type}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-muted-foreground">
                      {r.code}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="rate-limits" title="Rate limits & quota">
          <P>
            Each key has a requests-per-minute limit and an optional monthly cost cap, both enforced
            at the gateway. Exceeding the rate limit returns <Code>429 rate_limit_exceeded</Code> with
            a <Code>Retry-After</Code> header (seconds). Reaching the monthly cost cap returns{' '}
            <Code>402 quota_exceeded</Code>. Limits are configured per key in the console.
          </P>
        </Section>

        <div className={cn('rounded-xl bg-muted/50 p-6 ring-1 ring-border')}>
          <P>
            Need a key or a configuration change?{' '}
            <Link href="/admin/login" className="text-primary underline-offset-4 hover:underline">
              Sign in to the console
            </Link>
            .
          </P>
        </div>
      </div>
    </div>
  );
}
