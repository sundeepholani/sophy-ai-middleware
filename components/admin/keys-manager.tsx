'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, FlaskConical, Ban, RotateCw, Search, X } from 'lucide-react';
import { createKey, updateKey, revokeKey, rotateKey, type KeyFormInput } from '@/app/admin/actions';
import type { KeyRow } from '@/lib/admin/queries';
import type { AvailableModel } from '@/lib/gateway/models';
import type { SessionRole } from '@/lib/auth/session-config';
import type { EvalRunStatus } from '@/db/schema';
import { EvalDialog } from '@/components/admin/eval-dialog';
import { ModelCombobox } from '@/components/admin/model-combobox';
import { CapabilityCheckboxes } from '@/components/admin/capability-checkboxes';
import { modelHasAllTags, capabilityLabel } from '@/lib/gateway/capabilities';
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
function quotaLabel(k: KeyRow, role: SessionRole): string {
  const rpm = k.rpmLimit != null ? `${k.rpmLimit}/min` : '∞';
  // The monthly spend budget is admin-controlled and hidden from editors.
  if (role !== 'admin') return rpm;
  const cap = k.monthlyCostCapUsd != null ? `$${k.monthlyCostCapUsd.toLocaleString()}/mo` : '∞';
  return `${cap} · ${rpm}`;
}

export function KeysManager({
  keys,
  models,
  modelsUnavailable = false,
  evalStatuses = {},
  judgeModel,
  role,
  users,
  knowledgebases = [],
}: {
  keys: KeyRow[];
  models: AvailableModel[];
  modelsUnavailable?: boolean;
  evalStatuses?: Record<string, EvalRunStatus>;
  judgeModel: string;
  role: SessionRole;
  users: { id: string; email: string }[];
  knowledgebases?: { id: string; name: string }[];
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<KeyRow | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  // Whether the revealed key came from a rotation (vs. a fresh create) — only
  // affects the reveal dialog's wording.
  const [rotated, setRotated] = useState(false);
  // `evalKey` drives whether the eval modal is OPEN; `evalShown` is the last key it
  // showed and keeps it MOUNTED so the close animation can play before unmount
  // (mirrors the always-mounted edit dialog). Opening sets both; closing clears only
  // evalKey, so the dialog animates out with its content still present.
  const [evalKey, setEvalKey] = useState<KeyRow | null>(null);
  const [evalShown, setEvalShown] = useState<KeyRow | null>(null);

  // Free-text filter across everything visible in a row (case-insensitive; all
  // space-separated terms must match). The key prefix is searchable too even
  // though only the last-4 shows, since searching a key fragment is natural.
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return keys;
    const terms = q.split(/\s+/);
    return keys.filter((k) => {
      const hay = [
        k.name,
        k.keyPrefix,
        k.keyLast4,
        k.model,
        k.ownerEmail ?? 'unassigned',
        quotaLabel(k, role),
        k.status,
      ]
        .join(' ')
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [keys, query, role]);

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
          {query.trim()
            ? `${filtered.length} of ${keys.length} keys`
            : `${keys.length} key${keys.length === 1 ? '' : 's'}`}
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
              knowledgebases={knowledgebases}
              onIssued={(k) => {
                setRotated(false);
                setIssued(k);
              }}
              onDone={() => setCreateOpen(false)}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search keys…"
          aria-label="Search keys"
          className="pr-8 pl-8"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery('')}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
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
            {keys.length > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No keys match “{query.trim()}”.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((k) => (
              <TableRow key={k.id}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  …{k.keyLast4}
                </TableCell>
                <TableCell className="font-mono text-xs">{k.model}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {k.ownerEmail ?? <span className="italic">Unassigned</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {quotaLabel(k, role)}
                </TableCell>
                <TableCell>
                  <Badge variant={k.status === 'active' ? 'default' : 'destructive'}>
                    {k.status}
                  </Badge>
                </TableCell>
                <TableCell className="space-x-0.5 text-right">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Edit key"
                    title="Edit"
                    onClick={() => setEditing(k)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {k.status === 'active' && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Run eval"
                      title="Eval"
                      className="relative"
                      onClick={() => {
                        setEvalShown(k);
                        setEvalKey(k);
                      }}
                    >
                      <FlaskConical className="h-3.5 w-3.5" />
                      {evalStatuses[k.id] === 'running' && (
                        <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </Button>
                  )}
                  {k.status === 'active' && (
                    <RotateButton
                      id={k.id}
                      name={k.name}
                      onRotated={(key) => {
                        setRotated(true);
                        setIssued(key);
                      }}
                    />
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
              knowledgebases={knowledgebases}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Eval modal — kept mounted via `evalShown` so the close animation plays;
          `open` is driven by `evalKey`. Keying on evalShown.id remounts (resetting
          the dialog's polling/state) when a different key is opened. */}
      {evalShown && (
        <EvalDialog
          key={evalShown.id}
          keyRow={{ id: evalShown.id, name: evalShown.name, model: evalShown.model }}
          models={models}
          initialStatus={evalStatuses[evalShown.id]}
          judgeModel={judgeModel}
          open={evalKey?.id === evalShown.id}
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
            <DialogTitle>{rotated ? 'API key rotated' : 'API key created'}</DialogTitle>
            <DialogDescription>
              {rotated
                ? 'The previous key has stopped working. Copy the new key now — it is shown only once and cannot be retrieved later.'
                : 'Copy this now — it is shown only once and cannot be retrieved later.'}
            </DialogDescription>
          </DialogHeader>
          <code className="block select-all break-all rounded-md bg-muted p-3 text-sm">
            {issued}
          </code>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIssued(null);
                setRotated(false);
              }}
            >
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
        size="icon-sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        aria-label="Revoke key"
        title="Revoke"
        onClick={() => setOpen(true)}
      >
        <Ban className="h-3.5 w-3.5" />
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

function RotateButton({
  id,
  name,
  onRotated,
}: {
  id: string;
  name: string;
  onRotated: (fullKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Rotate key"
        title="Rotate"
        onClick={() => setOpen(true)}
      >
        <RotateCw className="h-3.5 w-3.5" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate “{name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              A new secret is generated and shown once. The current key stops working
              immediately, so update anything using it right away. The model, prompt, quota,
              owner, and any attached knowledgebase are kept.
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
                    const { fullKey } = await rotateKey(id);
                    setOpen(false);
                    onRotated(fullKey);
                    toast.success('Key rotated');
                  } catch (err) {
                    toast.error(
                      err instanceof Error && err.message ? err.message : 'Failed to rotate',
                    );
                  }
                });
              }}
            >
              Rotate
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
  knowledgebases,
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
  knowledgebases: { id: string; name: string }[];
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
  const [costCap, setCostCap] = useState(
    initial ? (initial.monthlyCostCapUsd != null ? String(initial.monthlyCostCapUsd) : '') : '100',
  );
  const [rpm, setRpm] = useState(initial?.rpmLimit?.toString() ?? '');
  const [logContent, setLogContent] = useState(initial?.logContent ?? true);
  const [schemaText, setSchemaText] = useState(
    initial?.outputSchema ? JSON.stringify(initial.outputSchema, null, 2) : '',
  );
  const [ownerUserId, setOwnerUserId] = useState(initial?.ownerUserId ?? '');
  const [knowledgebaseId, setKnowledgebaseId] = useState(initial?.knowledgebaseId ?? '');
  // Client-side filter aid (not persisted): narrow the model picker to models
  // that have ALL the ticked capabilities.
  const [requiredCaps, setRequiredCaps] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const filteredModels = requiredCaps.length
    ? models.filter((m) => modelHasAllTags(m, requiredCaps))
    : models;
  const currentModel = models.find((m) => m.id === model);
  const missingCaps = currentModel
    ? requiredCaps.filter((c) => !currentModel.tags.includes(c))
    : [];

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

    // Rate limit: positive whole number (blank = no limit).
    const rpmV = posIntOrNull(rpm);
    if (rpmV === 'invalid') return toast.error('Rate limit must be a positive whole number');

    // Monthly cost budget ($): admin-only; blank = unlimited; decimals allowed.
    let costCapV: number | null | undefined;
    if (role === 'admin') {
      if (costCap.trim()) {
        const n = Number(costCap);
        if (!Number.isFinite(n) || n <= 0) {
          return toast.error('Monthly budget must be a positive amount');
        }
        costCapV = n;
      } else {
        costCapV = null; // unlimited
      }
    }

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
      monthlyCostCapUsd: costCapV,
      rpmLimit: rpmV,
      logContent,
      // Owner is admin-only; the server forces self-ownership for editors regardless.
      ownerUserId: role === 'admin' ? ownerUserId || null : undefined,
      knowledgebaseId: knowledgebaseId || null,
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

      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-model`} className="text-xs">
          Model
        </Label>
        <ModelCombobox
          id={`${uid}-model`}
          value={model}
          onValueChange={setModel}
          models={filteredModels.map((m) => m.id)}
          modelsUnavailable={modelsUnavailable}
          placeholder="anthropic/claude-sonnet-4.6"
        />
        {models.length > 0 && (
          <div className="space-y-1.5 rounded-md border p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Filter by capability
              </span>
              <span className="text-xs text-muted-foreground">
                {filteredModels.length} of {models.length} models
              </span>
            </div>
            <CapabilityCheckboxes
              selected={requiredCaps}
              onToggle={(tag) =>
                setRequiredCaps((prev) =>
                  prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
                )
              }
              idPrefix={`${uid}-cap`}
            />
            {requiredCaps.length > 0 && filteredModels.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No models provide all selected capabilities — clear some, or type a model id.
              </p>
            )}
            {missingCaps.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                The selected model doesn’t provide: {missingCaps.map(capabilityLabel).join(', ')}.
              </p>
            )}
          </div>
        )}
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

      {knowledgebases.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-kb`} className="text-xs">
            Knowledgebase
          </Label>
          <Select
            items={[
              { label: 'None', value: 'none' },
              ...knowledgebases.map((k) => ({ label: k.name, value: k.id })),
            ]}
            value={knowledgebaseId || 'none'}
            onValueChange={(v) => {
              if (v != null) setKnowledgebaseId(v === 'none' ? '' : (v as string));
            }}
          >
            <SelectTrigger id={`${uid}-kb`} className="w-full">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {knowledgebases.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Ground this key’s answers in the knowledgebase’s documents (retrieved per request).
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
        {/* Monthly spend budget is admin-controlled; editors never see or set it. */}
        {role === 'admin' && (
          <div className="space-y-1">
            <Label htmlFor={`${uid}-cap`} className="text-xs">
              Monthly budget ($, blank = ∞)
            </Label>
            <Input
              id={`${uid}-cap`}
              value={costCap}
              inputMode="decimal"
              onChange={(e) => setCostCap(e.target.value)}
            />
          </div>
        )}
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
            <p className="text-xs text-muted-foreground">
              Normalized on save to work on any model: optional fields become nullable and required,
              and an OpenAI <code>{'{ name, schema, strict }'}</code> wrapper is unwrapped. Reopen the
              key to see the stored form.
            </p>
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
