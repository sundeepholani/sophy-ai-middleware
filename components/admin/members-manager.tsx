'use client';

import { useState, useTransition } from 'react';
import { Mail, Shield, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import type { ProjectRole } from '@/components/admin/project-types';
import { projectRoleLabel } from '@/components/admin/project-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { TableSearchBox, useTableFilter } from '@/components/admin/table-search';

export interface ProjectMemberRow {
  userId: string;
  email: string;
  role: ProjectRole;
  status: 'active' | 'suspended';
  keyCount?: number;
  joinedAt?: Date | string | null;
}

export interface ProjectInvitationRow {
  id: string;
  email: string;
  role: ProjectRole;
  invitedByEmail: string | null;
  expiresAt: Date | string;
  createdAt?: Date | string | null;
}

interface MembersManagerProps {
  projectId: string;
  projectName: string;
  selfUserId: string;
  members: ProjectMemberRow[];
  invitations: ProjectInvitationRow[];
  inviteAction: (input: { projectId: string; email: string; role: ProjectRole }) => Promise<void>;
  changeMemberRoleAction: (input: {
    projectId: string;
    userId: string;
    role: ProjectRole;
  }) => Promise<void>;
  removeMemberAction: (input: { projectId: string; userId: string }) => Promise<void>;
  changeInvitationRoleAction: (input: {
    projectId: string;
    invitationId: string;
    role: ProjectRole;
  }) => Promise<void>;
  resendInvitationAction: (input: { projectId: string; invitationId: string }) => Promise<void>;
  revokeInvitationAction: (input: { projectId: string; invitationId: string }) => Promise<void>;
}

const ROLE_ITEMS = [
  { label: 'Editor', value: 'editor' },
  { label: 'Project Admin', value: 'admin' },
];

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'last_project_admin') return 'Add another Project Admin before changing the final Admin.';
  if (message === 'already_member') return 'That email already belongs to this project.';
  if (message === 'forbidden') return 'Only a Project Admin can manage project access.';
  return message || 'Could not update project access.';
}

function expiryLabel(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Expiry unavailable';
  return `Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)}`;
}

export function MembersManager({
  projectId,
  projectName,
  selfUserId,
  members,
  invitations,
  inviteAction,
  changeMemberRoleAction,
  removeMemberAction,
  changeInvitationRoleAction,
  resendInvitationAction,
  revokeInvitationAction,
}: MembersManagerProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<ProjectRole>('editor');
  const [pending, startTransition] = useTransition();
  const { query, setQuery, filtered } = useTableFilter(members, (member) =>
    [member.email, member.role, member.status].join(' '),
  );

  function run(action: () => Promise<void>, success: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(success);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    });
  }

  function invite() {
    const email = inviteEmail.trim();
    if (!email) return toast.error('Email is required');
    run(async () => {
      await inviteAction({ projectId, email, role: inviteRole });
      setInviteOpen(false);
      setInviteEmail('');
      setInviteRole('editor');
    }, `Invitation sent to ${email}`);
  }

  function roleSelect(value: ProjectRole, onChange: (role: ProjectRole) => void, disabled = false) {
    return (
      <Select
        items={ROLE_ITEMS}
        value={value}
        onValueChange={(next) => next != null && onChange(next as ProjectRole)}
        disabled={disabled || pending}
      >
        <SelectTrigger size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="editor">Editor</SelectItem>
          <SelectItem value="admin">Project Admin</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-medium">Active members</h2>
            <p className="text-sm text-muted-foreground">
              Roles and key ownership apply only inside {projectName}.
            </p>
          </div>
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus /> Invite member
          </Button>
        </div>

        <TableSearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search members…"
          label="Search project members"
        />

        <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Project role</TableHead>
                <TableHead className="text-right">Sophy keys</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((member) => (
                <TableRow key={member.userId}>
                  <TableCell className="font-medium">
                    {member.email}
                    {member.userId === selfUserId && (
                      <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {roleSelect(member.role, (role) =>
                      run(
                        () => changeMemberRoleAction({ projectId, userId: member.userId, role }),
                        `${member.email} is now ${projectRoleLabel(role)}`,
                      ),
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{member.keyCount ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={member.status === 'active' ? 'default' : 'secondary'}>
                      {member.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={pending || member.userId === selfUserId}
                      onClick={() =>
                        run(
                          () => removeMemberAction({ projectId, userId: member.userId }),
                          `${member.email} was removed`,
                        )
                      }
                    >
                      <Trash2 /> Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No members match this search.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="grid gap-3 md:hidden">
          {filtered.map((member) => (
            <article key={member.userId} className="space-y-3 rounded-lg border bg-card p-4">
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                  <Shield className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{member.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {member.keyCount == null
                      ? 'Key ownership unavailable'
                      : `${member.keyCount} Sophy key${member.keyCount === 1 ? '' : 's'}`}
                    {member.userId === selfUserId ? ' · You' : ''}
                  </p>
                </div>
                <Badge variant={member.status === 'active' ? 'default' : 'secondary'}>
                  {member.status}
                </Badge>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Project role</Label>
                  {roleSelect(member.role, (role) =>
                    run(
                      () => changeMemberRoleAction({ projectId, userId: member.userId, role }),
                      `${member.email} is now ${projectRoleLabel(role)}`,
                    ),
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={pending || member.userId === selfUserId}
                  onClick={() =>
                    run(
                      () => removeMemberAction({ projectId, userId: member.userId }),
                      `${member.email} was removed`,
                    )
                  }
                >
                  <Trash2 /> Remove
                </Button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="font-medium">Pending invitations</h2>
          <p className="text-sm text-muted-foreground">
            Access begins only after the recipient verifies and accepts the invitation.
          </p>
        </div>
        <div className="grid gap-3">
          {invitations.map((invitation) => (
            <article
              key={invitation.id}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4 lg:flex-row lg:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{invitation.email}</p>
                <p className="text-xs text-muted-foreground">
                  {expiryLabel(invitation.expiresAt)}
                  {invitation.invitedByEmail ? ` · Invited by ${invitation.invitedByEmail}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {roleSelect(invitation.role, (role) =>
                  run(
                    () =>
                      changeInvitationRoleAction({
                        projectId,
                        invitationId: invitation.id,
                        role,
                      }),
                    `Invitation updated to ${projectRoleLabel(role)}`,
                  ),
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => resendInvitationAction({ projectId, invitationId: invitation.id }),
                      `Invitation resent to ${invitation.email}`,
                    )
                  }
                >
                  <Mail /> Resend
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => revokeInvitationAction({ projectId, invitationId: invitation.id }),
                      `Invitation for ${invitation.email} revoked`,
                    )
                  }
                >
                  Revoke
                </Button>
              </div>
            </article>
          ))}
          {invitations.length === 0 && (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No pending invitations.
            </div>
          )}
        </div>
      </section>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              Access applies only to {projectName}. The same person can have a different role in
              another project.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="member-invite-email">Email</Label>
              <Input
                id="member-invite-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="person@company.com"
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="member-invite-role">Project role</Label>
              <Select
                items={ROLE_ITEMS}
                value={inviteRole}
                onValueChange={(value) => value != null && setInviteRole(value as ProjectRole)}
              >
                <SelectTrigger id="member-invite-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">Editor</SelectItem>
                  <SelectItem value="admin">Project Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending || !inviteEmail.trim()} onClick={invite}>
              {pending ? 'Sending…' : 'Send invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
