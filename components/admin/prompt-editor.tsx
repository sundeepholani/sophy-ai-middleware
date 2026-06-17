'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { savePromptDraft, publishPromptVersion } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Version {
  id: string;
  body: string;
  status: string;
  isActive: boolean;
  createdAt: Date;
}

export function PromptEditor({
  promptId,
  versions,
}: {
  promptId: string;
  versions: Version[];
}) {
  const [isPending, startTransition] = useTransition();
  const initial = versions.find((v) => v.isActive)?.body ?? versions[0]?.body ?? '';
  const [body, setBody] = useState(initial);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Draft</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={12}
            className="font-mono text-sm"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="You are a helpful assistant for…"
          />
          <Button
            disabled={isPending || !body.trim()}
            onClick={() =>
              startTransition(async () => {
                try {
                  await savePromptDraft({ promptId, body });
                  toast.success('Draft saved as a new version');
                } catch {
                  toast.error('Failed to save draft');
                }
              })
            }
          >
            Save draft
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Versions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {versions.length === 0 && (
            <p className="text-sm text-muted-foreground">No versions yet — save a draft above.</p>
          )}
          {versions.map((v) => (
            <div key={v.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                  <Badge variant="outline">{v.status}</Badge>
                  {v.isActive && <Badge>active</Badge>}
                </div>
                <div className="space-x-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpanded(expanded === v.id ? null : v.id)}
                  >
                    {expanded === v.id ? 'Hide' : 'View'}
                  </Button>
                  {!v.isActive && (
                    <Button
                      size="sm"
                      disabled={isPending}
                      onClick={() =>
                        startTransition(async () => {
                          try {
                            await publishPromptVersion({ promptId, versionId: v.id });
                            toast.success('Published — routes using this prompt are updated');
                          } catch {
                            toast.error('Failed to publish');
                          }
                        })
                      }
                    >
                      {versions.some((x) => x.isActive) ? 'Roll back to this' : 'Publish'}
                    </Button>
                  )}
                </div>
              </div>
              {expanded === v.id && (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                  {v.body}
                </pre>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
