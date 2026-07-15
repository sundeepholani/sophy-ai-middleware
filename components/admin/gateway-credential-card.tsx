'use client';

import { useRef, useState, useTransition } from 'react';
import { Cable, CircleAlert, RotateCw, ShieldCheck, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import type { ProjectGatewaySummary, ProjectRole } from '@/components/admin/project-types';
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

interface GatewayCredentialCardProps {
  projectId: string;
  projectName: string;
  role: ProjectRole;
  summary: ProjectGatewaySummary;
  connectAction: (input: { projectId: string; apiKey: string }) => Promise<void>;
  disconnectAction: (input: { projectId: string }) => Promise<void>;
  compact?: boolean;
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'gateway_invalid') return 'Vercel AI Gateway rejected that credential.';
  if (message === 'gateway_in_use') {
    return 'That Vercel AI Gateway key is already connected to another Sophy project.';
  }
  if (message === 'forbidden') return 'Only a Project Admin can manage this connection.';
  if (message === 'unauthorized') return 'Your session expired — sign in again.';
  return message || 'Could not update the Gateway connection.';
}

function statusDetails(summary: ProjectGatewaySummary) {
  if (summary.isReady) {
    return {
      variant: 'default' as const,
      label: 'Connected',
      title: 'Vercel AI Gateway is connected',
      description: 'Sophy API keys and AI-powered project jobs are ready to run.',
      Icon: ShieldCheck,
    };
  }
  switch (summary.health) {
    case 'invalid':
      return {
        variant: 'destructive' as const,
        label: 'Needs attention',
        title: 'Gateway credential needs attention',
        description: 'AI operations are paused until a Project Admin replaces the credential.',
        Icon: CircleAlert,
      };
    case 'billing_attention':
      return {
        variant: 'destructive' as const,
        label: 'Billing attention',
        title: 'Gateway billing needs attention',
        description: 'AI operations are paused. Check the Vercel account, then replace the credential if needed.',
        Icon: CircleAlert,
      };
    case 'unchecked':
      return {
        variant: 'secondary' as const,
        label: 'Checking',
        title: 'Gateway connection is being checked',
        description: 'Sophy will enable project AI operations after verification succeeds.',
        Icon: Cable,
      };
    default:
      if (summary.state === 'attention') {
        return {
          variant: 'destructive' as const,
          label: 'Needs attention',
          title: 'Gateway connection needs attention',
          description: 'AI operations are paused until a Project Admin restores the connection.',
          Icon: CircleAlert,
        };
      }
      return {
        variant: 'secondary' as const,
        label: 'Setup required',
        title: 'Connect Vercel AI Gateway',
        description: 'A project-owned credential is required before Sophy keys can be created or used.',
        Icon: Cable,
      };
  }
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return 'Not verified yet';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Verified';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function GatewayCredentialCard({
  projectId,
  projectName,
  role,
  summary,
  connectAction,
  disconnectAction,
  compact = false,
}: GatewayCredentialCardProps) {
  const details = statusDetails(summary);
  const connected = summary.isReady;
  const admin = role === 'admin';
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const Icon = details.Icon;

  function submitCredential(formData: FormData) {
    const apiKey = String(formData.get('gatewayApiKey') ?? '').trim();
    if (!apiKey) {
      toast.error('Gateway API key is required');
      return;
    }
    startTransition(async () => {
      try {
        await connectAction({ projectId, apiKey });
        formRef.current?.reset();
        setCredentialOpen(false);
        toast.success(connected ? 'Gateway credential rotated' : 'Gateway connected');
      } catch (error) {
        toast.error(friendlyError(error));
      }
    });
  }

  function disconnect() {
    startTransition(async () => {
      try {
        await disconnectAction({ projectId });
        setDisconnectOpen(false);
        toast.success('Gateway disconnected');
      } catch (error) {
        toast.error(friendlyError(error));
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
            {details.title}
          </CardTitle>
          <CardDescription>{details.description}</CardDescription>
          <CardAction>
            <Badge variant={details.variant}>{details.label}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected && admin && !compact && (
            <div className="grid gap-3 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Credential</p>
                <p className="mt-1 font-mono font-medium">
                  {summary.lastFour ? `•••• ${summary.lastFour}` : 'Connected securely'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Verified</p>
                <p className="mt-1 font-medium">{formatDate(summary.verifiedAt)}</p>
              </div>
            </div>
          )}

          {admin ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setCredentialOpen(true)}>
                {connected ? <RotateCw /> : <Cable />}
                {connected ? 'Rotate credential' : 'Connect Gateway'}
              </Button>
              {connected && !compact && (
                <Button variant="outline" onClick={() => setDisconnectOpen(true)}>
                  <Unplug /> Disconnect
                </Button>
              )}
            </div>
          ) : (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              {connected
                ? `A Project Admin manages the Gateway connection for ${projectName}.`
                : `Waiting for a Project Admin to connect ${projectName} to Vercel AI Gateway.`}
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={credentialOpen} onOpenChange={setCredentialOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{connected ? 'Rotate' : 'Connect'} Vercel AI Gateway</DialogTitle>
            <DialogDescription>
              This project-owned credential routes AI operations for {projectName}. It is encrypted
              when saved and is never shown again.
            </DialogDescription>
          </DialogHeader>
          <form ref={formRef} action={submitCredential} className="space-y-4">
            {connected && summary.lastFour && (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                Current credential <span className="font-mono font-medium">•••• {summary.lastFour}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={`gateway-api-key-${projectId}`}>Vercel AI Gateway API key</Label>
              <Input
                id={`gateway-api-key-${projectId}`}
                name="gatewayApiKey"
                type="password"
                autoComplete="new-password"
                placeholder="Enter the project credential"
                required
              />
              <p className="text-xs text-muted-foreground">
                A failed replacement leaves the current working credential active.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCredentialOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Verifying…' : connected ? 'Verify and rotate' : 'Verify and connect'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Gateway?</AlertDialogTitle>
            <AlertDialogDescription>
              AI operations for {projectName} will pause. Sophy API keys, members, knowledgebases,
              and settings remain unchanged.
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
