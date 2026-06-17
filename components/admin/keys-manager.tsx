'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createKey, updateKey, revokeKey, type KeyFormInput } from '@/app/admin/actions';
import type { KeyRow } from '@/lib/admin/queries';
import type { AvailableModel } from '@/lib/gateway/models';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

function numOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function numOrUndef(s: string): number | undefined {
  const n = numOrNull(s);
  return n == null ? undefined : n;
}

export function KeysManager({ keys, models }: { keys: KeyRow[]; models: AvailableModel[] }) {
  const [issued, setIssued] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New API key</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyForm mode="create" models={models} onIssued={setIssued} />
        </CardContent>
      </Card>

      <div className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground">
          {keys.length} key{keys.length === 1 ? '' : 's'}
        </h2>
        {keys.map((k) => (
          <Card key={k.id}>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">
                {k.name}{' '}
                <span className="ml-1 font-mono text-xs text-muted-foreground">
                  {k.keyPrefix}…{k.keyLast4}
                </span>
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant={k.status === 'active' ? 'default' : 'destructive'}>{k.status}</Badge>
                {k.status === 'active' && <RevokeButton id={k.id} />}
              </div>
            </CardHeader>
            <CardContent>
              <KeyForm mode="edit" keyId={k.id} models={models} initial={k} />
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={issued != null} onOpenChange={(o) => !o && setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              Copy this now — it is shown only once and cannot be retrieved later.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-md bg-muted p-3 text-sm">{issued}</code>
          <DialogFooter>
            <Button
              onClick={() => {
                if (issued) navigator.clipboard?.writeText(issued);
                toast.success('Copied');
              }}
            >
              Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RevokeButton({ id }: { id: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="destructive"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          try {
            await revokeKey(id);
            toast.success('Key revoked');
          } catch {
            toast.error('Failed to revoke');
          }
        })
      }
    >
      Revoke
    </Button>
  );
}

function KeyForm({
  mode,
  keyId,
  initial,
  models,
  onIssued,
}: {
  mode: 'create' | 'edit';
  keyId?: string;
  initial?: KeyRow;
  models: AvailableModel[];
  onIssued?: (key: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(initial?.name ?? '');
  const [model, setModel] = useState(initial?.model ?? (models[0]?.id ?? ''));
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [temperature, setTemperature] = useState(initial?.params.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(initial?.params.maxOutputTokens?.toString() ?? '');
  const [tokenCap, setTokenCap] = useState(initial?.monthlyTokenCap?.toString() ?? '');
  const [rpm, setRpm] = useState(initial?.rpmLimit?.toString() ?? '');
  const [schemaText, setSchemaText] = useState(
    initial?.outputSchema ? JSON.stringify(initial.outputSchema, null, 2) : '',
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  function submit() {
    if (!name.trim()) return toast.error('Name is required');
    if (!model.trim()) return toast.error('Model is required');
    let outputSchema: Record<string, unknown> | null = null;
    if (schemaText.trim()) {
      try {
        outputSchema = JSON.parse(schemaText) as Record<string, unknown>;
      } catch {
        return toast.error('Output schema is not valid JSON');
      }
    }
    const input: KeyFormInput = {
      name: name.trim(),
      model: model.trim(),
      systemPrompt: systemPrompt.trim() ? systemPrompt : null,
      params: {
        temperature: numOrUndef(temperature),
        maxOutputTokens: numOrUndef(maxTokens),
      },
      outputSchema,
      monthlyTokenCap: numOrNull(tokenCap),
      rpmLimit: numOrNull(rpm),
    };
    startTransition(async () => {
      try {
        if (mode === 'create') {
          const { fullKey } = await createKey(input);
          onIssued?.(fullKey);
          setName('');
          setSystemPrompt('');
          setSchemaText('');
          toast.success('Key created');
        } else {
          await updateKey({ id: keyId!, ...input });
          toast.success('Saved — applies to the next request');
        }
      } catch {
        toast.error('Something went wrong');
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input
            placeholder="billing-service prod"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Model</Label>
          {models.length > 0 ? (
            <Select value={model} onValueChange={(v) => setModel(v ?? '')}>
              <SelectTrigger>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder="anthropic/claude-sonnet-4.6"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          )}
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">System prompt</Label>
        <Textarea
          rows={5}
          className="text-sm"
          placeholder="You are a helpful assistant for…"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Monthly token cap (blank = unlimited)</Label>
          <Input value={tokenCap} inputMode="numeric" onChange={(e) => setTokenCap(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Rate limit (req/min, blank = none)</Label>
          <Input value={rpm} inputMode="numeric" onChange={(e) => setRpm(e.target.value)} />
        </div>
      </div>

      <button
        type="button"
        className="text-xs text-muted-foreground underline"
        onClick={() => setShowAdvanced((s) => !s)}
      >
        {showAdvanced ? 'Hide advanced' : 'Advanced (params, structured output)'}
      </button>

      {showAdvanced && (
        <div className="space-y-4 rounded-md border p-3">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Temperature</Label>
              <Input value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max output tokens</Label>
              <Input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="1024" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Output JSON schema (blank = plain text)</Label>
            <Textarea
              className="font-mono text-xs"
              rows={6}
              placeholder='{ "type": "object", "properties": { ... }, "required": [...] }'
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
            />
          </div>
        </div>
      )}

      <Button onClick={submit} disabled={isPending}>
        {isPending ? 'Saving…' : mode === 'create' ? 'Create key' : 'Save changes'}
      </Button>
    </div>
  );
}
