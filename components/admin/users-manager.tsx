'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { UserPlus, Mail } from 'lucide-react';
import { createUser, setUserStatus, setUserRole, resendInvite } from '@/app/admin/users-actions';
import type { AdminUserRow } from '@/lib/admin/queries';
import type { UserRole } from '@/db/schema';
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

const ROLE_ITEMS = [
  { label: 'Editor', value: 'editor' },
  { label: 'Admin', value: 'admin' },
];

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (m === 'unauthorized') return 'Your session expired — please sign in again.';
  if (m === 'forbidden') return 'You don’t have permission to do that.';
  return m || 'Something went wrong.';
}

export function UsersManager({ users, selfId }: { users: AdminUserRow[]; selfId: string }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {users.length} user{users.length === 1 ? '' : 's'}
        </h2>
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4" />
          Invite user
        </Button>
        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Invite user</DialogTitle>
              <DialogDescription>
                They’ll receive a one-time sign-in link by email. You can change their role or
                deactivate them anytime.
              </DialogDescription>
            </DialogHeader>
            <InviteForm onDone={() => setInviteOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Keys</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No users yet.
                </TableCell>
              </TableRow>
            )}
            {users.map((u) => (
              <UserRowItem key={u.id} u={u} isSelf={u.id === selfId} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Shows the emailed status + the one-time sign-in link with a copy fallback. */
function InviteResult({
  email,
  inviteUrl,
  emailed,
  added = false,
  onDone,
}: {
  email: string;
  inviteUrl: string | null;
  emailed: boolean;
  added?: boolean;
  onDone: () => void;
}) {
  async function copyLink() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success('Link copied');
    } catch {
      toast.error('Copy failed — select the link and copy it manually');
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {added && (
          <>
            <span className="font-medium">{email}</span> was added.{' '}
          </>
        )}
        {emailed ? (
          <>
            A sign-in link was emailed to <span className="font-medium">{added ? 'them' : email}</span>.
          </>
        ) : (
          <>
            Email delivery isn’t confirmed — copy the one-time link below and share it with{' '}
            <span className="font-medium">{email}</span>.
          </>
        )}
      </p>
      {inviteUrl && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">One-time sign-in link (expires in 15 minutes):</p>
          <code className="block max-h-28 select-all overflow-auto rounded-md bg-muted p-2 text-xs break-all">
            {inviteUrl}
          </code>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>
          Done
        </Button>
        {inviteUrl && <Button onClick={copyLink}>Copy link</Button>}
      </div>
    </div>
  );
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('editor');
  const [result, setResult] = useState<{ email: string; inviteUrl: string | null; emailed: boolean } | null>(null);

  function submit() {
    if (!email.trim()) return toast.error('Email is required');
    startTransition(async () => {
      try {
        const r = await createUser({ email: email.trim(), role });
        setResult({ email: email.trim(), ...r });
      } catch (e) {
        toast.error(errMsg(e));
      }
    });
  }

  if (result) {
    return (
      <InviteResult
        email={result.email}
        inviteUrl={result.inviteUrl}
        emailed={result.emailed}
        added
        onDone={onDone}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="invite-email" className="text-xs">
          Email
        </Label>
        <Input
          id="invite-email"
          type="email"
          placeholder="person@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="invite-role" className="text-xs">
          Role
        </Label>
        <Select
          items={ROLE_ITEMS}
          value={role}
          onValueChange={(v) => v != null && setRole(v as UserRole)}
        >
          <SelectTrigger id="invite-role" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="editor">Editor</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end">
        <Button onClick={submit} disabled={isPending}>
          {isPending ? 'Inviting…' : 'Send invite'}
        </Button>
      </div>
    </div>
  );
}

function UserRowItem({ u, isSelf }: { u: AdminUserRow; isSelf: boolean }) {
  const [isPending, startTransition] = useTransition();
  const active = u.status === 'active';
  const [invite, setInvite] = useState<{ email: string; inviteUrl: string | null; emailed: boolean } | null>(
    null,
  );

  function resend() {
    startTransition(async () => {
      try {
        setInvite(await resendInvite({ id: u.id }));
      } catch (e) {
        toast.error(errMsg(e));
      }
    });
  }

  function changeRole(role: UserRole) {
    if (role === u.role) return;
    startTransition(async () => {
      try {
        await setUserRole({ id: u.id, role });
        toast.success('Role updated');
      } catch (e) {
        toast.error(errMsg(e));
      }
    });
  }

  function toggleStatus() {
    startTransition(async () => {
      try {
        await setUserStatus({ id: u.id, active: !active });
        toast.success(active ? 'User deactivated' : 'User reactivated');
      } catch (e) {
        toast.error(errMsg(e));
      }
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        {u.email}
        {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
      </TableCell>
      <TableCell>
        <Select
          items={ROLE_ITEMS}
          value={u.role}
          onValueChange={(v) => v != null && changeRole(v as UserRole)}
          disabled={isPending}
        >
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="editor">Editor</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{u.keyCount}</TableCell>
      <TableCell>
        <Badge variant={active ? 'default' : 'secondary'}>{u.status}</Badge>
      </TableCell>
      <TableCell className="space-x-1 text-right">
        {active && (
          <Button size="sm" variant="ghost" disabled={isPending} onClick={resend} title="Re-send sign-in link">
            <Mail className="h-4 w-4" />
            Resend invite
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending || (isSelf && active)}
          onClick={toggleStatus}
          className={active ? 'text-destructive hover:text-destructive' : ''}
        >
          {active ? 'Deactivate' : 'Reactivate'}
        </Button>
        <Dialog open={invite != null} onOpenChange={(o) => !o && setInvite(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Sign-in link</DialogTitle>
              <DialogDescription>
                A fresh one-time link was generated — any previous link for this user is now invalid.
              </DialogDescription>
            </DialogHeader>
            {invite && (
              <InviteResult
                email={invite.email}
                inviteUrl={invite.inviteUrl}
                emailed={invite.emailed}
                onDone={() => setInvite(null)}
              />
            )}
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}
