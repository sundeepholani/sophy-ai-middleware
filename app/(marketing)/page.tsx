import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Binary,
  Boxes,
  Braces,
  ChartNoAxesCombined,
  FlaskConical,
  Gauge,
  House,
  KeyRound,
  Library,
  Paperclip,
  Plug,
  RotateCw,
  ShieldCheck,
  Star,
  Terminal,
  UserRoundPlus,
  UsersRound,
  Wrench,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CodeTabs } from '@/components/marketing/code-tabs';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Sophy — one governed API for your AI stack',
  description:
    'Sophy is a multi-project, OpenAI-compatible AI gateway for language, transcription, image, and embedding models, plus a native route for evaluation models, with project-owned Gateway credentials, governed keys, knowledgebases, evaluations, analytics, and cost controls.',
};

const HERO_SAMPLES = [
  {
    label: 'chat',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="https://sophy.in/v1",
    api_key="mw_live_…",
)

resp = client.chat.completions.create(
    model="sophy",  # the key selects the model
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`,
  },
  {
    label: 'transcription',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="https://sophy.in/v1",
    api_key="mw_live_…",  # bound to a transcription model
)

with open("meeting.m4a", "rb") as audio:
    resp = client.audio.transcriptions.create(
        model="sophy",
        file=audio,
        language="en",
    )
print(resp.text)`,
  },
  {
    label: 'embeddings',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="https://sophy.in/v1",
    api_key="mw_live_…",  # bound to an embedding model
)

resp = client.embeddings.create(
    model="sophy",
    input=["First document", "Second document"],
)
print(resp.data[0].embedding)`,
  },
  {
    label: 'images',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="https://sophy.in/v1",
    api_key="mw_live_…",  # bound to an image model
)

resp = client.images.generate(
    model="sophy",
    prompt="A monsoon city at blue hour, watercolor",
    size="1024x1024",
)
print(resp.data[0].b64_json[:32])`,
  },
];

const SURFACES = [
  { method: 'POST', path: '/chat/completions', label: 'Chat + streaming' },
  { method: 'POST', path: '/responses', label: 'Responses + tools' },
  { method: 'POST', path: '/audio/transcriptions', label: 'Raw or policy-processed text' },
  { method: 'POST', path: '/embeddings', label: 'Float or base64 vectors' },
  { method: 'POST', path: '/evaluate', label: 'Scored model judgements' },
  { method: 'POST', path: '/images/generations', label: 'Inline image output' },
  { method: 'POST', path: '/files', label: 'Key-scoped uploads' },
  { method: 'GET', path: '/models', label: 'The key’s bound model' },
] as const;

const FEATURES: { icon: typeof Plug; title: string; body: string }[] = [
  {
    icon: Plug,
    title: 'A familiar API surface',
    body: 'Use supported OpenAI SDK methods for Chat Completions, Responses, audio transcription, embeddings, image generation, models, and files, plus a native route for evaluation models.',
  },
  {
    icon: KeyRound,
    title: 'Policy lives on the key',
    body: 'Pin a primary model and centrally own its prompt, optional transcript processor, parameters, schema, knowledgebase, logging policy, budget, and rate limit.',
  },
  {
    icon: Wrench,
    title: 'Tools and agent workflows',
    body: 'Run standard function-tool loops, or opt trusted server-side agents into per-request instructions while the key’s policy stays first.',
  },
  {
    icon: Braces,
    title: 'Portable structured output',
    body: 'Attach a JSON Schema to a key for schema-constrained output, normalized across supported language models and validated on completion.',
  },
  {
    icon: Library,
    title: 'Managed knowledgebases',
    body: 'Let Admins manage every collection and Editors build their own from PDF, DOCX, Markdown, text, CSV, or JSON, then share them across permitted keys.',
  },
  {
    icon: Boxes,
    title: 'A searchable model catalog',
    body: 'Compare supported language, transcription, image, embedding, and evaluation models by provider, capability, context window, and estimated pricing.',
  },
  {
    icon: Gauge,
    title: 'Budgets and rate limits',
    body: 'Enforce per-key requests-per-minute limits and monthly cost caps before paid model calls reach the provider.',
  },
  {
    icon: Paperclip,
    title: 'Key-scoped multimodal files',
    body: 'Stage short-lived images and documents, then reference them in multimodal requests with cross-key reuse blocked inside Sophy.',
  },
];

const OPERATIONS: { icon: typeof FlaskConical; title: string; body: string }[] = [
  {
    icon: FlaskConical,
    title: 'Production model evaluations',
    body: 'Shadow successful live text requests to a challenger, score outputs with a blinded judge, and compare quality, cost, and latency before switching.',
  },
  {
    icon: ChartNoAxesCombined,
    title: 'Usage analytics and request tracing',
    body: 'Explore requests, tokens, estimated cost, latency, model mix, errors, and spend by source—with optional content capture and a shorter seven-day boundary for complete image inputs.',
  },
  {
    icon: UsersRound,
    title: 'Project-isolated teams and spend',
    body: 'Give one identity an Admin or Editor role per project. Each project keeps its own members, Sophy keys, knowledgebases, telemetry, and Vercel Gateway credential.',
  },
  {
    icon: RotateCw,
    title: 'Mature key operations',
    body: 'Rotate secrets in place, revoke immediately, search active and revoked keys, and apply model changes or start evaluations in bulk.',
  },
  {
    icon: Terminal,
    title: 'Manage Sophy from your terminal',
    body: 'Create, edit, rotate, and revoke keys from the CLI, with bulk model changes and evaluations under the same project permissions as the console.',
  },
  {
    icon: ShieldCheck,
    title: 'One code, familiar access',
    body: 'Sign in to the console or CLI with a code sent to your email. Your project roles and resource ownership apply in both.',
  },
];

const PROJECT_FEATURES: { icon: typeof House; title: string; body: string }[] = [
  {
    icon: House,
    title: 'Start in My Project',
    body: 'Sign up directly and Sophy creates a renameable project where you are the Admin.',
  },
  {
    icon: UserRoundPlus,
    title: 'Join through an invitation',
    body: 'Your invited project becomes the default when it is your first Sophy project, with the role its Admin assigned.',
  },
  {
    icon: Star,
    title: 'Choose your default',
    body: 'Use one identity across projects, switch without signing out, and choose which project opens first.',
  },
  {
    icon: KeyRound,
    title: 'Bring a Gateway per project',
    body: 'Every project connects its own Vercel AI Gateway credential before its Sophy keys can make paid model calls.',
  },
];

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'Connect your project',
    body: 'A Project Admin adds the project’s Vercel AI Gateway key. Sophy validates it without making a generation call and stores it encrypted.',
  },
  {
    n: '2',
    title: 'Configure a Sophy API key',
    body: 'Choose a primary model and set its prompt policy, parameters, limits, logging, schema, optional transcript processor, and optional project knowledgebase.',
  },
  {
    n: '3',
    title: 'Integrate and improve',
    body: 'Use the OpenAI SDK with the Sophy key, then trace project usage, evaluate challengers, and update policy without redeploying clients.',
  },
];

const AGENT_SAMPLES = [
  {
    label: 'python',
    code: `from openai import OpenAI

client = OpenAI(base_url="https://sophy.in/v1", api_key="mw_live_…")

# On a trusted key with Agent mode enabled, these instructions are
# appended after the centrally managed key prompt.
resp = client.responses.create(
    model="sophy",
    instructions="Plan carefully and explain the final decision.",
    input="Compare the two launch options.",
)
print(resp.output_text)`,
  },
  {
    label: 'javascript',
    code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://sophy.in/v1",
  apiKey: "mw_live_…",
});

const resp = await client.responses.create({
  model: "sophy",
  instructions: "Plan carefully and explain the final decision.",
  input: "Compare the two launch options.",
});
console.log(resp.output_text);`,
  },
];

export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
        />
        <div className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:gap-10 lg:px-8 lg:py-28">
          <div className="space-y-6">
            <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs">
              Multi-project · OpenAI-compatible · Language, audio, image, embedding, and
              evaluation models
            </Badge>
            <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              One governed API for your AI stack.
            </h1>
            <p className="max-w-xl text-lg text-muted-foreground text-pretty">
              Sophy puts supported models behind project-scoped keys. Each project brings its own
              Vercel AI Gateway credential while its team governs prompts, models, schemas,
              knowledge, logging, and limits from one console.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/docs" className={cn(buttonVariants({ size: 'lg' }), 'h-11 px-6 text-base')}>
                Read the docs
                <ArrowRight />
              </Link>
              <Link
                href="/admin/login"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'lg' }),
                  'h-11 px-6 text-base',
                )}
              >
                Sign in or create an account
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">
              Each key is bound to one primary model; use an API route that matches its capabilities.
            </p>
          </div>
          <CodeTabs samples={HERO_SAMPLES} className="shadow-xl shadow-primary/5" />
        </div>
      </section>

      <section aria-labelledby="surfaces-title" className="border-b bg-muted/30">
        <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium text-primary">Eight supported API routes</p>
              <h2 id="surfaces-title" className="font-heading mt-1 text-2xl font-semibold tracking-tight">
                One base URL, purpose-built surfaces
              </h2>
            </div>
            <Link
              href="/docs#api-surfaces"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              Review compatibility details <ArrowRight className="size-4" />
            </Link>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SURFACES.map((surface) => (
              <div key={surface.path} className="rounded-xl bg-card p-4 ring-1 ring-border">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                    {surface.method}
                  </span>
                  <code className="font-mono text-sm text-foreground">/v1{surface.path}</code>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{surface.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="projects" aria-labelledby="projects-title" className="scroll-mt-20 border-b">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="max-w-2xl space-y-3">
            <p className="text-sm font-medium text-primary">One identity, isolated projects</p>
            <h2
              id="projects-title"
              className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              Your work starts with the right project
            </h2>
            <p className="text-lg text-muted-foreground text-pretty">
              Sophy keeps membership, policy, data, usage, and provider spend inside each project,
              while giving you one account and a personal default.
            </p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {PROJECT_FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="rounded-xl bg-card p-6 ring-1 ring-border">
                  <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <h3 className="font-heading mt-4 text-base font-medium">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="features" className="scroll-mt-20 border-b">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="max-w-2xl space-y-3">
            <p className="text-sm font-medium text-primary">Build and govern</p>
            <h2 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              Keep clients simple. Keep control central.
            </h2>
            <p className="text-lg text-muted-foreground text-pretty">
              Sophy separates application input from operator policy, while preserving the tool,
              streaming, multimodal, and structured workflows modern AI products need.
            </p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-xl bg-border ring-1 ring-border sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="flex flex-col gap-3 bg-card p-6">
                  <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <h3 className="font-heading text-base font-medium">{feature.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20 border-b bg-muted/30">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="max-w-2xl space-y-3">
            <p className="text-sm font-medium text-primary">How it works</p>
            <h2 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              From integration to evidence in three steps
            </h2>
            <p className="text-lg text-muted-foreground text-pretty">
              Configuration is read from the key on every request, so policy changes and model
              switches apply without a client release.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {STEPS.map((step) => (
              <div key={step.n} className="rounded-xl bg-card p-6 ring-1 ring-foreground/10">
                <div className="grid size-9 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {step.n}
                </div>
                <h3 className="font-heading mt-4 text-lg font-medium">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="evaluation" className="scroll-mt-20 border-b">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="max-w-2xl space-y-3">
            <p className="text-sm font-medium text-primary">Operate and optimize</p>
            <h2 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              Choose models with production evidence
            </h2>
            <p className="text-lg text-muted-foreground text-pretty">
              Sophy is a control plane, not just a proxy. Observe real workloads, compare a
              challenger without changing the client response, and attribute client, evaluation,
              and knowledgebase spend separately.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2">
            {OPERATIONS.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="rounded-xl bg-card p-6 ring-1 ring-border">
                  <div className="flex items-start gap-4">
                    <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </div>
                    <div>
                      <h3 className="font-heading text-lg font-medium">{feature.title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {feature.body}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-8 grid gap-4 rounded-xl bg-muted/40 p-6 ring-1 ring-border sm:grid-cols-3">
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium">Blind quality judgment</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Randomized response order reduces position bias.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <Binary className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium">Cost and latency per task</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Compare operational tradeoffs beside the verdict.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <KeyRound className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium">Recommendation, not auto-switch</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Operators stay in control of the final model change.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b bg-muted/30">
        <div className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:px-8">
          <div className="space-y-5">
            <p className="text-sm font-medium text-primary">Governed by default, agent-ready by choice</p>
            <h2 className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Let trusted agents bring dynamic instructions
            </h2>
            <p className="text-lg text-muted-foreground text-pretty">
              Standard keys drop client prompt instructions. Enable Agent mode only for trusted
              server-side apps, and Sophy appends their leading instructions after the key-owned
              prompt while model, parameters, limits, and observability remain centralized.
            </p>
            <Link href="/docs#agent-mode" className={cn(buttonVariants({ variant: 'outline' }))}>
              Read the prompt policy
              <ArrowRight />
            </Link>
          </div>
          <CodeTabs samples={AGENT_SAMPLES} />
        </div>
      </section>

      <section className="bg-primary text-primary-foreground">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-start gap-6 px-4 py-16 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <div className="space-y-2">
            <h2 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              Ready to put your AI stack under control?
            </h2>
            <p className="text-primary-foreground/80">
              Read the compatibility guide or sign in to manage keys, knowledge, usage, and evaluations.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs"
              className={cn(
                buttonVariants({ variant: 'secondary', size: 'lg' }),
                'h-11 px-6 text-base',
              )}
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
              Sign in or create an account
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
