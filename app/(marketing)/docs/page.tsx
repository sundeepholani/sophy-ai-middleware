import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeTabs, CodeBlock } from '@/components/marketing/code-tabs';

export const metadata: Metadata = {
  title: 'Docs — Sophy',
  description:
    'Sophy documentation for its console and CLI, email-code sign-in, project-owned Vercel AI Gateway and Cloudflare Workers AI credentials, AI APIs, key policy, knowledgebases, evaluation and extraction models, errors, and limits.',
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
      { id: 'evaluate', label: 'Evaluation models' },
      { id: 'extract', label: 'Extraction models (preview)' },
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
      { id: 'operator-sign-in', label: 'Operator sign-in' },
    ],
  },
  {
    label: 'Sophy CLI',
    items: [
      { id: 'sophy-cli', label: 'Install and sign in' },
      { id: 'cli-key-instructions', label: 'Update key instructions' },
      { id: 'cli-agents', label: 'Use with coding agents' },
      { id: 'cli-reference', label: 'Commands and API' },
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
      <div className="mt-1 space-y-2 text-muted-foreground">{children}</div>
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
    code: 'model_not_language',
    when: 'Chat Completions or Responses was called with a known non-language key model.',
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
    code: 'model_not_evaluation',
    when: 'Evaluation was requested with a key whose model is known not to be an evaluation model, including Clairic and unsupported `@cf/` models.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'missing_state',
    when: '`/evaluate` was called without a `state` to judge, or `/extract` with an empty or missing `state` and no images.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'state_too_large',
    when: '`state` exceeds 200,000 characters (counted after JSON serialization on `/evaluate`), or a Cloudflare model’s request is estimated above its context window.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'missing_questions',
    when: '`/evaluate` was called without a `questions` object.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_questions',
    when: 'Evaluate `questions` was sent as something other than an object.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'questions_empty',
    when: 'Evaluate `questions` contained no entries.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'too_many_questions',
    when: 'Evaluate `questions` contained more than 32 entries.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_question',
    when: 'An entry in evaluate `questions` is not an object.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'missing_instructions',
    when: 'An evaluate question has no non-empty `instructions` string.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_question_type',
    when: 'An evaluate question `type` is not `boolean`, `choice`, or `score`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_criteria',
    when: 'An evaluate question’s `criteria` does not match the shape its type requires, or breaks a Clef limit: at most 255 choice options, each with a non-empty id, and at most 10 score levels.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_question_id',
    when: 'A question name on a Clef key is not 1–100 letters, digits, `_`, `.`, or `-`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_provider_options',
    when: 'Evaluate `providerOptions` is not an object, addresses a namespace other than the key model’s provider, or was sent to a Clef key.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_media_field',
    when: 'A Clef evaluate or an extract request sent a top-level `images`, `audio`, or `videos` field; send images in `assets`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'assets_not_supported',
    when: 'Evaluate `assets` was sent on a key whose model is neither TypeSafe Jev nor Cloudflare Clef.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_assets',
    when: '`assets` is not an object, or has no entries.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'too_many_assets',
    when: '`assets` has more than 8 entries on a TypeSafe Jev key, or more than 4 for a Cloudflare model.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_asset_key',
    when: 'An asset key is not 1–64 letters, digits, `_`, or `-`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_asset',
    when: 'An asset entry is not an object with `type: "image"`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_asset_format',
    when: 'An asset `format` is not `png`, `jpg`, or `jpeg` (TypeSafe Jev), or not one of those or `webp` (Cloudflare models).',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_asset_data',
    when: 'An asset’s `data_base64` is empty or not standard padded base64 (no `data:` prefix, no whitespace).',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'asset_format_mismatch',
    when: 'An asset’s bytes are not the PNG, JPEG, or WebP image its `format` declares.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'asset_too_large',
    when: 'One image for a Cloudflare model exceeds 4 MiB once decoded.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'assets_too_large',
    when: 'Images for a Cloudflare model exceed 8 MiB in total once decoded.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unreferenced_asset',
    when: 'A TypeSafe Jev asset key does not appear anywhere in `state` or the questions.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'model_not_extraction',
    when: '`/extract` was called with a key whose model is not a supported extraction model (Clairic).',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_state',
    when: 'Extract `state` was a number, boolean, object, or array instead of a string.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'missing_fields',
    when: '`/extract` was called without a `fields` object.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_fields',
    when: 'Extract `fields` was sent as something other than an object.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'fields_empty',
    when: 'Extract `fields` contained no entries.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'too_many_fields',
    when: 'Extract `fields` contained more than 64 entries.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_field_name',
    when: 'An extract field name is not a letter or `_` followed by at most 63 letters, digits, `_`, `.`, or `-`.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'unsupported_field_type',
    when: 'An extract field `type` is missing or not text, number, date, time, datetime, duration, list, estimate, or forecast.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_field',
    when: 'An extract field spec is not an object, has an unknown setting or a value of the wrong type or range, or lacks `items` (list) or `min` and `max` (estimate, forecast).',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_reference_date',
    when: 'Extract `reference_date` is not a real `YYYY-MM-DD` date.',
  },
  {
    status: '400',
    type: 'invalid_request_error',
    code: 'invalid_options',
    when: 'Extract `options` is not an object, or has anything but boolean `include_quantiles` and `return_state_text`.',
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
    status: '402',
    type: 'insufficient_quota',
    code: 'insufficient_quota',
    when: 'Cloudflare Workers AI answered HTTP 402 for the project’s Cloudflare account. A Vercel AI Gateway credit or budget failure instead marks the credential billing-blocked and returns 503 `project_gateway_unavailable`, and a used-up Cloudflare daily free allocation returns 429 `rate_limit_exceeded`.',
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
    when: 'A transient upstream network or server failure occurred, or the model provider failed or returned an unusable response.',
  },
  {
    status: '503',
    type: 'api_error',
    code: 'project_gateway_unavailable',
    when: 'The key is valid, but its project has no usable credential for the key model’s provider: Vercel AI Gateway, or Cloudflare Workers AI for `@cf/` models.',
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
              configuration, calls the bound model with the project-owned credential for that
              model’s provider — the project’s Vercel AI Gateway credential, or its Cloudflare
              Workers AI credential for Cloudflare models — and records project-attributed usage.
            </P>
            <P>
              Compatibility is intentionally scoped. Chat Completions and Responses cover text,
              streaming, multimodal input, and function-tool loops. Dedicated routes cover
              audio transcription, embeddings, image generation, short-lived file uploads, and the
              primary model bound to a key. Evaluation and extraction models are reached through
              native Sophy routes rather than an OpenAI client method. The sections below call out
              differences from the full OpenAI platform.
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
                    ['POST', '/evaluate', 'Evaluation', 'Native route; no OpenAI client method reaches it'],
                    ['POST', '/extract', 'Extraction', 'Native route (preview); no OpenAI client method reaches it'],
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
              . The console and CLI use email codes for operator sign-in. A verified email can
              create a renameable <Code>My Project</Code> or accept an Admin invitation.
            </P>
            <CodeBlock label="header" code="Authorization: Bearer mw_live_…" />
            <P>
              Missing Bearer authentication returns <Code>401 missing_api_key</Code>. A malformed,
              unknown, revoked, expired, or inactive-project key returns{' '}
              <Code>401 invalid_api_key</Code>.
              Keys are checked against the database on every request, so edits and revocation apply
              immediately.
            </P>
            <div id="provider-credentials" className="scroll-mt-24">
              <Note title="Sophy keys and provider credentials">
                <p>
                  A Sophy API key authenticates your application to Sophy. A Project Admin
                  separately connects the provider credentials that pay for and route the project’s
                  AI calls: a Vercel AI Gateway key, which every project needs before it can create
                  Sophy keys, and an optional Cloudflare Workers AI credential for Cloudflare’s Clef
                  and Clairic models. Sophy never returns a stored provider secret.
                </p>
                <p>
                  To connect Cloudflare Workers AI, a Project Admin enters the project’s
                  32-character Cloudflare account ID and an API token created from Cloudflare’s
                  “Workers AI” token template in project Settings, or runs{' '}
                  <Code>sophy cloudflare connect</Code> (Sophy CLI 0.3.0 or later). Sophy checks
                  the pair with one account-scoped Cloudflare call that runs no model, stores the
                  token encrypted, and shows only its last four characters. Binding a key to a
                  Cloudflare model requires that credential to be healthy, and those keys use only
                  it — never the Vercel key, and never a Sophy-owned Cloudflare account.
                </p>
              </Note>
            </div>
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
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 7,
    "total_tokens": 16,
    "prompt_tokens_details": { "cached_tokens": 0 }
  }
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

          <Section id="evaluate" title="Evaluation models">
            <Method method="POST" path={`${BASE_URL}/evaluate`} />
            <P>
              Evaluation models are not exposed through the OpenAI-compatible client methods, so
              call this native Sophy route directly with an HTTP client. Bind the key to an
              evaluation model — one from the Vercel AI Gateway catalog, such as TypeSafe Jev, or
              one of Cloudflare’s Clef models — send the <Code>state</Code> to judge together with
              a named set of typed questions, and Sophy returns one answer per question plus token
              usage.
            </P>
            <P>
              Questions are judged against the same shared state, so keep each one self-contained.
              The call is a single buffered round trip; there is no streaming.
            </P>
            <FieldTable
              caption="Evaluate request fields"
              rows={[
                {
                  name: 'state',
                  type: 'string | object | array',
                  note: 'Required. The shared material every question is asked about. At most 200,000 characters once serialized as JSON.',
                },
                {
                  name: 'questions',
                  type: 'object',
                  note: 'Required. Maps your own question names to question objects, 1–32 entries. Every question needs a non-empty instructions string and a type of boolean, choice, or score. On Clef keys, names must be 1–100 letters, digits, "_", "." or "-".',
                },
                {
                  name: 'providerOptions',
                  type: 'object',
                  note: 'Optional provider-specific knobs, namespaced by provider. Only the namespace matching the key model’s provider is accepted. Clef keys accept no providerOptions.',
                },
                {
                  name: 'assets',
                  type: 'object',
                  note: 'Optional, for TypeSafe Jev (typesafe-ai/jev-1.13.0 and later) and Cloudflare Clef keys. Maps an asset key to { "type": "image", "format", "data_base64" }. Jev: 1–8 PNG or JPEG images; put each key in state, an instruction or criteria to refer to its image. Clef: 1–4 PNG, JPEG or WebP images, no reference needed (see Cloudflare Clef models below).',
                },
                {
                  name: 'model',
                  type: 'string',
                  note: 'Ignored. The evaluation model bound to the key wins and is echoed in the response.',
                },
              ]}
            />
            <h3 className="font-heading pt-2 text-lg font-medium">Question types and answers</h3>
            <FieldTable
              caption="Evaluate answer shapes"
              rows={[
                {
                  name: 'boolean',
                  type: 'probability',
                  note: 'criteria is optional; when present it must supply string true and false descriptions. Answers as { "type": "boolean", "probability" }.',
                },
                {
                  name: 'choice',
                  type: 'choice, probabilities',
                  note: 'criteria is an object mapping at least two option names to non-empty string descriptions (at most 255 options on Clef keys). Answers as { "type": "choice", "choice", "probabilities" }, one probability per option, plus "confidence" (0–1) when the model returns one.',
                },
                {
                  name: 'score',
                  type: 'score, probabilities',
                  note: 'criteria is an array of at least two non-empty string labels ordered lowest to highest (at most 10 on Clef keys). Answers as { "type": "score", "score", "probabilities" }, plus "confidence" when the model returns one. probabilities maps each level index, from "0" for the lowest label, to its probability; score is probability-weighted, so it can fall between levels.',
                },
              ]}
            />
            <P>
              Requests are validated before any paid call. Missing or oversized state returns{' '}
              <Code>400 missing_state</Code> or <Code>400 state_too_large</Code>; a bad question
              set returns <Code>400 missing_questions</Code>, <Code>400 invalid_questions</Code>,{' '}
              <Code>400 questions_empty</Code>, <Code>400 too_many_questions</Code>,{' '}
              <Code>400 invalid_question</Code>, <Code>400 missing_instructions</Code>,{' '}
              <Code>400 unsupported_question_type</Code>, or <Code>400 invalid_criteria</Code>.
              Out-of-namespace knobs return <Code>400 unsupported_provider_options</Code>, and a
              key whose model is known to be something other than an evaluation model — including
              Clairic and any unsupported <Code>@cf/</Code> model — returns{' '}
              <Code>400 model_not_evaluation</Code>. Clef keys add the checks described below.
            </P>
            <CodeTabs
              samples={[
                {
                  label: 'python',
                  code: `import httpx

resp = httpx.post(
    "${BASE_URL}/evaluate",
    headers={"Authorization": "Bearer mw_live_…"},
    json={
        "state": {
            "question": "How do I reset my password?",
            "answer": "Open Settings and use the reset link we email you.",
        },
        "questions": {
            "grounded": {
                "type": "boolean",
                "instructions": "Is the answer supported by the question?",
            },
            "tone": {
                "type": "choice",
                "instructions": "Classify the tone of the answer.",
                "criteria": {
                    "formal": "Professional and impersonal.",
                    "casual": "Friendly and conversational.",
                },
            },
            "helpfulness": {
                "type": "score",
                "instructions": "Rate how helpful the answer is.",
                "criteria": ["useless", "partial", "complete"],
            },
        },
    },
    timeout=120,
)
print(resp.json()["answers"])`,
                },
                {
                  label: 'curl',
                  code: `curl ${BASE_URL}/evaluate \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "state": "Q: How do I reset my password? A: Open Settings and use the reset link.",
    "questions": {
      "grounded": {
        "type": "boolean",
        "instructions": "Is the answer supported by the question?"
      },
      "tone": {
        "type": "choice",
        "instructions": "Classify the tone of the answer.",
        "criteria": {
          "formal": "Professional and impersonal.",
          "casual": "Friendly and conversational."
        }
      },
      "helpfulness": {
        "type": "score",
        "instructions": "Rate how helpful the answer is.",
        "criteria": ["useless", "partial", "complete"]
      }
    }
  }'`,
                },
              ]}
            />
            <CodeBlock
              label="json"
              code={`{
  "model": "typesafe-ai/jev",
  "answers": {
    "grounded": { "type": "boolean", "probability": 0.93 },
    "tone": {
      "type": "choice",
      "choice": "casual",
      "probabilities": { "formal": 0.18, "casual": 0.82 }
    },
    "helpfulness": {
      "type": "score",
      "score": 1.71,
      "probabilities": { "0": 0.04, "1": 0.21, "2": 0.75 }
    }
  },
  "usage": { "inputTokens": 412, "outputTokens": 36, "totalTokens": 448 }
}`}
            />
            <h3 className="font-heading pt-2 text-lg font-medium">Images (TypeSafe Jev)</h3>
            <P>
              Keys bound to TypeSafe Jev 1.13.0 or later can send still images in{' '}
              <Code>assets</Code>. Give each image a key, then use that key as a value in{' '}
              <Code>state</Code> and refer to it by its state name in your questions. Images
              must be PNG or JPEG, base64-encoded with no <Code>data:</Code> prefix,
              280–1,568 pixels on each side, and already rotated upright (EXIF orientation is
              not applied). The whole request must stay under 4.5 MB. TypeSafe still labels image
              input experimental, so validate results before you depend on them.
            </P>
            <CodeBlock
              label="curl"
              code={`curl ${BASE_URL}/evaluate \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "state": { "selfie": "selfie-1" },
    "assets": {
      "selfie-1": { "type": "image", "format": "jpg", "data_base64": "/9j/4AAQ…" }
    },
    "questions": {
      "groomed": {
        "type": "score",
        "instructions": "Rate the grooming of the person in \`selfie\`.",
        "criteria": ["poor", "acceptable", "good"]
      }
    }
  }'`}
            />
            <Note title="No TypeSafe header needed">
              <p>
                TypeSafe’s own API requires a <Code>TypeSafe-Danger-Zone-Images: true</Code>{' '}
                header on every image request. On Sophy, the <Code>assets</Code> field is the
                opt-in: when a request includes it, Sophy adds that header upstream for you.
                Sophy doesn’t forward client headers, so sending the TypeSafe header to Sophy has
                no effect.
              </p>
              <p>
                Images only reach the model through <Code>assets</Code>. Base64 pasted into{' '}
                <Code>state</Code> or a question arrives as plain text, and the model can’t see
                it. TypeSafe’s <Code>box</Code> question type (image location, Jev 1.14) is not
                supported yet; use <Code>boolean</Code>, <Code>choice</Code>, or{' '}
                <Code>score</Code>.
              </p>
            </Note>
            <P>
              Bad image input is rejected before any paid call with{' '}
              <Code>400 assets_not_supported</Code>, <Code>400 invalid_assets</Code>,{' '}
              <Code>400 too_many_assets</Code>, <Code>400 invalid_asset_key</Code>,{' '}
              <Code>400 invalid_asset</Code>, <Code>400 unsupported_asset_format</Code>,{' '}
              <Code>400 invalid_asset_data</Code>, <Code>400 asset_format_mismatch</Code>, or{' '}
              <Code>400 unreferenced_asset</Code>. An image the model rejects, for example one
              outside the size range, returns <Code>400 upstream_invalid_request</Code> with
              TypeSafe’s message.
            </P>
            <h3 className="font-heading pt-2 text-lg font-medium">Cloudflare Clef models</h3>
            <P>
              Keys can also bind Cloudflare Workers AI’s Clef decision models. Sophy calls them
              with the project’s own{' '}
              <Link href="#provider-credentials" className="text-primary underline-offset-4 hover:underline">
                Cloudflare Workers AI credential
              </Link>
              , never through Vercel AI Gateway, so a Vercel AI Gateway outage doesn’t stop them.
              Send the same request as for any evaluation model: Sophy picks Cloudflare’s model
              selector from the key, sends <Code>boolean</Code> questions as Cloudflare’s{' '}
              <Code>noul</Code> type, and maps answers and usage back to the shape above.
            </P>
            <ul className="list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-muted-foreground">
              <li>
                <Code>@cf/cloudflare/clef</Code> — Clef, context window 65,536 tokens.
              </li>
              <li>
                <Code>@cf/cloudflare/clef-flash</Code> — Clef Flash, context window 24,576 tokens.
              </li>
              <li>
                <Code>@cf/cloudflare/clef-omni</Code> — Clef Omni, context window 65,536 tokens.
              </li>
            </ul>
            <P>
              Sophy sends these models text and images only. Cloudflare’s video input, and Clef
              Omni’s audio input, are not supported yet.
            </P>
            <P>
              Clef keys add Cloudflare’s limits to the checks above, still before any paid call.
              Question names must be 1–100 letters, digits, <Code>_</Code>, <Code>.</Code>, or{' '}
              <Code>-</Code>. Choice questions take 2–255 options and score questions 2–10 levels.{' '}
              <Code>providerOptions</Code> is not accepted. Sophy also estimates the request size
              the way Cloudflare does — the JSON it sends upstream, without images, at four
              characters per token — and returns <Code>400 state_too_large</Code> when the
              estimate exceeds the model’s context window: about 98,000 characters of JSON on
              Clef Flash, while on Clef and Clef Omni the 200,000-character state limit usually
              applies first.
            </P>
            <P>
              Dense text such as logs can use about two characters per token, so a request under
              the estimate can still exceed the model’s real limit. In testing, Clef and Clef Flash
              rejected such requests instead of shortening the state, and Sophy returns{' '}
              <Code>400 upstream_invalid_request</Code> with Cloudflare’s message, such as
              “Request requires 100819 tokens; the maximum is 65529”. Clef Omni’s limit is also its
              context window, and over-long input is expected to be rejected the same way, but that
              hasn’t been verified. Keep the state well inside the context window.
            </P>
            <CodeBlock
              label="curl"
              code={`curl ${BASE_URL}/evaluate \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "state": "Support ticket #4821 from a retail customer: our checkout page has returned HTTP 500 errors for every customer since 09:10 UTC. We are losing roughly $2,000 per minute in sales. Please escalate immediately.",
    "questions": {
      "urgent": {
        "type": "boolean",
        "instructions": "Is this support request urgent?",
        "criteria": {
          "true": "Needs action within the hour",
          "false": "Can wait in the normal queue"
        }
      },
      "team": {
        "type": "choice",
        "instructions": "Which team should handle this request?",
        "criteria": {
          "billing": "Payments, invoices, and refunds",
          "technical": "Outages, errors, and configuration",
          "sales": "Plans and upgrades"
        }
      },
      "severity": {
        "type": "score",
        "instructions": "How severe is the customer impact?",
        "criteria": ["No impact", "Minor", "Major", "Critical"]
      }
    }
  }'`}
            />
            <CodeBlock
              label="json"
              code={`{
  "model": "@cf/cloudflare/clef",
  "answers": {
    "urgent": { "type": "boolean", "probability": 0.8998 },
    "team": {
      "type": "choice",
      "choice": "technical",
      "probabilities": { "billing": 0.0605, "technical": 0.931, "sales": 0.0085 },
      "confidence": 0.8058
    },
    "severity": {
      "type": "score",
      "score": 2.9603,
      "probabilities": { "0": 0.0035, "1": 0.0035, "2": 0.0222, "3": 0.9708 },
      "confidence": 0.9239
    }
  },
  "usage": { "inputTokens": 381, "outputTokens": 0, "totalTokens": 381 }
}`}
            />
            <P>
              Clef keys can send up to four still images in <Code>assets</Code>, in the same keyed
              shape as Jev: PNG, JPEG, or WebP, base64-encoded with no <Code>data:</Code> prefix,
              at most 4 MiB each and 8 MiB in total once decoded. Cloudflare also limits each image
              to 16 megapixels, which Sophy doesn’t check. The whole request must still stay under
              4.5 MB, which binds first. Clef sees every image before the state, in the key order of{' '}
              <Code>assets</Code>; as in JavaScript, keys that are plain whole numbers, such as{' '}
              <Code>2</Code>, come first in numeric order. An image key doesn’t need to appear in
              the state or a question, and Sophy doesn’t swap a key for its image, so refer to
              images by position, such as “the first image”.
            </P>
            <CodeBlock
              label="curl"
              code={`curl ${BASE_URL}/evaluate \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "state": "Ticket #4821: checkout has returned HTTP 500 for every customer since 09:10 UTC. The first image is a screenshot from the customer.",
    "assets": {
      "screenshot": { "type": "image", "format": "png", "data_base64": "iVBORw0KGgo…" }
    },
    "questions": {
      "error_page": {
        "type": "boolean",
        "instructions": "Does the first image show an error page?"
      }
    }
  }'`}
            />
            <Note title="Coming from Cloudflare’s API">
              <p>
                Send Sophy’s shape rather than Cloudflare’s: <Code>boolean</Code> instead of{' '}
                <Code>noul</Code>, which returns <Code>400 unsupported_question_type</Code>, and
                images in <Code>assets</Code> instead of <Code>images</Code>. A <Code>model</Code>{' '}
                field is ignored, because the key selects the model and Sophy sends Cloudflare’s
                selector itself. A top-level <Code>images</Code>, <Code>audio</Code>, or{' '}
                <Code>videos</Code> field returns <Code>400 unsupported_media_field</Code>.
                Responses aren’t wrapped in Cloudflare’s <Code>result</Code> envelope, usage is
                camelCase, and score answers omit Cloudflare’s <Code>legend</Code>; read each level
                from the probability keys.
              </p>
              <p>
                Sophy accepts a strict subset of Cloudflare’s question shapes. Instructions, choice
                descriptions, and score labels must be non-empty strings. Cloudflare’s{' '}
                <Code>null</Code>, object, and array forms return{' '}
                <Code>400 missing_instructions</Code> or <Code>400 invalid_criteria</Code>, so
                replace a <Code>null</Code> description with a short sentence.
              </p>
            </Note>
            <P>
              Bad Clef input is rejected before any paid call with{' '}
              <Code>400 invalid_question_id</Code>, <Code>400 invalid_criteria</Code>,{' '}
              <Code>400 unsupported_provider_options</Code>,{' '}
              <Code>400 unsupported_media_field</Code>, <Code>400 invalid_assets</Code>,{' '}
              <Code>400 too_many_assets</Code>, <Code>400 invalid_asset_key</Code>,{' '}
              <Code>400 invalid_asset</Code>, <Code>400 unsupported_asset_format</Code>,{' '}
              <Code>400 invalid_asset_data</Code>, <Code>400 asset_format_mismatch</Code>,{' '}
              <Code>400 asset_too_large</Code>, <Code>400 assets_too_large</Code>, or{' '}
              <Code>400 state_too_large</Code>. A project without a healthy Cloudflare credential
              returns <Code>503 project_gateway_unavailable</Code>, even when its Vercel AI Gateway
              credential is healthy. A Cloudflare account on the Workers Free plan that has used
              its daily free allocation returns <Code>429 rate_limit_exceeded</Code> until 00:00
              UTC, and Sophy doesn’t retry it.
            </P>
            <P>
              One evaluate call consumes one RPM slot and is checked against the key’s monthly cost
              cap before the paid model call. When content logging is enabled on the key, Sophy
              stores the evaluated state, the questions, and the returned answers. For images it
              logs only each one’s format and size, never the image itself. Clef calls are priced
              from Cloudflare’s reported usage; see{' '}
              <Link href="#rate-limits" className="text-primary underline-offset-4 hover:underline">
                Limits and quota
              </Link>
              .
            </P>
            <Note title="Compatibility boundary">
              <p>
                This is a native Sophy route, not an OpenAI-compatible one: no OpenAI SDK method
                reaches evaluation models, so send plain HTTP. The client-sent <Code>model</Code>{' '}
                is accepted and ignored — the evaluation model bound to the key wins. Responses are
                buffered only, and upstream <Code>providerMetadata</Code> and Clef’s{' '}
                <Code>legend</Code> are not echoed back.
              </p>
            </Note>
          </Section>

          <Section id="extract" title="Extraction models (preview)">
            <Method method="POST" path={`${BASE_URL}/extract`} />
            <Note title="Research preview">
              <p>
                Extraction runs on Cloudflare’s Clairic (<Code>@cf/cloudflare/clairic</Code>),
                which Cloudflare ships as a research preview. Sophy validates every request before
                the paid call but passes each answer through exactly as Clairic returns it, so
                answer fields can change between Clairic releases. As Cloudflare puts it, every
                answer is well formed, not necessarily correct: use <Code>confidence</Code>,{' '}
                <Code>p_null</Code>, and the <Code>p10</Code>–<Code>p90</Code> interval to decide
                what to automate and what to send to review.
              </p>
            </Note>
            <P>
              Extraction models read text and images and return typed values — text, numbers,
              dates, times, durations, lists, estimates, and forecasts — instead of free text. Like
              evaluation models, they are not exposed through the OpenAI-compatible client methods,
              so call this native Sophy route with an HTTP client. Bind the key to Clairic, send
              the <Code>state</Code> to read together with named, typed <Code>fields</Code>, and
              Sophy returns one answer per field plus token usage.
            </P>
            <P>
              Calls use the project’s own{' '}
              <Link href="#provider-credentials" className="text-primary underline-offset-4 hover:underline">
                Cloudflare Workers AI credential
              </Link>
              , never Vercel AI Gateway. The call is a single buffered round trip; there is no
              streaming.
            </P>
            <FieldTable
              caption="Extract request fields"
              rows={[
                {
                  name: 'state',
                  type: 'string',
                  note: 'The text to read, at most 200,000 characters counted as UTF-16 code units (JavaScript string length, so an emoji counts as two), and within the context-window estimate described below. Required unless assets carries images; with images it may be "" or omitted. Objects and arrays are not accepted: serialize them first.',
                },
                {
                  name: 'fields',
                  type: 'object',
                  note: 'Required. Maps your own field names to field specs, 1–64 entries. A name starts with a letter or "_" and has at most 64 letters, digits, "_", "." or "-". Answers come back under the same names.',
                },
                {
                  name: 'assets',
                  type: 'object',
                  note: 'Optional. 1–4 images in the same keyed shape and limits as Clef keys on /evaluate: PNG, JPEG or WebP, at most 4 MiB each and 8 MiB in total once decoded, no reference needed.',
                },
                {
                  name: 'reference_date',
                  type: 'string',
                  note: 'Optional ISO date (YYYY-MM-DD) that anchors dates written without a year. Sophy never fills it in, and the model does not know when the request runs, so send it whenever a field depends on today’s date.',
                },
                {
                  name: 'options',
                  type: 'object',
                  note: 'Optional. include_quantiles (boolean) adds all 99 percentiles to estimates. return_state_text (boolean) adds state_text, the text that spans index into. No other keys.',
                },
                {
                  name: 'model',
                  type: 'string',
                  note: 'Ignored. The extraction model bound to the key wins and is echoed in the response.',
                },
              ]}
            />
            <h3 className="font-heading pt-2 text-lg font-medium">Field types</h3>
            <FieldTable
              caption="Extract field types"
              rows={[
                { name: 'text', type: 'string', note: 'Text copied from the input, with its span.' },
                { name: 'number', type: 'number', note: 'A number, read or computed from the input. Optional unit, integer, and decimals.' },
                { name: 'date', type: 'string', note: 'An ISO date such as 2026-10-29.' },
                { name: 'time', type: 'string', note: 'A time of day such as 14:05:00.' },
                { name: 'datetime', type: 'string', note: 'An ISO date and time such as 2026-10-19T14:05:00, with no time zone.' },
                { name: 'duration', type: 'number', note: 'A length of time in unit: seconds (the default), minutes, hours, days, weeks, months, or years.' },
                { name: 'list', type: 'array', note: 'Every matching value, in input order. Requires items: text, number, or date. Empty when nothing matches.' },
                { name: 'estimate', type: 'distribution', note: 'A prediction inside min and max, returned as a distribution. Requires min and max (numbers, or ISO dates for a date estimate); optional step and scale.' },
                { name: 'forecast', type: 'distribution[]', note: 'Future values of a series, one per step. Requires numeric min and max; optional horizon, interval, and scale.' },
              ]}
            />
            <P>
              Each field spec has a <Code>type</Code> and may add any of these settings; a setting
              not listed here returns <Code>400 invalid_field</Code>.
            </P>
            <FieldTable
              caption="Extract field settings"
              rows={[
                { name: 'type', type: 'string', note: 'Required. One of the nine types above.' },
                { name: 'instructions', type: 'string', note: 'What the field should contain, for example “Amount due including the surcharge”.' },
                { name: 'unit', type: 'string', note: 'A non-empty unit label such as USD. Duration fields accept only seconds, minutes, hours, days, weeks, months, or years.' },
                { name: 'integer', type: 'boolean', note: 'Numbers and durations: return a whole number.' },
                { name: 'decimals', type: 'integer', note: 'Numbers, durations, and number lists: round to 0–6 decimal places.' },
                { name: 'items', type: 'string', note: 'Lists: text, number, or date. Required for lists.' },
                { name: 'min / max', type: 'number | date', note: 'Required for estimates and forecasts, with min below max; ISO dates only for a date estimate. Optional numbers on other types.' },
                { name: 'step', type: 'number | string', note: 'Estimates: the grid, a positive number (days for a date estimate); "month" or "year" only on a date estimate.' },
                { name: 'scale', type: 'string', note: 'Estimates and forecasts: linear or log.' },
                { name: 'null_threshold', type: 'number', note: 'Greater than 0 and at most 1 (Clairic’s default is 0.5). When the probability that the input does not determine the field exceeds it, value is null.' },
                { name: 'horizon', type: 'integer', note: 'Forecasts: the number of steps, 1–64.' },
                { name: 'interval', type: 'string', note: 'Forecasts: step, minute, hour, day, week, month, quarter, or year.' },
              ]}
            />
            <P>
              Requests are validated before any paid call. A key whose model is not an extraction
              model, a Clef key included, returns <Code>400 model_not_extraction</Code>. A bad body
              returns <Code>400 invalid_state</Code>, <Code>400 missing_state</Code>,{' '}
              <Code>400 state_too_large</Code>, <Code>400 missing_fields</Code>,{' '}
              <Code>400 invalid_fields</Code>, <Code>400 fields_empty</Code>,{' '}
              <Code>400 too_many_fields</Code>, <Code>400 invalid_field_name</Code>,{' '}
              <Code>400 unsupported_field_type</Code>, <Code>400 invalid_field</Code>,{' '}
              <Code>400 invalid_reference_date</Code>, or <Code>400 invalid_options</Code>, and{' '}
              <Code>param</Code> names the problem, such as <Code>fields.total.decimals</Code>.
              Field specs may use only the settings above. Sophy checks each setting’s type and
              range, requires <Code>items</Code> for lists and <Code>min</Code> and{' '}
              <Code>max</Code> for estimates and forecasts, and leaves the rest to Clairic, whose
              rejections return <Code>400 upstream_invalid_request</Code> with its message.
            </P>
            <P>
              Sophy also estimates the request size the way Cloudflare does — the JSON it sends
              upstream, meaning the state and field specs without images, at four characters per
              token — and returns <Code>400 state_too_large</Code> when the estimate exceeds
              Clairic’s 65,536-token context window, about 262,000 characters of JSON. JSON writes
              each newline, tab, quote, and backslash as two characters (other control characters
              as six), so a newline-dense series, tab- or quote-heavy CSV/TSV, or serialized JSON
              can reach that limit below 200,000 characters.
            </P>
            <CodeTabs
              samples={[
                {
                  label: 'python',
                  code: `import httpx

resp = httpx.post(
    "${BASE_URL}/extract",
    headers={"Authorization": "Bearer mw_live_…"},
    json={
        "state": (
            "Invoice INV-7731 from Blue Harbor Logistics. Issued 14 Oct. Net 15. "
            "Freight: 3 pallets at $410.00 each; fuel surcharge $57.50. "
            "Contacts: Meera Iyer, Tom Okafor."
        ),
        "reference_date": "2026-10-20",
        "fields": {
            "invoice_number": {"type": "text", "instructions": "Invoice number"},
            "total": {
                "type": "number",
                "unit": "USD",
                "decimals": 2,
                "instructions": "Amount due including the surcharge",
            },
            "due_date": {"type": "date", "instructions": "Issue date plus the net payment days"},
            "contacts": {"type": "list", "items": "text", "instructions": "Contact person names"},
            "po_number": {"type": "text", "instructions": "Purchase order number"},
            "days_to_pay": {
                "type": "estimate",
                "min": 0,
                "max": 90,
                "step": 1,
                "instructions": "Days after issue until this invoice is paid",
            },
        },
    },
    timeout=120,
)
print(resp.json()["answers"])`,
                },
                {
                  label: 'curl',
                  code: `curl ${BASE_URL}/extract \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "state": "Invoice INV-7731 from Blue Harbor Logistics. Issued 14 Oct. Net 15. Freight: 3 pallets at $410.00 each; fuel surcharge $57.50. Contacts: Meera Iyer, Tom Okafor.",
    "reference_date": "2026-10-20",
    "fields": {
      "invoice_number": { "type": "text", "instructions": "Invoice number" },
      "total": { "type": "number", "unit": "USD", "decimals": 2, "instructions": "Amount due including the surcharge" },
      "due_date": { "type": "date", "instructions": "Issue date plus the net payment days" },
      "contacts": { "type": "list", "items": "text", "instructions": "Contact person names" },
      "po_number": { "type": "text", "instructions": "Purchase order number" },
      "days_to_pay": { "type": "estimate", "min": 0, "max": 90, "step": 1, "instructions": "Days after issue until this invoice is paid" }
    }
  }'`,
                },
              ]}
            />
            <CodeBlock
              label="json"
              code={`{
  "model": "@cf/cloudflare/clairic",
  "answers": {
    "invoice_number": {
      "type": "text",
      "p_null": 0.0001,
      "span": [8, 16],
      "guess": "INV-7731",
      "confidence": 1,
      "value": "INV-7731"
    },
    "total": {
      "type": "number",
      "p_null": 0.0003,
      "guess": 1287.5,
      "confidence": 0.8683,
      "value": 1287.5
    },
    "due_date": {
      "type": "date",
      "p_null": 0.00001,
      "guess": "2026-10-29",
      "confidence": 0.9999,
      "value": "2026-10-29"
    },
    "contacts": {
      "type": "list",
      "value": ["Meera Iyer", "Tom Okafor"],
      "spans": [[137, 147], [149, 159]],
      "confidence": 0.9708
    },
    "po_number": {
      "type": "text",
      "p_null": 0.999999,
      "span": [8, 16],
      "guess": "INV-7731",
      "confidence": 0.9993,
      "value": null
    },
    "days_to_pay": {
      "type": "estimate",
      "value": 18,
      "mean": 17.58,
      "median": 16,
      "p10": 13,
      "p90": 25,
      "p_below": 0.000009,
      "p_above": 0.000009
    }
  },
  "truncated": false,
  "usage": { "inputTokens": 715, "outputTokens": 0, "totalTokens": 715 }
}`}
            />
            <h3 className="font-heading pt-2 text-lg font-medium">Reading answers</h3>
            <FieldTable
              caption="Extract answer shapes"
              rows={[
                { name: 'text', type: 'value, span', note: 'value is the text found in the input, or null; span is its [start, end) offset pair. Also guess, p_null, and confidence.' },
                { name: 'number, duration', type: 'value', note: 'A number, or null. Duration answers also carry unit. Also guess, p_null, and confidence.' },
                { name: 'date, time, datetime', type: 'value', note: 'An ISO string such as 2026-10-29, 14:05:00, or 2026-10-19T14:05:00, or null. Also guess, p_null, and confidence.' },
                { name: 'list', type: 'value', note: 'An array, empty when nothing matches, with an overall confidence. Number and date lists add confidences, one per item; text lists add spans, one per item.' },
                { name: 'estimate', type: 'value, distribution', note: 'value plus mean, median, an 80% interval from p10 to p90, p_below, and p_above; value can differ from median. include_quantiles adds quantiles, all 99 percentiles.' },
                { name: 'forecast', type: 'arrays, steps', note: 'value, median, p10, and p90 are arrays with one entry per step; steps holds one estimate per step.' },
              ]}
            />
            <FieldTable
              caption="Extract response fields"
              rows={[
                { name: 'model', type: 'string', note: 'The extraction model bound to the key.' },
                { name: 'answers', type: 'object', note: 'One answer per requested field, keyed by your field names, passed through from Clairic.' },
                { name: 'truncated', type: 'boolean', note: 'Clairic’s truncation flag; false unless Clairic reports true.' },
                { name: 'state_text', type: 'string', note: 'Only when options.return_state_text is true: the text that spans index into.' },
                { name: 'usage', type: 'object', note: 'inputTokens, outputTokens, and totalTokens. Clairic may read the state more than once (the example above used 3 passes), and inputTokens counts every pass, so cost isn’t predictable from the field count alone.' },
              ]}
            />
            <Note title="Three rules for reading answers">
              <p>
                Spans are end-exclusive offsets counted in Unicode code points, not bytes or UTF-16
                units. In Python, <Code>state[start:end]</Code> returns the text. In JavaScript,
                use <Code>{"Array.from(state).slice(start, end).join('')"}</Code>, because{' '}
                <Code>state.slice(start, end)</Code> drifts after an emoji or any other character
                outside the Basic Multilingual Plane. Set <Code>options.return_state_text</Code> to
                receive the exact text the spans index into.
              </p>
              <p>
                When <Code>value</Code> is <Code>null</Code>, ignore <Code>guess</Code> and{' '}
                <Code>span</Code>, even when <Code>confidence</Code> is high: the model found that
                the input doesn’t determine the field, and the guess can point at unrelated text.
                In the example above, an invoice with no PO number returns its invoice number as
                the PO guess. <Code>p_null</Code> is the probability that the input doesn’t
                determine the field.
              </p>
              <p>
                List answers can carry <Code>confidences</Code>, one per item in{' '}
                <Code>value</Code>, alongside the list’s overall <Code>confidence</Code>; check
                each item before you use it. Text lists carry per-item <Code>spans</Code> instead.
              </p>
            </Note>
            <h3 className="font-heading pt-2 text-lg font-medium">Images</h3>
            <P>
              Send up to four still images in <Code>assets</Code>, exactly as for Clef keys on{' '}
              <Link href="#evaluate" className="text-primary underline-offset-4 hover:underline">
                evaluate
              </Link>
              : PNG, JPEG, or WebP, base64-encoded with no <Code>data:</Code> prefix, at most 4 MiB
              each and 8 MiB in total once decoded, and a whole request under 4.5 MB. Clairic sees
              them before the state, in key order, and no reference is needed. With images,{' '}
              <Code>state</Code> may be empty or omitted. A top-level <Code>images</Code>,{' '}
              <Code>audio</Code>, or <Code>videos</Code> field returns{' '}
              <Code>400 unsupported_media_field</Code>, and bad images return the same asset codes
              as Clef keys.
            </P>
            <CodeBlock
              label="curl"
              code={`curl ${BASE_URL}/extract \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "assets": {
      "receipt": { "type": "image", "format": "jpg", "data_base64": "/9j/4AAQ…" }
    },
    "fields": {
      "merchant": { "type": "text", "instructions": "Store name" },
      "paid": { "type": "number", "unit": "USD", "decimals": 2, "instructions": "Total paid" },
      "paid_on": { "type": "date", "instructions": "Purchase date" }
    }
  }'`}
            />
            <P>
              One extract call consumes one RPM slot and is checked against the key’s monthly cost
              cap before the paid model call; its cost is estimated as described in{' '}
              <Link href="#rate-limits" className="text-primary underline-offset-4 hover:underline">
                Limits and quota
              </Link>
              . When content logging is enabled on the key, Sophy stores the state, the field
              specs, the reference date and options, and the returned answers. For images it logs
              only each one’s format and size, and it never logs <Code>state_text</Code>. A
              project without a healthy Cloudflare credential returns{' '}
              <Code>503 project_gateway_unavailable</Code>, even when its Vercel AI Gateway
              credential is healthy. A Cloudflare account on the Workers Free plan that has used
              its daily free allocation returns <Code>429 rate_limit_exceeded</Code> until 00:00
              UTC, and Sophy doesn’t retry it.
            </P>
            <Note title="Compatibility boundary">
              <p>
                This is a native Sophy route, not an OpenAI-compatible one, and not Cloudflare’s
                REST shape either: send plain HTTP with your Sophy key, put images in{' '}
                <Code>assets</Code>, and read <Code>answers</Code> directly — there is no{' '}
                <Code>result</Code> envelope. The client-sent <Code>model</Code> is accepted and
                ignored; the extraction model bound to the key wins. Responses are buffered only,
                and Clairic’s per-pass usage breakdown is not echoed back.
              </p>
            </Note>
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
                  note: 'Captures Chat/Responses text and replies, embedding inputs, transcription text, and evaluate and extract requests and answers for 30 days. Complete Chat/Responses image input values are discarded after 7 days and replaced by placeholders. Evaluate and extract images are logged as format and size only. Audio bytes and generated images are never stored.',
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
              Agent-mode client instructions. On Anthropic models, Chat and Responses requests mark
              that system prompt (with any tools) as an ephemeral prompt-cache breakpoint, so
              requests on the same key within the cache window re-read it instead of paying full
              input price; knowledgebase context is sent after the breakpoint so it doesn’t break
              the shared prefix. Multi-turn requests on keys without a knowledgebase also mark the
              latest message, caching the conversation so far. Prompts shorter than the model’s
              cacheable minimum are not cached. Cache reads appear in usage as{' '}
              <Code>prompt_tokens_details.cached_tokens</Code> (Chat) and{' '}
              <Code>input_tokens_details.cached_tokens</Code> (Responses).
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
                  body: 'Search and compare the catalog — Vercel AI Gateway models plus Cloudflare’s Clef and Clairic models — by provider, type, capabilities, context window, and estimated pricing.',
                },
                {
                  title: 'Projects and provider access',
                  body: 'Switch projects, choose a personal default, invite members, rename the project, and connect, rotate, or disconnect its encrypted Vercel AI Gateway and Cloudflare Workers AI credentials.',
                },
                {
                  title: 'Sophy keys and knowledge',
                  body: 'Create and manage keys and knowledgebases within your role, then attach project knowledgebases to keys you are allowed to manage.',
                },
                {
                  title: 'Usage and logs',
                  body: 'Filter usage and request logs by key. Track requests, tokens, estimated cost, latency, model mix, errors, and source-tagged spend.',
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
            <Note title="Champion/challenger run behavior and privacy">
              <p>
                Evals observe eligible successful text requests only; requests containing
                media/file content or supplying tools are skipped. While a run is active,
                replayable sample content is temporarily captured even when normal content logging
                is off, then purged when the run ends. Sophy recommends a winner but never switches
                the key automatically.
              </p>
            </Note>
          </Section>

          <Section id="operator-sign-in" title="Operator sign-in with email codes">
            <P>
              The console and CLI use the same email identity. Sophy sends a six-digit one-time
              password (OTP) to your inbox. Each code expires after 10 minutes and permits at most
              five attempts. A successful attempt consumes the code.
            </P>
            <P>
              Sign-in links no longer authenticate an account. Invitation links identify the
              invitation, but acceptance requires sign-in with the matching email account.
            </P>
            <Method method="POST" path="/api/admin/login" />
            <CodeBlock label="request" code={'{ "email": "operator@example.com" }'} />
            <CodeBlock label="response" code={'{ "ok": true, "challengeId": "<challenge-id>" }'} />
            <P>
              This response does not reveal whether an account exists. Email delivery and
              verification are subject to rate limits. When Sophy issues a new code, it invalidates
              the previous code for that email. The optional <Code>next</Code> field preserves a
              local invitation path through sign-in.
            </P>
            <P>
              Code requests require 60 seconds between deliveries. Each email permits five codes
              per 15 minutes and 10 per hour. Each IP permits 10 requests per 15 minutes for each
              sign-in endpoint. Sign-in JSON bodies permit at most 4 KiB.
            </P>
            <Method method="POST" path="/api/admin/login/verify" />
            <FieldTable
              caption="Email code verification fields"
              rows={[
                { name: 'challengeId', type: 'string', note: 'Required. The challengeId from the code request.' },
                { name: 'code', type: 'string', note: 'Required. The six digits from the email, including any leading zero.' },
                { name: 'client', type: 'web | cli', note: 'Required. Selects a browser cookie or a CLI session token.' },
                { name: 'next', type: 'string', note: 'Optional local return path for the web flow. External URLs are not allowed.' },
              ]}
            />
            <CodeBlock
              label="CLI request"
              code={'{ "challengeId": "<challenge-id>", "code": "012345", "client": "cli" }'}
            />
            <P>
              For <Code>web</Code>, verification sets the browser session cookie and returns the
              next local path. For <Code>cli</Code>, it returns <Code>token</Code>,{' '}
              <Code>expiresAt</Code>, and <Code>user</Code>. A CLI session expires 30 days after
              its last use: each authenticated management request extends it to 30 days from that
              request, so a CLI in regular use stays signed in. Each request checks the current
              account, project membership, and project status.
            </P>
            <Method method="POST" path="/api/admin/cli/logout" />
            <P>
              Send the CLI token in the <Code>Authorization: Bearer</Code> header to revoke that
              session. The CLI removes its local session after a successful logout.
            </P>
            <P>
              Sign-in endpoints return <Code>{'{ "error": "code" }'}</Code> on errors.
              Malformed verification requests return <Code>400 invalid_request</Code>.
              Invalid emails return <Code>400 invalid_email</Code>. Invalid, used, or expired codes
              return <Code>401 invalid_or_expired_code</Code>. Request limits return{' '}
              <Code>429 too_many_attempts</Code>. An invalid CLI logout token returns{' '}
              <Code>401 unauthorized</Code>.
            </P>
          </Section>

          <Section id="sophy-cli" title="Sophy CLI">
            <P>
              Manage Sophy from a terminal or a coding agent that can run terminal commands.
              The CLI uses the same project roles and resource ownership as the console.
              Admins manage project resources. Editors manage the keys and knowledgebases they own.
            </P>
            <P>
              Install the public{' '}
              <a
                href="https://www.npmjs.com/package/@sophyai/sophy-cli"
                className="text-primary underline-offset-4 hover:underline"
              >
                @sophyai/sophy-cli npm package
              </a>
              . A source checkout is not required.
            </P>
            <P>Use Node.js 22 or newer. Install the CLI from npm:</P>
            <CodeBlock
              label="terminal"
              code={`npm install -g @sophyai/sophy-cli
sophy --help`}
            />
            <P>To run a command without a global installation, use <Code>npx</Code>:</P>
            <CodeBlock
              label="terminal"
              code={`npx --package @sophyai/sophy-cli sophy --help
npx --package @sophyai/sophy-cli sophy login --email operator@example.com`}
            />
            <P>
              The following examples use the installed <Code>sophy</Code> command.
              With <Code>npx</Code>, prefix each command with{' '}
              <Code>npx --package @sophyai/sophy-cli</Code>.
            </P>
            <P>Sign in with your email. Then choose a project from your project list:</P>
            <CodeBlock
              label="terminal"
              code={`sophy login --email operator@example.com
sophy whoami
sophy projects list
sophy projects use <project-id>
sophy keys list`}
            />
            <P>
              Enter the six-digit email code at the hidden login prompt. The default server is{' '}
              <Code>https://sophy.in</Code>. The installed command and <Code>npx</Code> use the same
              local session. The <Code>--project</Code> flag selects a project for one command.
              Run <Code>sophy logout</Code> to revoke the session.
            </P>
            <P>
              For development from a source checkout, run <Code>npm install -g ./cli</Code> from
              the repository root.
            </P>
          </Section>

          <Section id="cli-key-instructions" title="Update key instructions">
            <P>
              The <Code>systemPrompt</Code> field stores the instructions for a key.
              An update applies to subsequent requests with that key. Read the current settings
              before you change them:
            </P>
            <CodeBlock
              label="terminal"
              code={`sophy keys get <key-id> --project <project-id> --json`}
            />
            <P>For a short instruction, use the <Code>--system-prompt</Code> flag:</P>
            <CodeBlock
              label="terminal"
              code={`sophy keys update <key-id> --project <project-id> \\
  --system-prompt "Answer support questions using the attached knowledgebase."`}
            />
            <P>
              For longer instructions, save a JSON file named <Code>key-instructions.json</Code>.
              Use <Code>\n</Code> for line breaks inside the JSON string:
            </P>
            <CodeBlock
              label="key-instructions.json"
              code={`{
  "systemPrompt": "You are the support assistant.\\nUse the attached knowledgebase.\\nIf the answer is unavailable, say so."
}`}
            />
            <P>Apply the file. Then read the key again to confirm the saved instructions:</P>
            <CodeBlock
              label="terminal"
              code={`sophy keys update <key-id> --project <project-id> \\
  --data @key-instructions.json --json
sophy keys get <key-id> --project <project-id> --json`}
            />
            <Note title="Change only the fields you intend to change">
              An update preserves omitted settings. The example changes only <Code>systemPrompt</Code>.
              A supplied <Code>params</Code> object replaces all existing parameters.
              For a parameter change, include every parameter you want to retain.
              JSON <Code>null</Code> clears the system prompt.
            </Note>
          </Section>

          <Section id="cli-agents" title="Use Sophy with coding agents">
            <P>
              A coding agent can use the CLI through its terminal. Commands run with the account
              signed in to that environment. A remote agent needs its own login in its environment.
              Your browser session or another computer&apos;s CLI session does not sign in that agent.
            </P>
            <P>
              Use <Code>--json</Code> for compact JSON output. Use <Code>--data @file.json</Code> for
              nested input or long prompts. Project roles and resource ownership still apply to
              every command. Admin-only changes remain restricted to project admins.
            </P>
            <P>Copy these instructions into a task for your coding agent:</P>
            <CodeBlock
              label="Agent instructions"
              code={`Use the Sophy CLI for this task.

1. Run sophy --help, then sophy keys update --help to read the supported fields.
2. Run sophy whoami --json. If sign-in is required, ask me to complete
   sophy login in this environment. Do not copy a session from another machine.
3. Run sophy projects list --json. Use the project ID and key ID I identify.
   Include --project <project-id> on every project command.
4. Before editing, run:
   sophy keys get <key-id> --project <project-id> --json
5. Put only the requested changes in changes.json. Use systemPrompt for instructions.
   Preserve omitted settings. If changing params, include all parameters to retain.
6. Apply the changes:
   sophy keys update <key-id> --project <project-id> --data @changes.json --json
7. Read the key again with keys get. Confirm the requested changes and preserved settings.
   Report the saved result. Treat any nonzero exit code as incomplete work.
8. Use --yes only for an action I explicitly authorized. Do not include secrets in reports.`}
            />
            <P>
              The CLI returns exit code <Code>1</Code> for errors. Exit code <Code>2</Code> means
              a bulk action skipped items or a key update requires evaluation-stop confirmation.
              The JSON result identifies the incomplete work.
            </P>
          </Section>

          <Section id="cli-reference" title="CLI commands and management API">
            <P>Discover commands, command groups, and input fields through the built-in help:</P>
            <CodeBlock
              label="terminal"
              code={`sophy --help
sophy keys --help
sophy keys update --help`}
            />
            <FieldTable
              caption="CLI management coverage"
              rows={[
                { name: 'keys', type: 'management', note: 'List, create, edit, rotate, and revoke. Change models or start evaluations in bulk.' },
                { name: 'key settings', type: 'policy', note: 'Set the model, prompt, parameters, schema, logging, RPM limit, knowledgebase, and transcript processor. Admins also control budgets and ownership.' },
                { name: 'projects / gateway', type: 'management', note: 'List, create, rename, and select projects. Admins connect or disconnect the project Gateway credential.' },
                { name: 'cloudflare', type: 'management', note: 'Admins connect, replace, or disconnect the project Cloudflare Workers AI credential. The API token is read only from a file or stdin. Editors see only its connection state and whether it is ready.' },
                { name: 'members / invitations', type: 'admin only', note: 'Manage project membership, roles, and pending invitations.' },
                { name: 'settings', type: 'admin only', note: 'Read or update the project judge model and notification email.' },
                { name: 'knowledgebases', type: 'management', note: 'Create and remove collections. List, upload, retry, and remove documents within your access.' },
                { name: 'evals / models / usage / logs', type: 'operations', note: 'Run or cancel evaluations. Read results, the model catalog, usage, and request logs within your access, overall or for one key.' },
              ]}
            />
            <P>
              The CLI accepts credential secrets only from a file or standard input, never as
              command-line arguments. Put <Code>{'{"accountId": "…", "apiToken": "…"}'}</Code> in
              a file and run <Code>sophy cloudflare connect --data @cloudflare.json</Code>, or pipe
              it with <Code>--data -</Code>. You can pass the account ID as{' '}
              <Code>--account-id</Code> instead and keep only the token in the JSON. The Vercel AI
              Gateway key uses <Code>sophy gateway connect</Code> the same way, with{' '}
              <Code>{'{"apiKey": "…"}'}</Code>. The <Code>cloudflare</Code> commands require
              @sophyai/sophy-cli 0.3.0 or later.
            </P>
            <P>
              Sophy checks the Cloudflare account ID and token with Cloudflare before it saves
              them, and a failed check leaves the current credential in place. A failed
              connection returns one of these errors:
            </P>
            <ul className="list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-muted-foreground">
              <li>
                <Code>400 cloudflare_invalid_account_id</Code>: Enter the 32-character Cloudflare
                account ID.
              </li>
              <li>
                <Code>400 cloudflare_invalid</Code>:{' '}
                {'The Cloudflare account ID or API token was rejected. Create the token from Cloudflare\'s "Workers AI" template.'}
              </li>
              <li>
                <Code>503 cloudflare_unreachable</Code>: Cloudflare could not be reached to validate
                the credential. Try again.
              </li>
              <li>
                <Code>409 cloudflare_in_use</Code>: This Cloudflare API token is already in use by
                another project.
              </li>
            </ul>
            <P>
              Creating a key for a Cloudflare model, or changing a key to one, returns{' '}
              <Code>409 cloudflare_not_ready</Code> (“Connect a healthy project Cloudflare
              credential first.”) until that credential is ready. An unsupported{' '}
              <Code>@cf/</Code> model returns <Code>400 invalid_request</Code> with the message
              “Unsupported Cloudflare Workers AI model”.
            </P>
            <P>
              Key creation and rotation show the new secret once. Sophy cannot return an existing
              secret. Rotation and revocation require confirmation.
            </P>
            <P>
              To read one key&apos;s recent traffic, supply its ID. The command returns the key&apos;s
              100 most recent logs from every log source, newest first. Add <Code>--source</Code>{' '}
              or a smaller <Code>--limit</Code> to narrow the list:
            </P>
            <CodeBlock
              label="terminal"
              code={`sophy logs list --key-id <key-id> --project <project-id> --json
sophy logs get <log-id> --project <project-id> --json`}
            />
            <P>
              A log list contains metadata. <Code>logs get</Code> returns one log with any retained
              content. Admins can read logs for any key in the project, and editors for the keys
              they own. Any other key returns <Code>404 not_found</Code>. The management API takes
              the key as <Code>keyId</Code> in the <Code>logs.list</Code> input.
            </P>
            <Method method="POST" path="/api/admin/cli" />
            <P>
              The management API requires a CLI session token in the <Code>Authorization: Bearer</Code>{' '}
              header. Browser cookies and application API keys cannot authenticate this route.
              CLI tokens cannot authenticate the AI routes under <Code>/v1</Code>.
            </P>
            <FieldTable
              caption="CLI management request fields"
              rows={[
                { name: 'operation', type: 'string', note: 'Required. An operation name, such as keys.list.' },
                { name: 'projectId', type: 'UUID', note: 'Required for project operations. The server checks your active membership.' },
                { name: 'input', type: 'object', note: 'Operation-specific fields. The server validates types and rejects unknown fields.' },
              ]}
            />
            <CodeBlock
              label="management request"
              code={'{ "operation": "keys.list", "projectId": "<project-id>", "input": {} }'}
            />
            <CodeBlock
              label="success"
              code={'{ "ok": true, "data": [], "sessionExpiresAt": "2026-11-21T09:30:00.000Z" }'}
            />
            <CodeBlock
              label="error"
              code={'{ "error": { "code": "forbidden", "message": "Your current project role or resource ownership does not allow this action." } }'}
            />
            <P>
              <Code>sessionExpiresAt</Code> is the session&apos;s current expiry after this
              request&apos;s renewal. The server records renewals at most once a day, so it can
              trail the request time plus 30 days by up to one day. Logout and revoked or expired
              sessions are never renewed.
            </P>
            <P>
              Management responses use <Code>Cache-Control: no-store</Code>. Access decisions
              happen on the server. A local project choice or a stale CLI session never grants
              additional project rights.
            </P>
            <P>
              JSON requests permit at most 1 MiB. Knowledgebase uploads use multipart fields{' '}
              <Code>operation=knowledgebases.upload</Code>, <Code>projectId</Code>,{' '}
              <Code>kbId</Code>, and <Code>file</Code>. Files permit at most 4 MiB, with 64 KiB
              for the multipart envelope. Each account permits 120 management requests per minute.
            </P>
            <P>
              Invalid fields return <Code>400 invalid_request</Code>. Missing project selection
              returns <Code>400 project_required</Code>. Unknown operations return{' '}
              <Code>400 unknown_operation</Code>. Invalid sessions return <Code>401 unauthorized</Code>,
              denied access returns <Code>403 forbidden</Code>, and unavailable resources return{' '}
              <Code>404 not_found</Code>.
            </P>
            <P>
              Oversized requests return <Code>413 payload_too_large</Code>. Unsupported content
              types return <Code>415 unsupported_media_type</Code>. Request limits return{' '}
              <Code>429 rate_limited</Code> with <Code>Retry-After: 60</Code>. Unexpected failures
              return <Code>500 internal_error</Code> without database details.
            </P>
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
              present. A valid Sophy key receives <Code>503 project_gateway_unavailable</Code> when
              the project credential its model needs — Vercel AI Gateway, or Cloudflare Workers AI
              for Cloudflare models — is missing, disconnected, invalid, billing-blocked, not yet
              verified, or undecryptable. The message is provider-neutral and asks a project admin
              to connect or check the project’s AI provider credentials. Sophy makes no fallback
              upstream call: a Cloudflare model never falls back to Vercel AI Gateway, or the
              reverse. When Cloudflare rejects a stored token during a request, Sophy marks that
              credential invalid and returns the same <Code>503</Code> until an Admin reconnects
              it. Transient network and server failures are hidden behind{' '}
              <Code>502 upstream_error</Code>.
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
              Chat, Responses, audio transcription, embeddings, image generation, model
              evaluation, and extraction enforce the key’s optional requests-per-minute limit and
              monthly cost cap before the paid model call. <Code>/files</Code> and{' '}
              <Code>/models</Code> do not consume those request counters.
            </P>
            <ul className="list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-muted-foreground">
              <li>
                RPM uses a fixed 60-second window. Exceeding it returns{' '}
                <Code>429 rate_limit_exceeded</Code> with <Code>Retry-After</Code> in seconds.
              </li>
              <li>
                Monthly quota uses the current UTC calendar month and counts client-attributable
                spend, including transcript processing and the estimated cost of Cloudflare
                Workers AI calls. Reaching it returns <Code>402 quota_exceeded</Code>.
              </li>
              <li>
                Champion-versus-challenger evaluation and knowledgebase spend is recorded under
                separate sources for visibility and does not consume a key’s proxy-traffic cap.
              </li>
            </ul>
            <P>
              Console cost values are estimates for operational decisions, not a billing-grade
              ledger. Vercel AI Gateway calls record the cost the gateway reports. Cloudflare
              Workers AI calls are estimated from the neurons Cloudflare reports for each call, at
              its published $0.011 per 1,000 neurons, or from the model’s listed input-token price
              when no neuron count comes back; output tokens are not billed. The estimate ignores
              Cloudflare’s free allocation of 10,000 neurons per account per day, so Cloudflare
              can bill less than Sophy records. A response that Cloudflare completed and billed
              but Sophy couldn’t use — for example, one missing a requested field, which returns{' '}
              <Code>502 upstream_error</Code> — is still metered from the neurons Cloudflare
              reported for it. Requests that Cloudflare rejected record no cost.
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
