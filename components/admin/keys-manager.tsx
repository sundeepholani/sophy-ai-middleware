'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil } from 'lucide-react';
import { createKey, updateKey, revokeKey, type KeyFormInput } from '@/app/admin/actions';
import type { KeyRow } from '@/lib/admin/queries';
import type { AvailableModel } from '@/lib/gateway/models';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
function quotaLabel(k: KeyRow): string {
  const cap = k.monthlyTokenCap != null ? `${k.monthlyTokenCap.toLocaleString()} tok/mo` : '∞';
  const rpm = k.rpmLimit != null ? `${k.rpmLimit}/min` : '∞';
  return `${cap} · ${rpm}`;
}

export function KeysManager({ keys, models }: { keys: KeyRow[]; models: AvailableModel[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<KeyRow | null>(null);
  const [issued, setIssued] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {keys.length} key{keys.length === 1 ? '' : 's'}
        </h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New API key
        </Button>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Pick a model and write the system prompt. The key is shown once.
              </DialogDescription>
            </DialogHeader>
            <KeyForm
              mode="create"
              models={models}
              onIssued={setIssued}
              onDone={() => setCreateOpen(false)}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Quota</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No keys yet — create one with “New API key”.
                </TableCell>
              </TableRow>
            )}
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {k.keyPrefix}…{k.keyLast4}
                </TableCell>
                <TableCell className="font-mono text-xs">{k.model}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {quotaLabel(k)}
                </TableCell>
                <TableCell>
                  <Badge variant={k.status === 'active' ? 'default' : 'destructive'}>
                    {k.status}
                  </Badge>
                </TableCell>
                <TableCell className="space-x-1 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(k)}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  {k.status === 'active' && <RevokeButton id={k.id} name={k.name} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Edit modal */}
      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit key</DialogTitle>
            <DialogDescription>Changes apply on the next request — no redeploy.</DialogDescription>
          </DialogHeader>
          {editing && (
            <KeyForm
              key={editing.id}
              mode="edit"
              keyId={editing.id}
              initial={editing}
              models={models}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Show-once key reveal */}
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

function RevokeButton({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        Revoke
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The key stops working immediately and cannot be restored. Any client using it will
              get 401s.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  try {
                    await revokeKey(id);
                    toast.success('Key revoked');
                    setOpen(false);
                  } catch {
                    toast.error('Failed to revoke');
                  }
                });
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function KeyForm({
  mode,
  keyId,
  initial,
  models,
  onIssued,
  onDone,
}: {
  mode: 'create' | 'edit';
  keyId?: string;
  initial?: KeyRow;
  models: AvailableModel[];
  onIssued?: (key: string) => void;
  onDone?: () => void;
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
          toast.success('Key created');
        } else {
          await updateKey({ id: keyId!, ...input });
          toast.success('Saved — applies to the next request');
        }
        onDone?.();
      } catch {
        toast.error('Something went wrong');
      }
    });
  }

  return (
    <div className="space-y-4">
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
            <SelectTrigger className="w-full">
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Monthly token cap (blank = ∞)</Label>
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
          <div className="grid gap-4 sm:grid-cols-2">
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

      <div className="flex justify-end gap-2 pt-2">
        <Button onClick={submit} disabled={isPending}>
          {isPending ? 'Saving…' : mode === 'create' ? 'Create key' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
