'use client';

// @types/react 19.2 deprecates FormEvent; onSubmit is typed with SubmitEvent.
import { useRef, useState, useTransition, type SubmitEvent } from 'react';
import { CircleAlert, Cloud, RotateCw, ShieldCheck, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import type {
  CloudflareCredentialActionResult,
  ProjectCloudflareSummary,
  ProjectRole,
} from '@/components/admin/project-types';
import {
  CLOUDFLARE_ERROR_COPY,
  CLOUDFLARE_TOAST,
  cloudflareFailureLabel,
  cloudflareFormError,
  cloudflareHealthLabel,
  cloudflareStatusCopy,
  cloudflareThrownErrorCopy,
  cloudflareViewerNote,
} from '@/components/admin/cloudflare-copy';
import { LocalTime } from '@/components/admin/local-time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface CloudflareCredentialCardProps {
  projectId: string;
  projectName: string;
  role: ProjectRole;
  /** Already passed through redactProjectCloudflareSummary by the page. */
  summary: ProjectCloudflareSummary;
  connectAction: (input: {
    projectId: string;
    accountId: string;
    apiToken: string;
  }) => Promise<CloudflareCredentialActionResult>;
  disconnectAction: (input: { projectId: string }) => Promise<CloudflareCredentialActionResult>;
}

const ICONS = { connected: ShieldCheck, attention: CircleAlert, optional: Cloud } as const;

/** ISO timestamp for LocalTime, or null when the value is missing or unparseable. LocalTime renders
 *  a deterministic UTC string during SSR and hydration, then the viewer's local time. */
function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/**
 * The project's OPTIONAL Cloudflare Workers AI credential (D2, D10): connect, rotate and
 * disconnect. Unlike the Gateway card, an Admin can rotate or disconnect any LINKED credential,
 * including one that needs attention, because a rejected token is exactly when both are needed.
 * Expected outcomes come back as result codes (never thrown), so production masking of thrown
 * Server Action errors cannot hide them.
 */
export function CloudflareCredentialCard({
  projectId,
  projectName,
  role,
  summary,
  connectAction,
  disconnectAction,
}: CloudflareCredentialCardProps) {
  const copy = cloudflareStatusCopy(summary);
  const Icon = ICONS[copy.icon];
  const admin = role === 'admin';
  const linked = summary.state !== 'not_connected';
  const failure = cloudflareFailureLabel(summary.lastFailureCode);
  const verifiedAt = isoOrNull(summary.verifiedAt);
  const lastCheckedAt = isoOrNull(summary.lastCheckedAt);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const accountInputId = `cloudflare-account-id-${projectId}`;
  const tokenInputId = `cloudflare-api-token-${projectId}`;

  // onSubmit, not a function form action: React resets the form before running a function action
  // (requestFormReset in startHostTransition), which would wipe a correct Account ID when only the
  // token was rejected. The token stays in the uncontrolled password input: never in React state.
  function submitCredential(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const accountId = String(formData.get('cloudflareAccountId') ?? '');
    const apiToken = String(formData.get('cloudflareApiToken') ?? '');
    const precheck = cloudflareFormError(accountId, apiToken);
    if (precheck) {
      setFormError(precheck);
      return;
    }
    setFormError(null);
    startTransition(async () => {
      try {
        const result = await connectAction({ projectId, accountId, apiToken });
        if (!result.ok) {
          setFormError(CLOUDFLARE_ERROR_COPY[result.code] ?? cloudflareThrownErrorCopy(null));
          return;
        }
        formRef.current?.reset();
        setCredentialOpen(false);
        toast.success(linked ? CLOUDFLARE_TOAST.rotated : CLOUDFLARE_TOAST.connected);
      } catch (error) {
        setFormError(cloudflareThrownErrorCopy(error));
      }
    });
  }

  function disconnect() {
    startTransition(async () => {
      try {
        const result = await disconnectAction({ projectId });
        if (!result.ok) {
          toast.error(CLOUDFLARE_ERROR_COPY[result.code] ?? cloudflareThrownErrorCopy(null));
          return;
        }
        setDisconnectOpen(false);
        toast.success(CLOUDFLARE_TOAST.disconnected);
      } catch (error) {
        toast.error(cloudflareThrownErrorCopy(error));
      }
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-muted">
              <Icon className="size-4" />
            </span>
            {copy.title}
          </CardTitle>
          <CardDescription>{copy.description}</CardDescription>
          <CardAction>
            <Badge variant={copy.variant}>{copy.badge}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Admin-only metadata. Editors' summaries are also redacted server-side. */}
          {admin && linked && (
            <dl className="grid gap-3 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Account ID</dt>
                <dd className="mt-1 font-mono text-xs font-medium break-all">
                  {summary.accountId ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">API token</dt>
                <dd className="mt-1 font-mono font-medium">
                  {summary.lastFour ? `•••• ${summary.lastFour}` : 'Stored securely'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Health</dt>
                <dd className="mt-1 font-medium">{cloudflareHealthLabel(summary.health)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Verified</dt>
                <dd className="mt-1 font-medium">
                  {verifiedAt ? <LocalTime value={verifiedAt} /> : 'Not verified yet'}
                </dd>
              </div>
              {failure && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Last failure</dt>
                  <dd className="mt-1 font-medium">
                    {failure}
                    {lastCheckedAt && (
                      <>
                        {' · '}
                        <LocalTime value={lastCheckedAt} />
                      </>
                    )}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {admin ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setFormError(null);
                  setCredentialOpen(true);
                }}
              >
                {linked ? <RotateCw /> : <Cloud />}
                {linked ? 'Rotate credential' : 'Connect Cloudflare'}
              </Button>
              {linked && (
                <Button variant="outline" onClick={() => setDisconnectOpen(true)}>
                  <Unplug /> Disconnect
                </Button>
              )}
            </div>
          ) : (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              {cloudflareViewerNote(summary.state, projectName)}
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={credentialOpen}
        onOpenChange={(open) => {
          // While Cloudflare checks the credential (up to 10 s) the dialog stays open: its inline
          // error is the only report of a failed connect or rotate, and closing would hide it.
          // base-ui has no `dismissible` prop, so ignore Escape and backdrop requests (AGENTS.md).
          if (!open && pending) return;
          setCredentialOpen(open);
        }}
      >
        {/* Explicit width: DialogContent defaults to sm:max-w-sm (AGENTS.md). */}
        <DialogContent className="sm:max-w-lg" showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>{linked ? 'Rotate' : 'Connect'} Cloudflare Workers AI</DialogTitle>
            <DialogDescription>
              Sophy uses this account ID and API token only for {projectName}&apos;s Clef and
              Clairic keys. The token is encrypted when saved and is never shown again.
            </DialogDescription>
          </DialogHeader>
          <form ref={formRef} onSubmit={submitCredential} className="space-y-4">
            {linked && summary.lastFour && (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                Current token <span className="font-mono font-medium">•••• {summary.lastFour}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={accountInputId}>Account ID</Label>
              <Input
                id={accountInputId}
                name="cloudflareAccountId"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                placeholder="32-character account ID"
                defaultValue={summary.accountId ?? ''}
                required
              />
              <p className="text-xs text-muted-foreground">
                In the Cloudflare dashboard, open Workers AI and select &ldquo;Use REST API&rdquo;.
                The Account ID is shown there.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={tokenInputId}>API token</Label>
              <Input
                id={tokenInputId}
                name="cloudflareApiToken"
                type="password"
                autoComplete="new-password"
                placeholder="Paste the API token"
                required
              />
              <p className="text-xs text-muted-foreground">
                On the same page, select &ldquo;Create a Workers AI API Token&rdquo; (Cloudflare&apos;s
                &ldquo;Workers AI&rdquo; template). A custom token needs both Workers AI Read and
                Workers AI Edit.
                {linked ? ' A failed replacement leaves the current credential active.' : ''}
              </p>
            </div>
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setCredentialOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Verifying…' : linked ? 'Verify and rotate' : 'Verify and connect'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        {/* size="default" is the explicit width (384px at sm): a bare sm:max-w-* className is
            out-specified by the primitive's data-[size=default]:sm:max-w-sm. */}
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Cloudflare Workers AI?</AlertDialogTitle>
            <AlertDialogDescription>
              Keys in {projectName} that use Clef or Clairic models will fail until a Project Admin
              connects a credential again. Other keys, members and settings are unchanged. The
              stored token is erased.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={disconnect}>
              {pending ? 'Disconnecting…' : 'Disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
