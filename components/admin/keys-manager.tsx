'use client';

import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, FlaskConical } from 'lucide-react';
import { createKey, updateKey, revokeKey, type KeyFormInput } from '@/app/admin/actions';
import type { KeyRow, KeyEval } from '@/lib/admin/queries';
import type { AvailableModel } from '@/lib/gateway/models';
import type { SessionRole } from '@/lib/auth/session-config';
import { EvalDialog } from '@/components/admin/eval-dialog';
import { ModelCombobox } from '@/components/admin/model-combobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
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

/** Parses a positive whole number; '' → null (no limit); anything else → 'invalid'. */
function posIntOrNull(s: string): number | null | 'invalid' {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : 'invalid';
}
function quotaLabel(k: KeyRow): string {
  const cap = k.monthlyTokenCap != null ? `${k.monthlyTokenCap.toLocaleString()} tok/mo` : '∞';
  const rpm = k.rpmLimit != null ? `${k.rpmLimit}/min` : '∞';
  return `${cap} · ${rpm}`;
}

export function KeysManager({
  keys,
  models,
  modelsUnavailable = false,
  evals = {},
  judgeModel,
  role,
  users,
}: {
  keys: KeyRow[];
  models: AvailableModel[];
  modelsUnavailable?: boolean;
  evals?: Record<string, KeyEval>;
  judgeModel: string;
  role: SessionRole;
  users: { id: string; email: string }[];
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<KeyRow | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [evalKey, setEvalKey] = useState<KeyRow | null>(null);

  async function copyIssued() {
    if (!issued) return;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(issued);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed — select the key and copy it manually');
    }
  }

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
          <DialogContent className="max-h-[85vh] w-full overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Pick a model and write the system prompt. The key is shown once.
              </DialogDescription>
            </DialogHeader>
            <KeyForm
              mode="create"
              models={models}
              modelsUnavailable={modelsUnavailable}
              role={role}
              users={users}
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
              <TableHead>Owner</TableHead>
              <TableHead>Quota</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
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
                <TableCell className="text-xs text-muted-foreground">
                  {k.ownerEmail ?? <span className="italic">Unassigned</span>}
                </TableCell>
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
                  {k.status === 'active' && (
                    <Button size="sm" variant="ghost" onClick={() => setEvalKey(k)}>
                      <FlaskConical className="h-3.5 w-3.5" />
                      Eval
                      {evals[k.id]?.status === 'running' && (
                        <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </Button>
                  )}
                  {k.status === 'active' && <RevokeButton id={k.id} name={k.name} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Edit modal */}
      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[85vh] w-full overflow-y-auto sm:max-w-2xl">
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
              modelsUnavailable={modelsUnavailable}
              role={role}
              users={users}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Eval modal */}
      {evalKey && (
        <EvalDialog
          keyRow={{ id: evalKey.id, name: evalKey.name, model: evalKey.model }}
          models={models}
          current={evals[evalKey.id] ?? null}
          judgeModel={judgeModel}
          open={evalKey != null}
          onOpenChange={(o) => !o && setEvalKey(null)}
        />
      )}

      {/* Show-once key reveal — dismissable only via the explicit acknowledgement button,
          since the key cannot be retrieved later. */}
      <Dialog
        open={issued != null}
        onOpenChange={(open) => {
          // Ignore Escape / backdrop dismissals; only the buttons below may close it.
          if (open) return;
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              Copy this now — it is shown only once and cannot be retrieved later.
            </DialogDescription>
          </DialogHeader>
          <code className="block select-all break-all rounded-md bg-muted p-3 text-sm">
            {issued}
          </code>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssued(null)}>
              I&apos;ve saved my key
            </Button>
            <Button onClick={copyIssued}>Copy</Button>
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
  modelsUnavailable = false,
  role,
  users,
  onIssued,
  onDone,
}: {
  mode: 'create' | 'edit';
  keyId?: string;
  initial?: KeyRow;
  models: AvailableModel[];
  modelsUnavailable?: boolean;
  role: SessionRole;
  users: { id: string; email: string }[];
  onIssued?: (key: string) => void;
  onDone?: () => void;
}) {
  const uid = useId();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(initial?.name ?? '');
  const [model, setModel] = useState(initial?.model ?? (models[0]?.id ?? ''));
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [temperature, setTemperature] = useState(initial?.params.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(initial?.params.maxOutputTokens?.toString() ?? '');
  const [topP, setTopP] = useState(initial?.params.topP?.toString() ?? '');
  const [tokenCap, setTokenCap] = useState(initial?.monthlyTokenCap?.toString() ?? '');
  const [rpm, setRpm] = useState(initial?.rpmLimit?.toString() ?? '');
  const [logContent, setLogContent] = useState(initial?.logContent ?? true);
  const [schemaText, setSchemaText] = useState(
    initial?.outputSchema ? JSON.stringify(initial.outputSchema, null, 2) : '',
  );
  const [ownerUserId, setOwnerUserId] = useState(initial?.ownerUserId ?? '');
  const [showAdvanced, setShowAdvanced] = useState(false);

  function submit() {
    if (!name.trim()) return toast.error('Name is required');
    if (!model.trim()) return toast.error('Model is required');

    // Output schema must be a JSON object (not an array/string/number/null).
    let outputSchema: Record<string, unknown> | null = null;
    if (schemaText.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(schemaText);
      } catch {
        return toast.error('Output schema is not valid JSON');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return toast.error('Output schema must be a JSON object');
      }
      outputSchema = parsed as Record<string, unknown>;
    }

    // Quota fields: positive whole numbers (blank = no limit).
    const cap = posIntOrNull(tokenCap);
    if (cap === 'invalid') return toast.error('Monthly token cap must be a positive whole number');
    const rpmV = posIntOrNull(rpm);
    if (rpmV === 'invalid') return toast.error('Rate limit must be a positive whole number');

    // Temperature: optional, 0–2 inclusive.
    let temp: number | undefined;
    if (temperature.trim()) {
      const n = Number(temperature);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        return toast.error('Temperature must be between 0 and 2');
      }
      temp = n;
    }

    // Top P: optional, 0–1 inclusive.
    let topPV: number | undefined;
    if (topP.trim()) {
      const n = Number(topP);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return toast.error('Top P must be between 0 and 1');
      }
      topPV = n;
    }

    // Max output tokens: optional, positive whole number.
    let maxOut: number | undefined;
    if (maxTokens.trim()) {
      const n = Number(maxTokens);
      if (!Number.isInteger(n) || n <= 0) {
        return toast.error('Max output tokens must be a positive whole number');
      }
      maxOut = n;
    }

    const input: KeyFormInput = {
      name: name.trim(),
      model: model.trim(),
      systemPrompt: systemPrompt.trim() ? systemPrompt : null,
      // Spread the original params so any field we don't surface survives an edit;
      // blank UI fields serialize out of the jsonb as undefined.
      params: {
        ...initial?.params,
        temperature: temp,
        maxOutputTokens: maxOut,
        topP: topPV,
      },
      outputSchema,
      monthlyTokenCap: cap,
      rpmLimit: rpmV,
      logContent,
      // Owner is admin-only; the server forces self-ownership for editors regardless.
      ownerUserId: role === 'admin' ? ownerUserId || null : undefined,
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
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        toast.error(
          msg === 'unauthorized'
            ? 'Your session expired — please sign in again.'
            : 'Could not save the key. Check your inputs and try again.',
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor={`${uid}-name`} className="text-xs">
          Name
        </Label>
        <Input
          id={`${uid}-name`}
          placeholder="billing-service prod"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${uid}-model`} className="text-xs">
          Model
        </Label>
        <ModelCombobox
          id={`${uid}-model`}
          value={model}
          onValueChange={setModel}
          models={models.map((m) => m.id)}
          modelsUnavailable={modelsUnavailable}
          placeholder="anthropic/claude-sonnet-4.6"
        />
      </div>

      {role === 'admin' && (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-owner`} className="text-xs">
            Owner
          </Label>
          <Select
            items={[
              { label: 'Unassigned', value: 'unassigned' },
              ...users.map((u) => ({ label: u.email, value: u.id })),
            ]}
            value={ownerUserId || 'unassigned'}
            onValueChange={(v) => {
              if (v != null) setOwnerUserId(v === 'unassigned' ? '' : (v as string));
            }}
          >
            <SelectTrigger id={`${uid}-owner`} className="w-full">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Who can manage this key. Unassigned keys keep serving traffic.
          </p>
        </div>
      )}

      <div className="space-y-1">
        <Label htmlFor={`${uid}-system`} className="text-xs">
          System prompt
        </Label>
        <Textarea
          id={`${uid}-system`}
          rows={5}
          className="text-sm"
          placeholder="You are a helpful assistant for…"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${uid}-cap`} className="text-xs">
            Monthly token cap (blank = ∞)
          </Label>
          <Input
            id={`${uid}-cap`}
            value={tokenCap}
            inputMode="numeric"
            onChange={(e) => setTokenCap(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${uid}-rpm`} className="text-xs">
            Rate limit (req/min, blank = none)
          </Label>
          <Input
            id={`${uid}-rpm`}
            value={rpm}
            inputMode="numeric"
            onChange={(e) => setRpm(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <Label htmlFor={`${uid}-log`} className="text-sm">
            Log message content
          </Label>
          <p className="text-xs text-muted-foreground">
            Store inbound prompts &amp; model replies for this key (viewable in Logs, kept 30 days).
          </p>
        </div>
        <Switch id={`${uid}-log`} checked={logContent} onCheckedChange={setLogContent} />
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
              <Label htmlFor={`${uid}-temp`} className="text-xs">
                Temperature
              </Label>
              <Input
                id={`${uid}-temp`}
                inputMode="decimal"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="0.7"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-maxtokens`} className="text-xs">
                Max output tokens
              </Label>
              <Input
                id={`${uid}-maxtokens`}
                inputMode="numeric"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder="1024"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-topp`} className="text-xs">
                Top P
              </Label>
              <Input
                id={`${uid}-topp`}
                inputMode="decimal"
                value={topP}
                onChange={(e) => setTopP(e.target.value)}
                placeholder="1"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${uid}-schema`} className="text-xs">
              Output JSON schema (blank = plain text)
            </Label>
            <Textarea
              id={`${uid}-schema`}
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
