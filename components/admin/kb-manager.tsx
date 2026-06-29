'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Plus, Library, Trash2, RefreshCw, Upload, FileText } from 'lucide-react';
import {
  createKnowledgebase,
  deleteKnowledgebase,
  deleteKbDocument,
  retryKbDocument,
  uploadKbDocumentAction,
  listKbDocumentsAction,
} from '@/app/admin/kb-actions';
import type { KnowledgebaseRow, KbDocumentRow } from '@/lib/admin/queries';
import type { KbDocStatus } from '@/db/schema';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableSearchBox, useTableFilter } from '@/components/admin/table-search';

const ACCEPT =
  '.txt,.md,.markdown,.csv,.json,.pdf,.docx,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const STATUS_VARIANT: Record<KbDocStatus, 'default' | 'secondary' | 'destructive'> = {
  ingested: 'default',
  pending: 'secondary',
  failed: 'destructive',
};

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (m === 'unauthorized') return 'Your session expired — please sign in again.';
  if (m === 'forbidden') return 'You don’t have permission to do that.';
  return m || 'Something went wrong.';
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function KbManager({ knowledgebases }: { knowledgebases: KnowledgebaseRow[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [managing, setManaging] = useState<KnowledgebaseRow | null>(null);
  const { query, setQuery, filtered } = useTableFilter(knowledgebases, (kb) =>
    [kb.name, kb.embeddingModel].join(' '),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {query.trim()
            ? `${filtered.length} of ${knowledgebases.length} knowledgebases`
            : `${knowledgebases.length} knowledgebase${knowledgebases.length === 1 ? '' : 's'}`}
        </h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New knowledgebase
        </Button>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>New knowledgebase</DialogTitle>
              <DialogDescription>
                Give it a name, then add documents. They’re embedded with
                <code className="mx-1 rounded bg-muted px-1 text-xs">openai/text-embedding-3-small</code>
                in the background.
              </DialogDescription>
            </DialogHeader>
            <CreateForm onDone={() => setCreateOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

      <TableSearchBox
        value={query}
        onChange={setQuery}
        placeholder="Search knowledgebases…"
        label="Search knowledgebases"
      />

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Embedding model</TableHead>
              <TableHead className="text-right">Documents</TableHead>
              <TableHead className="text-right">Keys</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {knowledgebases.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No knowledgebases yet — create one with “New knowledgebase”.
                </TableCell>
              </TableRow>
            )}
            {knowledgebases.length > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No knowledgebases match “{query.trim()}”.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((kb) => (
              <KbRowItem key={kb.id} kb={kb} onManage={() => setManaging(kb)} />
            ))}
          </TableBody>
        </Table>
      </div>

      {managing && (
        <DocumentsDialog key={managing.id} kb={managing} onClose={() => setManaging(null)} />
      )}
    </div>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState('');

  function submit() {
    if (!name.trim()) return toast.error('Name is required');
    startTransition(async () => {
      try {
        await createKnowledgebase({ name: name.trim() });
        toast.success('Knowledgebase created');
        onDone();
      } catch (e) {
        toast.error(errMsg(e));
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="kb-name" className="text-xs">
          Name
        </Label>
        <Input
          id="kb-name"
          placeholder="Product docs"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="flex justify-end">
        <Button onClick={submit} disabled={isPending}>
          {isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  );
}

function KbRowItem({ kb, onManage }: { kb: KnowledgebaseRow; onManage: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function remove() {
    startTransition(async () => {
      try {
        await deleteKnowledgebase({ id: kb.id });
        toast.success('Knowledgebase deleted');
        setConfirmOpen(false);
      } catch (e) {
        toast.error(errMsg(e));
      }
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <span className="flex items-center gap-2">
          <Library className="h-4 w-4 shrink-0 text-muted-foreground" />
          {kb.name}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{kb.embeddingModel}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{kb.documentCount}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{kb.attachedKeyCount}</TableCell>
      <TableCell className="space-x-1 text-right">
        <Button size="sm" variant="ghost" onClick={onManage}>
          <FileText className="h-4 w-4" />
          Documents
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete knowledgebase"
          title="Delete"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{kb.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes the knowledgebase, its {kb.documentCount} document
                {kb.documentCount === 1 ? '' : 's'}, and all embedded chunks. Keys must be detached
                first. This can’t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending}
                onClick={(e) => {
                  e.preventDefault();
                  remove();
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function DocumentsDialog({ kb, onClose }: { kb: KnowledgebaseRow; onClose: () => void }) {
  const [docs, setDocs] = useState<KbDocumentRow[] | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { query, setQuery, filtered } = useTableFilter(docs ?? [], (d) =>
    [d.filename, d.status].join(' '),
  );

  function load() {
    startRefresh(async () => {
      try {
        setDocs(await listKbDocumentsAction(kb.id));
      } catch (e) {
        toast.error(errMsg(e));
      }
    });
  }

  // Load the document list when the dialog opens (async setState — fine).
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return toast.error('Choose a file first');
    setUploading(true);
    const fd = new FormData();
    fd.set('kbId', kb.id);
    fd.set('file', file);
    (async () => {
      try {
        await uploadKbDocumentAction(fd);
        toast.success(`Uploaded ${file.name} — ingesting shortly`);
        if (fileRef.current) fileRef.current.value = '';
        load();
      } catch (e) {
        toast.error(errMsg(e));
      } finally {
        setUploading(false);
      }
    })();
  }

  const pending = docs?.some((d) => d.status === 'pending') ?? false;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] w-full overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Documents — {kb.name}</DialogTitle>
          <DialogDescription>
            Upload text, Markdown, CSV, JSON, PDF, or Word (.docx), up to 4 MB each. Ingestion runs
            in the background (every ~15 min); use Refresh to update status.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="kb-file" className="text-xs">
              Add a document
            </Label>
            <input
              id="kb-file"
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
            />
          </div>
          <Button onClick={upload} disabled={uploading}>
            <Upload className="h-4 w-4" />
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {docs == null
              ? 'Loading…'
              : query.trim()
                ? `${filtered.length} of ${docs.length} documents`
                : `${docs.length} document${docs.length === 1 ? '' : 's'}`}
            {pending && ' · some pending ingestion'}
          </span>
          <Button size="sm" variant="ghost" onClick={load} disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {docs != null && docs.length > 0 && (
          <TableSearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search documents…"
            label="Search documents"
            className="max-w-none"
          />
        )}

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Chunks</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs != null && docs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    No documents yet.
                  </TableCell>
                </TableRow>
              )}
              {docs != null && docs.length > 0 && filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    No documents match “{query.trim()}”.
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((d) => (
                <DocRowItem key={d.id} doc={d} onChanged={load} />
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DocRowItem({ doc, onChanged }: { doc: KbDocumentRow; onChanged: () => void }) {
  const [isPending, startTransition] = useTransition();

  function run(fn: () => Promise<void>, ok: string) {
    startTransition(async () => {
      try {
        await fn();
        toast.success(ok);
        onChanged();
      } catch (e) {
        toast.error(errMsg(e));
      }
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <span className="block max-w-[16rem] truncate" title={doc.filename}>
          {doc.filename}
        </span>
        {doc.status === 'failed' && doc.errorMessage && (
          <span className="block max-w-[16rem] truncate text-xs text-destructive" title={doc.errorMessage}>
            {doc.errorMessage}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[doc.status]}>{doc.status}</Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{doc.chunkCount}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtBytes(doc.bytes)}</TableCell>
      <TableCell className="space-x-1 text-right">
        {doc.status === 'failed' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={isPending}
            onClick={() => run(() => retryKbDocument({ id: doc.id }), 'Re-queued for ingestion')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete document"
          title="Delete"
          disabled={isPending}
          className="text-destructive hover:text-destructive"
          onClick={() => run(() => deleteKbDocument({ id: doc.id }), 'Document deleted')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
