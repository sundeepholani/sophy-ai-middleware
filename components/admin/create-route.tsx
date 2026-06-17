'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createRoute } from '@/app/admin/actions';
import type { RouteMode } from '@/db/schema';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function CreateRoute({ clients }: { clients: { id: string; name: string }[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<RouteMode>('locked');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New route</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Client</Label>
          <Select value={clientId} onValueChange={(v) => setClientId(v ?? '')}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Route name (the client&apos;s `model`)</Label>
          <Input
            className="w-56"
            placeholder="support-bot"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Mode</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as RouteMode)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="locked">locked</SelectItem>
              <SelectItem value="overridable">overridable</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          disabled={isPending || !clientId || !name.trim()}
          onClick={() =>
            startTransition(async () => {
              try {
                const { id } = await createRoute({ clientId, name: name.trim(), mode });
                toast.success('Route created');
                router.push(`/admin/routes/${id}`);
              } catch {
                toast.error('Failed to create route (name may already exist for this client)');
              }
            })
          }
        >
          Create
        </Button>
      </CardContent>
    </Card>
  );
}
