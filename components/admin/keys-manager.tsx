'use client';

import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Plus, Pencil, FlaskConical, Ban, RotateCw, Replace, Cable } from 'lucide-react';
import {
  createKey,
  updateKey,
  revokeKey,
  rotateKey,
  bulkUpdateKeyModel,
  bulkStartEvalRuns,
  type KeyFormInput,
  type BulkActionResult,
} from '@/app/admin/actions';
import { transcriptProcessorSelectionError } from '@/lib/admin/keys';
import type { KeyRow } from '@/lib/admin/queries';
import type { AvailableModel } from '@/lib/gateway/models';
import type { ProjectRole } from '@/components/admin/project-types';
import { projectPath } from '@/components/admin/project-path';
import type { EvalRunStatus } from '@/db/schema';
import { EvalDialog } from '@/components/admin/eval-dialog';
import { ModelCombobox } from '@/components/admin/model-combobox';
import { CapabilityCheckboxes } from '@/components/admin/capability-checkboxes';
import { TableSearchBox, useTableFilter } from '@/components/admin/table-search';
import { modelHasAllTags, capabilityLabel } from '@/lib/gateway/capabilities';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** Parses a positive whole number; '' → null (no limit); anything else → 'invalid'. */
function posIntOrNull(s: string): number | null | 'invalid' {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : 'invalid';
}
function quotaLabel(k: KeyRow, role: ProjectRole): string {
  const rpm = k.rpmLimit != null ? `${k.rpmLimit}/min` : '∞';
  // The monthly spend budget is admin-controlled and hidden from editors.
  if (role !== 'admin') return rpm;
  const cap = k.monthlyCostCapUsd != null ? `$${k.monthlyCostCapUsd.toLocaleString()}/mo` : '∞';
  return `${cap} · ${rpm}`;
}

/** Toast the outcome of a bulk action: one success line, one line naming any skips. */
function reportBulk(result: BulkActionResult, verb: string) {
  if (result.done > 0) {
    toast.success(`${verb} ${result.done} key${result.done === 1 ? '' : 's'}`);
  }
  if (result.stoppedEvals > 0) {
    toast.info(
      `Stopped ${result.stoppedEvals} running eval${result.stoppedEvals === 1 ? '' : 's'}`,
    );
  }
  if (result.skipped.length > 0) {
    toast.warning(
      `Skipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`,
      { duration: 8000 },
    );
  }
}

export function KeysManager({
  projectId,
  projectName,
  gatewayReady,
  keys,
  models,
  transcriptProcessorModels,
  modelsUnavailable = false,
  evalStatuses = {},
  judgeModel,
  role,
  users,
  knowledgebases = [],
}: {
  projectId: string;
  projectName: string;
  gatewayReady: boolean;
  keys: KeyRow[];
  models: AvailableModel[];
  /** Language models eligible to process a raw speech-to-text transcript. */
  transcriptProcessorModels: AvailableModel[];
  modelsUnavailable?: boolean;
  evalStatuses?: Record<string, EvalRunStatus>;
  judgeModel: string;
  role: ProjectRole;
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

  // Active and revoked keys live on separate tabs; everything below (search,
  // selection, table) operates within the visible tab. The search query
  // deliberately survives a tab switch — "find X wherever it is" reads well.
  const [tab, setTab] = useState<'active' | 'revoked'>('active');
  const activeKeys = keys.filter((k) => k.status === 'active');
  const revokedKeys = keys.filter((k) => k.status !== 'active');
  const statusKeys = tab === 'active' ? activeKeys : revokedKeys;

  // Free-text filter across everything visible in a row. The key prefix is
  // searchable too even though only the last-4 shows, since searching a key
  // fragment is natural.
  const { query, setQuery, filtered } = useTableFilter(statusKeys, (k) =>
    [k.name, k.keyPrefix, k.keyLast4, k.model, k.ownerEmail ?? 'unassigned', quotaLabel(k, role), k.status].join(' '),
  );

  // Bulk selection. Only ACTIVE keys are selectable (the bulk actions require an
  // active key anyway). The raw id set survives searching; what counts is derived
  // against the fresh rows each render, so a key revoked elsewhere silently drops
  // out rather than lingering as a stale selection.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkModelOpen, setBulkModelOpen] = useState(false);
  const [bulkEvalOpen, setBulkEvalOpen] = useState(false);
  const selectedKeys = keys.filter((k) => k.status === 'active' && selected.has(k.id));
  const filteredActive = filtered.filter((k) => k.status === 'active');
  const allFilteredSelected =
    filteredActive.length > 0 && filteredActive.every((k) => selected.has(k.id));

  function setKeySelected(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  // The header checkbox works on the rows currently shown, so search + select-all
  // composes into "select everything matching this query".
  function toggleAllFiltered(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of filteredActive) {
        if (on) next.add(k.id);
        else next.delete(k.id);
      }
      return next;
    });
  }

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
      {!gatewayReady && (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center">
          <Cable className="size-5 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Gateway setup required</p>
            <p className="text-sm text-muted-foreground">
              {role === 'admin'
                ? `Connect ${projectName} to Vercel AI Gateway before creating a Sophy API key.`
                : `A Project Admin must connect ${projectName} before Sophy API keys can be created or used.`}
            </p>
          </div>
          {role === 'admin' && (
            <Button variant="outline" render={<Link href={projectPath(projectId, 'settings')} />}>
              Connect Gateway
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {query.trim()
            ? `${filtered.length} of ${statusKeys.length} ${tab} keys`
            : `${statusKeys.length} ${tab} key${statusKeys.length === 1 ? '' : 's'}`}
        </h2>
        <Button size="sm" disabled={!gatewayReady} onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New Sophy API key
        </Button>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-h-[85vh] w-full overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>New Sophy API key</DialogTitle>
              <DialogDescription>
                Pick a model and write the system prompt. The key is shown once.
              </DialogDescription>
            </DialogHeader>
            <KeyForm
              projectId={projectId}
              mode="create"
              models={models}
              transcriptProcessorModels={transcriptProcessorModels}
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

      <Tabs
        value={tab}
        onValueChange={(v) => {
          // Guard the value like Select (base-ui can fire with null).
          if (v === 'active' || v === 'revoked') setTab(v);
        }}
      >
        <TabsList>
          <TabsTrigger value="active">Active ({activeKeys.length})</TabsTrigger>
          <TabsTrigger value="revoked">Revoked ({revokedKeys.length})</TabsTrigger>
        </TabsList>
      </Tabs>

      <TableSearchBox value={query} onChange={setQuery} placeholder="Search keys…" label="Search keys" />

      {tab === 'active' && selectedKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">
            {selectedKeys.length} key{selectedKeys.length === 1 ? '' : 's'} selected
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => setBulkModelOpen(true)}>
            <Replace className="h-3.5 w-3.5" />
            Change model…
          </Button>
          <Button size="sm" variant="outline" onClick={() => setBulkEvalOpen(true)}>
            <FlaskConical className="h-3.5 w-3.5" />
            Run eval…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              {/* Selection only exists on the Active tab — bulk actions require
                  active keys, so the Revoked tab drops the column entirely. */}
              {tab === 'active' && (
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="Select all keys shown"
                    checked={allFilteredSelected}
                    onCheckedChange={(c) => toggleAllFiltered(c === true)}
                    disabled={filteredActive.length === 0}
                  />
                </TableHead>
              )}
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
            {statusKeys.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={tab === 'active' ? 8 : 7}
                  className="h-24 text-center text-muted-foreground"
                >
                  {tab === 'revoked'
                    ? 'No revoked keys.'
                    : keys.length === 0
                      ? gatewayReady
                        ? 'No keys yet — create one with “New Sophy API key”.'
                        : 'No Sophy API keys yet — Gateway setup is required first.'
                      : 'No active keys.'}
                </TableCell>
              </TableRow>
            )}
            {statusKeys.length > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={tab === 'active' ? 8 : 7}
                  className="h-24 text-center text-muted-foreground"
                >
                  No {tab} keys match “{query.trim()}”.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((k) => (
              <TableRow key={k.id} data-state={tab === 'active' && selected.has(k.id) ? 'selected' : undefined}>
                {tab === 'active' && (
                  <TableCell>
                    <Checkbox
                      aria-label={`Select ${k.name}`}
                      checked={selected.has(k.id)}
                      onCheckedChange={(c) => setKeySelected(k.id, c === true)}
                    />
                  </TableCell>
                )}
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
                      projectId={projectId}
                      id={k.id}
                      name={k.name}
                      onRotated={(key) => {
                        setRotated(true);
                        setIssued(key);
                      }}
                    />
                  )}
                  {k.status === 'active' && (
                    <RevokeButton projectId={projectId} id={k.id} name={k.name} />
                  )}
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
              projectId={projectId}
              key={editing.id}
              mode="edit"
              keyId={editing.id}
              initial={editing}
              models={models}
              transcriptProcessorModels={transcriptProcessorModels}
              modelsUnavailable={modelsUnavailable}
              role={role}
              users={users}
              knowledgebases={knowledgebases}
              evalRunning={evalStatuses[editing.id] === 'running'}
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
          projectId={projectId}
          key={evalShown.id}
          keyRow={{ id: evalShown.id, name: evalShown.name, model: evalShown.model }}
          models={models}
          initialStatus={evalStatuses[evalShown.id]}
          judgeModel={judgeModel}
          open={evalKey?.id === evalShown.id}
          onOpenChange={(o) => !o && setEvalKey(null)}
        />
      )}

      {/* Bulk dialogs — mounted permanently (like the edit modal) so open/close
          animates; they read the live selection each render. */}
      <BulkModelDialog
        projectId={projectId}
        open={bulkModelOpen}
        onOpenChange={setBulkModelOpen}
        keys={selectedKeys}
        models={models}
        modelsUnavailable={modelsUnavailable}
        evalStatuses={evalStatuses}
        onDone={() => setSelected(new Set())}
      />
      <BulkEvalDialog
        projectId={projectId}
        open={bulkEvalOpen}
        onOpenChange={setBulkEvalOpen}
        keys={selectedKeys}
        models={models}
        judgeModel={judgeModel}
        evalStatuses={evalStatuses}
        onDone={() => setSelected(new Set())}
      />

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
            <DialogTitle>{rotated ? 'Sophy API key rotated' : 'Sophy API key created'}</DialogTitle>
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

/** Compact name + current-model listing shared by the bulk dialogs. */
function SelectedKeysList({ keys }: { keys: KeyRow[] }) {
  return (
    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
      {keys.map((k) => (
        <div key={k.id} className="flex items-center justify-between gap-3 text-xs">
          <span className="truncate font-medium">{k.name}</span>
          <code className="shrink-0 text-muted-foreground">{k.model}</code>
        </div>
      ))}
    </div>
  );
}

function BulkModelDialog({
  projectId,
  open,
  onOpenChange,
  keys,
  models,
  modelsUnavailable = false,
  evalStatuses,
  onDone,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  keys: KeyRow[];
  models: AvailableModel[];
  modelsUnavailable?: boolean;
  evalStatuses: Record<string, EvalRunStatus>;
  onDone: () => void;
}) {
  const uid = useId();
  const [isPending, startTransition] = useTransition();
  const [model, setModel] = useState('');
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);

  // Keys whose running eval the change would invalidate. Keys already on the
  // chosen model are excluded — they're skipped server-side, eval untouched.
  const runningEvalKeys = keys.filter((k) => evalStatuses[k.id] === 'running');
  const evalStopKeys = runningEvalKeys.filter((k) => k.model !== model.trim());

  function submit() {
    if (!model.trim()) return toast.error('Pick a model');
    // A model change stops a running eval — never do that silently. Only the
    // keys this dialog NAMES are sent as confirmed stops; a running eval the
    // snapshot didn't know about makes the server skip that key, not cancel it.
    if (evalStopKeys.length > 0) {
      setConfirmStopOpen(true);
      return;
    }
    doSubmit([]);
  }

  function doSubmit(stopEvalIds: string[]) {
    startTransition(async () => {
      try {
        const res = await bulkUpdateKeyModel({
          projectId,
          ids: keys.map((k) => k.id),
          model: model.trim(),
          stopEvalIds,
        });
        reportBulk(res, 'Model updated on');
        onDone();
        setConfirmStopOpen(false);
        onOpenChange(false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        toast.error(
          msg === 'unauthorized'
            ? 'Your session expired — please sign in again.'
            : msg || 'Could not update the keys',
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Change model — {keys.length} key{keys.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            Point every selected key at a new model. Applies on the next request — no redeploy.
            Keys already on the chosen model are left as they are.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor={`${uid}-bulk-model`} className="text-xs">
              New model
            </Label>
            <ModelCombobox
              id={`${uid}-bulk-model`}
              value={model}
              onValueChange={setModel}
              models={models.map((m) => m.id)}
              modelsUnavailable={modelsUnavailable}
              placeholder="anthropic/claude-sonnet-4.6"
            />
          </div>

          <SelectedKeysList keys={keys} />

          {runningEvalKeys.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {runningEvalKeys.length === 1 ? '1 selected key has' : `${runningEvalKeys.length} selected keys have`}{' '}
              a running eval — a model change invalidates it, so it will be stopped (you’ll be
              asked to confirm).
            </p>
          )}

          <div className="flex justify-end">
            <Button onClick={submit} disabled={isPending || keys.length === 0}>
              {isPending
                ? 'Updating…'
                : `Change model on ${keys.length} key${keys.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>

        {/* Confirmation before stopping running evals as part of the change. */}
        <AlertDialog open={confirmStopOpen} onOpenChange={setConfirmStopOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Stop {evalStopKeys.length === 1 ? 'the running eval' : `${evalStopKeys.length} running evals`}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {evalStopKeys.map((k) => k.name).join(', ')}{' '}
                {evalStopKeys.length === 1 ? 'has' : 'have'} an eval in progress. Changing the
                model invalidates its results, so continuing will stop{' '}
                {evalStopKeys.length === 1 ? 'that eval' : 'those evals'} and discard the partial
                results, then change the model.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending}
                onClick={(e) => {
                  e.preventDefault();
                  doSubmit(evalStopKeys.map((k) => k.id));
                }}
              >
                {evalStopKeys.length === 1
                  ? 'Stop eval & change model'
                  : 'Stop evals & change model'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

function BulkEvalDialog({
  projectId,
  open,
  onOpenChange,
  keys,
  models,
  judgeModel,
  evalStatuses,
  onDone,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  keys: KeyRow[];
  models: AvailableModel[];
  judgeModel: string;
  evalStatuses: Record<string, EvalRunStatus>;
  onDone: () => void;
}) {
  const uid = useId();
  const [isPending, startTransition] = useTransition();
  // Evals compare text outputs, so challengers are language models only (same
  // rule as the single-key eval dialog).
  const options = models.filter((m) => m.type === 'language');
  const [challenger, setChallenger] = useState(options[0]?.id ?? '');
  const [targetN, setTargetN] = useState('100');
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);

  // Keys the dialog announces as skipped (already on the challenger) are NOT
  // submitted — the button's count is a promise. Keys with a running eval ARE
  // startable: their current run is stopped and replaced, behind an explicit
  // confirmation. The server re-checks every invariant live either way.
  const sameModel = keys.filter((k) => k.model === challenger.trim());
  const startableKeys = keys.filter((k) => k.model !== challenger.trim());
  const startable = startableKeys.length;
  const replaceEvalKeys = startableKeys.filter((k) => evalStatuses[k.id] === 'running');

  function submit() {
    if (!challenger.trim()) return toast.error('Pick a challenger model');
    const n = Number(targetN);
    if (!Number.isInteger(n) || n <= 0) {
      return toast.error('Sample size must be a positive whole number');
    }
    // Starting a new eval replaces a key's running one — never silently. Only
    // the keys this dialog NAMES are sent as confirmed stops; a running eval
    // the snapshot didn't know about makes the server skip that key.
    if (replaceEvalKeys.length > 0) {
      setConfirmStopOpen(true);
      return;
    }
    doSubmit([]);
  }

  function doSubmit(stopEvalIds: string[]) {
    startTransition(async () => {
      try {
        const res = await bulkStartEvalRuns({
          projectId,
          ids: startableKeys.map((k) => k.id),
          challengerModel: challenger.trim(),
          targetN: Number(targetN),
          stopEvalIds,
        });
        reportBulk(res, 'Eval started on');
        onDone();
        setConfirmStopOpen(false);
        onOpenChange(false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        toast.error(
          msg === 'unauthorized'
            ? 'Your session expired — please sign in again.'
            : msg || 'Could not start the evals',
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Run eval — {keys.length} key{keys.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            Shadow the same challenger against each selected key’s current model, judged blind by{' '}
            <code>{judgeModel}</code>. Each key gets its own run and email verdict.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor={`${uid}-bulk-challenger`} className="text-xs">
              Challenger model
            </Label>
            <ModelCombobox
              id={`${uid}-bulk-challenger`}
              value={challenger}
              onValueChange={setChallenger}
              models={options.map((m) => m.id)}
              placeholder="anthropic/claude-sonnet-4.6"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor={`${uid}-bulk-n`} className="text-xs">
              Sample size per key (transactions)
            </Label>
            <Input
              id={`${uid}-bulk-n`}
              inputMode="numeric"
              value={targetN}
              onChange={(e) => setTargetN(e.target.value)}
              className="w-32"
            />
          </div>

          <SelectedKeysList keys={keys} />

          {replaceEvalKeys.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Eval already running on {replaceEvalKeys.map((k) => k.name).join(', ')} — it will be
              stopped and replaced by this new eval (you’ll be asked to confirm).
            </p>
          )}
          {sameModel.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Skipped ({sameModel.length}) — already on the challenger model:{' '}
              {sameModel.map((k) => k.name).join(', ')}.
            </p>
          )}

          <div className="flex justify-end">
            <Button onClick={submit} disabled={isPending || startable <= 0}>
              {isPending
                ? 'Starting…'
                : `Start ${startable} eval${startable === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>

        {/* Confirmation before stopping the running evals that this batch replaces. */}
        <AlertDialog open={confirmStopOpen} onOpenChange={setConfirmStopOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Stop {replaceEvalKeys.length === 1 ? 'the running eval' : `${replaceEvalKeys.length} running evals`}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {replaceEvalKeys.map((k) => k.name).join(', ')}{' '}
                {replaceEvalKeys.length === 1 ? 'has' : 'have'} an eval in progress. Starting a new
                eval will stop the current one and discard its partial results.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending}
                onClick={(e) => {
                  e.preventDefault();
                  doSubmit(replaceEvalKeys.map((k) => k.id));
                }}
              >
                Stop &amp; start new evals
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

function RevokeButton({ projectId, id, name }: { projectId: string; id: string; name: string }) {
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
                    await revokeKey({ projectId, id });
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
  projectId,
  id,
  name,
  onRotated,
}: {
  projectId: string;
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
                    const { fullKey } = await rotateKey({ projectId, id });
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
  projectId,
  mode,
  keyId,
  initial,
  models,
  transcriptProcessorModels,
  modelsUnavailable = false,
  role,
  users,
  knowledgebases,
  evalRunning = false,
  onIssued,
  onDone,
}: {
  projectId: string;
  mode: 'create' | 'edit';
  keyId?: string;
  initial?: KeyRow;
  models: AvailableModel[];
  transcriptProcessorModels: AvailableModel[];
  modelsUnavailable?: boolean;
  role: ProjectRole;
  users: { id: string; email: string }[];
  knowledgebases: { id: string; name: string }[];
  /** Page-load hint that this key has an eval in progress (edit mode only). */
  evalRunning?: boolean;
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
  const [allowClientPrompt, setAllowClientPrompt] = useState(
    initial?.params.allowClientPrompt ?? false,
  );
  const [transcriptProcessorModel, setTranscriptProcessorModel] = useState(
    (
      initial?.params as KeyRow['params'] & {
        transcriptProcessorModel?: string;
      }
    )?.transcriptProcessorModel ?? '',
  );
  const [schemaText, setSchemaText] = useState(
    initial?.outputSchema ? JSON.stringify(initial.outputSchema, null, 2) : '',
  );
  const [ownerUserId, setOwnerUserId] = useState(initial?.ownerUserId ?? '');
  const [knowledgebaseId, setKnowledgebaseId] = useState(initial?.knowledgebaseId ?? '');
  // Client-side filter aid (not persisted): narrow the model picker to models
  // that have ALL the ticked capabilities.
  const [requiredCaps, setRequiredCaps] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Confirmation before a model change stops the key's running eval. Opened
  // upfront from the page-load hint, or by the server's requiresEvalStop reply
  // when that hint was stale.
  const [confirmStopEval, setConfirmStopEval] = useState(false);

  const filteredModels = requiredCaps.length
    ? models.filter((m) => modelHasAllTags(m, requiredCaps))
    : models;
  const currentModel = models.find((m) => m.id === model);
  const isTranscriptionModel = currentModel?.type === 'transcription';
  const missingCaps = currentModel
    ? requiredCaps.filter((c) => !currentModel.tags.includes(c))
    : [];

  function submit(stopEval = false) {
    if (!name.trim()) return toast.error('Name is required');
    if (!model.trim()) return toast.error('Model is required');
    const transcriptProcessorError = transcriptProcessorSelectionError({
      primaryModel: currentModel,
      systemPrompt,
      transcriptProcessorModel,
      models,
    });
    if (transcriptProcessorError) return toast.error(transcriptProcessorError);

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

    const keyParams = {
      ...initial?.params,
      temperature: temp,
      maxOutputTokens: maxOut,
      topP: topPV,
      // Off serializes out of the jsonb like the blank fields — absent = disabled.
      allowClientPrompt: allowClientPrompt || undefined,
      // This second model is meaningful only for batch transcription keys. If
      // the catalog is temporarily unavailable, preserve the stored value
      // instead of silently deleting configuration we cannot classify.
      ...(currentModel
        ? {
            transcriptProcessorModel: isTranscriptionModel
              ? transcriptProcessorModel.trim() || undefined
              : undefined,
          }
        : {}),
    } as KeyFormInput['params'] & { transcriptProcessorModel?: string };

    const input: KeyFormInput = {
      name: name.trim(),
      model: model.trim(),
      systemPrompt: systemPrompt.trim() ? systemPrompt : null,
      // Spread the original params so any field we don't surface survives an edit;
      // blank UI fields serialize out of the jsonb as undefined.
      params: keyParams,
      outputSchema,
      monthlyCostCapUsd: costCapV,
      rpmLimit: rpmV,
      logContent,
      // Owner is admin-only; the server forces self-ownership for editors regardless.
      ownerUserId: role === 'admin' ? ownerUserId || null : undefined,
      knowledgebaseId: knowledgebaseId || null,
    };
    // A model change invalidates the key's running eval — never stop it without
    // asking. The page-load hint triggers the confirmation here; if the hint is
    // stale (eval started after load), the server's requiresEvalStop reply below
    // opens the same dialog.
    const modelChanged = mode === 'edit' && initial != null && model.trim() !== initial.model;
    if (!stopEval && evalRunning && modelChanged) {
      setConfirmStopEval(true);
      return;
    }

    startTransition(async () => {
      try {
        if (mode === 'create') {
          const { fullKey } = await createKey({ projectId, ...input });
          onIssued?.(fullKey);
          toast.success('Key created');
        } else {
          const res = await updateKey({ projectId, id: keyId!, ...input, stopRunningEval: stopEval });
          if (res.requiresEvalStop) {
            setConfirmStopEval(true);
            return;
          }
          setConfirmStopEval(false);
          toast.success(
            res.stoppedEval
              ? 'Saved — the running eval was stopped'
              : 'Saved — applies to the next request',
          );
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

      {isTranscriptionModel && (
        <div className="space-y-1.5 rounded-md border border-primary/20 bg-primary/5 p-3">
          <Label htmlFor={`${uid}-transcript-processor`} className="text-xs">
            Transcript processor{systemPrompt.trim() ? ' (required)' : ' (optional)'}
          </Label>
          <ModelCombobox
            id={`${uid}-transcript-processor`}
            value={transcriptProcessorModel}
            onValueChange={setTranscriptProcessorModel}
            models={transcriptProcessorModels.map((candidate) => candidate.id)}
            modelsUnavailable={modelsUnavailable}
            placeholder="Select a language model…"
          />
          <p className="text-xs text-muted-foreground">
            Speech-to-text creates the raw transcript first. This language model then applies the
            system prompt—for example, to clean up, translate, summarize, or extract action items.
            Leave both this field and the system prompt blank to return the raw transcript.
          </p>
        </div>
      )}

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

      {knowledgebases.length > 0 && !isTranscriptionModel && (
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
          placeholder={
            isTranscriptionModel
              ? 'For example: Summarize the transcript and list action items.'
              : 'You are a helpful assistant for…'
          }
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
        {isTranscriptionModel && (
          <p className="text-xs text-muted-foreground">
            Applied after speech-to-text by the transcript processor selected above.
          </p>
        )}
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
            {isTranscriptionModel
              ? 'Store the filename, language hint, raw transcript, and final text for 30 days. Audio bytes are never stored.'
              : 'Store text and model replies for 30 days. Complete image input values are discarded after 7 days; the log keeps a placeholder.'}
          </p>
        </div>
        <Switch id={`${uid}-log`} checked={logContent} onCheckedChange={setLogContent} />
      </div>

      <button
        type="button"
        className="text-xs text-muted-foreground underline"
        onClick={() => setShowAdvanced((s) => !s)}
      >
        {showAdvanced
          ? 'Hide advanced'
          : isTranscriptionModel
            ? 'Advanced (processor parameters)'
            : 'Advanced (params, structured output)'}
      </button>

      {showAdvanced && (
        <div className="space-y-4 rounded-md border p-3">
          {isTranscriptionModel && (
            <p className="text-xs text-muted-foreground">
              These generation settings apply only to the transcript processor. Agent mode,
              output schemas, and knowledgebases are not used by the audio transcription endpoint.
            </p>
          )}
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
          {!isTranscriptionModel && (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <Label htmlFor={`${uid}-agent`} className="text-sm">
                  Agent mode — honor the client&apos;s prompt
                </Label>
                <p className="text-xs text-muted-foreground">
                  Appends the client&apos;s own system prompt (leading system/developer messages,
                  or <code>instructions</code>) after this key&apos;s prompt — for server-side
                  agentic SDK flows whose instructions change per request. Client prompts run at
                  operator level: enable only for keys used by server-side apps that build the
                  message array themselves and never forward end-user-authored system messages.
                </p>
              </div>
              <Switch
                id={`${uid}-agent`}
                checked={allowClientPrompt}
                onCheckedChange={setAllowClientPrompt}
              />
            </div>
          )}
          {!isTranscriptionModel && (
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
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        {/* () => submit() — passing the handler directly would hand the click
            event to the stopEval param, silently skipping the confirmation. */}
        <Button onClick={() => submit()} disabled={isPending}>
          {isPending ? 'Saving…' : mode === 'create' ? 'Create key' : 'Save changes'}
        </Button>
      </div>

      {/* Confirmation before a model change stops this key's running eval. */}
      <AlertDialog open={confirmStopEval} onOpenChange={setConfirmStopEval}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the running eval?</AlertDialogTitle>
            <AlertDialogDescription>
              An eval is running on this key. Changing the model invalidates its results, so
              saving will stop the eval and discard its partial results.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault();
                submit(true);
              }}
            >
              Stop eval &amp; save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
