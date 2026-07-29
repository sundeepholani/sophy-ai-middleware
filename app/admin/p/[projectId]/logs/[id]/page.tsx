import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLogDetail } from '@/lib/admin/queries';
import { requireProjectViewer } from '@/lib/auth/viewer';
import { LocalTime } from '@/components/admin/local-time';
import { projectPath } from '@/components/admin/project-path';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

type InboundMessage = { role?: string; content?: unknown };

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : JSON.stringify(p)))
      .join('');
  }
  return JSON.stringify(content, null, 2);
}

export default async function LogDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>;
}) {
  const { projectId, id } = await params;
  const viewer = await requireProjectViewer(projectId);
  const detail = await getLogDetail(viewer, id);
  if (!detail) notFound();

  const { event, content } = detail;
  const messages = Array.isArray(content?.request) ? (content!.request as InboundMessage[]) : null;

  // Build the metadata line from whatever is present so absent parts (e.g. a
  // challenger call has no token counts) never leave an orphan separator.
  const meta = [
    event.inputTokens != null ? `${event.inputTokens} in · ${event.outputTokens} out` : null,
    event.costUsd ? `$${Number(event.costUsd).toFixed(4)}` : null,
    event.latencyMs != null ? `${event.latencyMs} ms` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-6">
      <div>
        <Link href={projectPath(projectId, 'logs')} className="text-sm text-primary hover:underline">
          ← Logs
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          {event.source === 'challenger'
            ? 'Eval challenger call'
            : event.source === 'processor'
              ? 'Transcript processor call'
            : event.source === 'judge'
                ? 'Eval judge call'
                : event.source === 'kb'
                  ? 'Knowledgebase embedding call'
                  : 'Request detail'}
        </h1>
        <p className="text-sm text-muted-foreground">
          <LocalTime value={event.createdAt.toISOString()} /> · key{' '}
          {event.keyName ?? (event.apiKeyId ? event.apiKeyId.slice(0, 8) : '— (cron)')} ·{' '}
          <span className="font-mono">{event.model}</span>
        </p>
      </div>

      {event.source === 'challenger' && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          This is a model-eval <span className="font-medium">challenger</span> call — a shadow replay
          of a captured request through <span className="font-mono">{event.model}</span>
          {event.championModel && (
            <>
              {' '}
              vs. champion <span className="font-mono">{event.championModel}</span>
            </>
          )}
          . Its cost is tracked by the eval, not billed to the key.{' '}
          <Link
            href={
              event.evalRunId
                ? projectPath(projectId, `evals/${event.evalRunId}`)
                : projectPath(projectId, 'evals')
            }
            className="text-primary hover:underline"
          >
            View eval run
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={event.status === 'ok' ? 'default' : 'destructive'}>{event.status}</Badge>
        {event.source !== 'proxy' && <Badge variant="secondary">{event.source}</Badge>}
        {content?.surface && <Badge variant="outline">{content.surface}</Badge>}
        {event.streamed && <Badge variant="outline">stream</Badge>}
        {meta && <span className="text-muted-foreground">{meta}</span>}
      </div>

      {!content && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Message content was not logged for this request (content logging is off for this key, or
            it has passed the 30-day retention window). Usage metadata is always kept.
          </CardContent>
        </Card>
      )}

      {content && (
        <>
          {content.systemPrompt && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">System prompt (applied)</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {content.systemPrompt}
                </pre>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Inbound — messages</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {messages ? (
                messages.map((m, i) => (
                  <div key={i} className="rounded-md border p-3">
                    <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                      {m.role ?? 'message'}
                    </div>
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
                      {renderContent(m.content)}
                    </pre>
                  </div>
                ))
              ) : (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(content.request, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outbound — response</CardTitle>
            </CardHeader>
            <CardContent>
              {event.errorMessage && (
                <p className="mb-2 text-sm text-destructive">Error: {event.errorMessage}</p>
              )}
              {content.response ? (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
                  {content.response}
                </pre>
              ) : (
                <span className="text-sm text-muted-foreground">(no response captured)</span>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
