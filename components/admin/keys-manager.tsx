'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  createClient,
  createKey,
  setQuota,
  revokeKey,
} from '@/app/admin/actions';
import type { KeyRow } from '@/lib/admin/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type ClientWithKeys = {
  id: string;
  name: string;
  keys: (KeyRow & { clientId: string })[];
};

export function KeysManager({ clients }: { clients: ClientWithKeys[] }) {
  const [isPending, startTransition] = useTransition();
  const [newClient, setNewClient] = useState('');
  const [issued, setIssued] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New client</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="Client system name (e.g. billing-service)"
              value={newClient}
              onChange={(e) => setNewClient(e.target.value)}
            />
            <Button
              disabled={isPending || !newClient.trim()}
              onClick={() =>
                startTransition(async () => {
                  try {
                    await createClient(newClient.trim());
                    setNewClient('');
                    toast.success('Client created');
                  } catch {
                    toast.error('Failed to create client');
                  }
                })
              }
            >
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {clients.length === 0 && (
        <p className="text-sm text-muted-foreground">No clients yet.</p>
      )}

      {clients.map((c) => (
        <ClientCard key={c.id} client={c} onIssued={setIssued} />
      ))}

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

function ClientCard({
  client,
  onIssued,
}: {
  client: ClientWithKeys;
  onIssued: (key: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [keyName, setKeyName] = useState('');
  const [routesCsv, setRoutesCsv] = useState('');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{client.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {client.keys.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Token cap / mo</TableHead>
                <TableHead>RPM</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {client.keys.map((k) => (
                <KeyRowItem key={k.id} k={k} />
              ))}
            </TableBody>
          </Table>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t pt-4">
          <div className="space-y-1">
            <Label className="text-xs">New key name</Label>
            <Input
              className="w-48"
              placeholder="prod key"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Route scope (comma-sep, blank = all)</Label>
            <Input
              className="w-64"
              placeholder="support-bot, summarizer"
              value={routesCsv}
              onChange={(e) => setRoutesCsv(e.target.value)}
            />
          </div>
          <Button
            disabled={isPending || !keyName.trim()}
            onClick={() =>
              startTransition(async () => {
                try {
                  const routes = routesCsv
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const { fullKey } = await createKey({
                    clientId: client.id,
                    name: keyName.trim(),
                    routes,
                  });
                  setKeyName('');
                  setRoutesCsv('');
                  onIssued(fullKey);
                } catch {
                  toast.error('Failed to create key');
                }
              })
            }
          >
            Issue key
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function KeyRowItem({ k }: { k: KeyRow }) {
  const [isPending, startTransition] = useTransition();
  const [cap, setCap] = useState(k.monthlyTokenCap?.toString() ?? '');
  const [rpm, setRpm] = useState(k.rpmLimit?.toString() ?? '');

  return (
    <TableRow>
      <TableCell>{k.name}</TableCell>
      <TableCell className="font-mono text-xs">
        {k.keyPrefix}…{k.keyLast4}
      </TableCell>
      <TableCell>
        <Badge variant={k.status === 'active' ? 'default' : 'destructive'}>{k.status}</Badge>
      </TableCell>
      <TableCell>
        <Input
          className="h-8 w-28"
          value={cap}
          inputMode="numeric"
          onChange={(e) => setCap(e.target.value)}
        />
      </TableCell>
      <TableCell>
        <Input
          className="h-8 w-20"
          value={rpm}
          inputMode="numeric"
          onChange={(e) => setRpm(e.target.value)}
        />
      </TableCell>
      <TableCell className="space-x-2 text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              try {
                await setQuota({
                  keyId: k.id,
                  monthlyTokenCap: cap.trim() ? Number(cap) : null,
                  rpmLimit: rpm.trim() ? Number(rpm) : null,
                });
                toast.success('Quota saved');
              } catch {
                toast.error('Failed to save quota');
              }
            })
          }
        >
          Save
        </Button>
        {k.status === 'active' && (
          <Button
            size="sm"
            variant="destructive"
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                try {
                  await revokeKey(k.id);
                  toast.success('Key revoked');
                } catch {
                  toast.error('Failed to revoke');
                }
              })
            }
          >
            Revoke
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
