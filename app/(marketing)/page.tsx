import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Plug,
  KeyRound,
  Boxes,
  Wrench,
  Braces,
  Library,
  Gauge,
  Paperclip,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CodeTabs } from '@/components/marketing/code-tabs';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Sophy — one API key for every model',
  description:
    'Sophy is a drop-in, OpenAI-compatible AI gateway. Issue keys that carry their own model, prompt, limits, and knowledge — then point any OpenAI SDK at https://sophy.in/v1.',
};

const HERO_SAMPLES = [
  {
    label: 'python',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="https://sophy.in/v1",   # ← point at Sophy
    api_key="mw_live_…",              # ← your Sophy key
)

resp = client.chat.completions.create(
    model="sophy",                    # ignored — the key picks the model
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`,
  },
  {
    label: 'javascript',
    code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://sophy.in/v1",   // ← point at Sophy
  apiKey: "mw_live_…",              // ← your Sophy key
});

const resp = await client.chat.completions.create({
  model: "sophy",                   // ignored — the key picks the model
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);`,
  },
  {
    label: 'curl',
    code: `curl https://sophy.in/v1/chat/completions \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "sophy",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
  },
];

const FEATURES: { icon: typeof Plug; title: string; body: string }[] = [
  {
    icon: Plug,
    title: 'OpenAI-compatible',
    body: 'Keep your existing OpenAI SDK. Change only the base URL and API key — chat completions, responses, models, and file uploads all work unchanged.',
  },
  {
    icon: KeyRound,
    title: 'Key-owned configuration',
    body: 'Each key carries its own model, system prompt, and parameters server-side. Repoint a model or tighten a prompt without touching client code.',
  },
  {
    icon: Boxes,
    title: 'Any model, one gateway',
    body: 'Route to models across providers through the Vercel AI Gateway. Browse the catalog with capabilities like vision, tools, and reasoning.',
  },
  {
    icon: Wrench,
    title: 'Tool & function calling',
    body: 'Pass your tool definitions and Sophy returns the model’s tool calls on both the chat and responses APIs. Your client runs the tools and sends results back.',
  },
  {
    icon: Braces,
    title: 'Structured output',
    body: 'Bind a JSON Schema to a key and every response is validated against it — typed, predictable output without prompt gymnastics in your client.',
  },
  {
    icon: Library,
    title: 'Knowledgebases (RAG)',
    body: 'Attach a curated knowledgebase to a key and relevant snippets are retrieved and grounded into each request automatically.',
  },
  {
    icon: Gauge,
    title: 'Usage, cost & quotas',
    body: 'Per-key usage and cost tracking, requests-per-minute rate limits, and monthly spend caps — enforced at the gateway, visible in the console.',
  },
  {
    icon: Paperclip,
    title: 'File uploads',
    body: 'Upload images and documents to a key-scoped store and reference them in multimodal requests, all behind the same OpenAI-compatible surface.',
  },
];

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'Get a key',
    body: 'An admin issues you a key in the Sophy console, pre-configured with its model, system prompt, limits, and any knowledgebase.',
  },
  {
    n: '2',
    title: 'Point your SDK at Sophy',
    body: 'Set base_url to https://sophy.in/v1 and use your mw_live_… key. No other client changes — your existing OpenAI calls just work.',
  },
  {
    n: '3',
    title: 'Ship',
    body: 'Sophy handles routing, grounding, rate limits, quotas, and usage accounting. Switch models or adjust budgets from the console, anytime.',
  },
];

const CHAT_SAMPLES = [
  {
    label: 'python',
    code: `from openai import OpenAI

client = OpenAI(base_url="https://sophy.in/v1", api_key="mw_live_…")

stream = client.chat.completions.create(
    model="sophy",
    stream=True,
    messages=[
        {"role": "user", "content": "Summarize today's standup notes."},
    ],
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`,
  },
  {
    label: 'javascript',
    code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://sophy.in/v1", apiKey: "mw_live_…" });

const stream = await client.chat.completions.create({
  model: "sophy",
  stream: true,
  messages: [{ role: "user", content: "Summarize today's standup notes." }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`,
  },
  {
    label: 'curl',
    code: `curl https://sophy.in/v1/chat/completions \\
  -H "Authorization: Bearer mw_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "sophy",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Summarize today'\\''s standup notes."}
    ]
  }'`,
  },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
        />
        <div className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:gap-10 lg:px-8 lg:py-28">
          <div className="space-y-6">
            <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs">
              OpenAI-compatible · Vercel AI Gateway
            </Badge>
            <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              One API key for every model.
            </h1>
            <p className="max-w-xl text-lg text-muted-foreground text-pretty">
              Sophy is a drop-in, OpenAI-compatible gateway for your organization. Issue keys that
              carry their own model, prompt, limits, and knowledge — then point any OpenAI SDK at{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
                https://sophy.in/v1
              </code>
              .
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/docs" className={cn(buttonVariants({ size: 'lg' }), 'h-11 px-6 text-base')}>
                Read the docs
                <ArrowRight />
              </Link>
              <Link
                href="/admin/login"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'h-11 px-6 text-base')}
              >
                Sign in
              </Link>
            </div>
          </div>
          <CodeTabs samples={HERO_SAMPLES} className="shadow-xl shadow-primary/5" />
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20 border-b">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="max-w-2xl space-y-3">
            <h2 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              Everything a gateway should own
            </h2>
            <p className="text-lg text-muted-foreground text-pretty">
              The model, the prompt, the limits, and the knowledge live with Sophy — so your clients
              stay simple and your control stays central.
            </p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-xl bg-border ring-1 ring-border sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="flex flex-col gap-3 bg-card p-6">
                  <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <h3 className="font-heading text-base font-medium">{f.title}</h3>
                  <p className="text-sm text-muted-foreground">{f.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="scroll-mt-20 border-b bg-muted/30">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="max-w-2xl space-y-3">
            <h2 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              Integrate in three steps
            </h2>
            <p className="text-lg text-muted-foreground text-pretty">
              No SDK to learn, no migration. If you already call OpenAI, you already know Sophy.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-xl bg-card p-6 ring-1 ring-foreground/10">
                <div className="grid size-9 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {s.n}
                </div>
                <h3 className="font-heading mt-4 text-lg font-medium">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Code sample */}
      <section className="border-b">
        <div className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:px-8">
          <div className="space-y-5">
            <h2 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
              Streaming, tools, and structured output — built in
            </h2>
            <p className="text-lg text-muted-foreground text-pretty">
              Stream tokens, pass tool definitions, or bind a JSON Schema to a key for typed
              responses. It’s the OpenAI wire format you already use, with the gateway doing the
              heavy lifting.
            </p>
            <Link
              href="/docs#chat-completions"
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              See the full reference
              <ArrowRight />
            </Link>
          </div>
          <CodeTabs samples={CHAT_SAMPLES} />
        </div>
      </section>

      {/* CTA */}
      <section className={cn('bg-primary text-primary-foreground')}>
        <div className="mx-auto flex w-full max-w-7xl flex-col items-start gap-6 px-4 py-16 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <div className="space-y-2">
            <h2 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              Ready to integrate?
            </h2>
            <p className="text-primary-foreground/80">
              Read the API docs, or sign in to manage your keys.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs"
              className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'h-11 px-6 text-base')}
            >
              Read the docs
            </Link>
            <Link
              href="/admin/login"
              className={cn(
                buttonVariants({ size: 'lg' }),
                'h-11 border border-primary-foreground/30 bg-primary-foreground/10 px-6 text-base text-primary-foreground hover:bg-primary-foreground/20',
              )}
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
