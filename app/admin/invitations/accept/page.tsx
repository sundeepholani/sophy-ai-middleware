import Link from 'next/link';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getIdentityViewer } from '@/lib/auth/viewer';
import { getProjectInvitationPreview } from '@/lib/projects/repository';
import { acceptProjectInvitation, switchInvitationAccount } from './actions';

export const dynamic = 'force-dynamic';

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; accepted?: string }>;
}) {
  const params = await searchParams;
  const identity = await getIdentityViewer();
  const existingAccess = params.accepted === 'existing';
  const accountMismatch = params.error === 'account_mismatch';
  const invitation =
    !existingAccess && (!params.error || accountMismatch) && params.token
      ? await getProjectInvitationPreview(params.token)
      : null;
  const validAccountMismatch = accountMismatch && !!invitation;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader>
          <BrandMark className="mb-2" />
          <CardTitle>
            {existingAccess
              ? 'Access already exists'
              : validAccountMismatch
                ? `Switch accounts to join ${invitation.projectName}`
              : invitation
                ? `Join ${invitation.projectName}`
                : 'Invitation problem'}
          </CardTitle>
          <CardDescription>
            {existingAccess
              ? 'The invitation is complete, and your existing project access was kept.'
              : validAccountMismatch
                ? `This invitation belongs to ${invitation.email}.`
              : invitation
                ? identity ? 'Review and explicitly accept your Sophy project invitation.' : 'Verify your email with a sign-in code, then accept your invitation.'
                : 'This invitation could not be accepted.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {existingAccess ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Sophy did not change your current role or access status. A Project Admin can
                update those from the project&apos;s Members page.
              </p>
              <Button className="w-full" nativeButton={false} render={<Link href="/admin" />}>
                Continue to Sophy
              </Button>
            </div>
          ) : validAccountMismatch ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Sign out of the current Sophy account, then accept this invitation as{' '}
                <span className="font-medium text-foreground">{invitation.email}</span>. The
                invitation will remain unused.
              </p>
              <form action={switchInvitationAccount}>
                <input type="hidden" name="token" value={params.token ?? ''} />
                <Button type="submit" className="w-full">
                  Switch account
                </Button>
              </form>
            </div>
          ) : invitation ? (
            <form action={acceptProjectInvitation} className="space-y-4">
              <input type="hidden" name="token" value={params.token} />
              <dl className="divide-y rounded-lg border text-sm">
                <div className="grid grid-cols-[5rem_1fr] gap-3 px-3 py-2.5">
                  <dt className="text-muted-foreground">Project</dt>
                  <dd className="min-w-0 break-words font-medium">
                    {invitation.projectName}
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_1fr] gap-3 px-3 py-2.5">
                  <dt className="text-muted-foreground">Invited by</dt>
                  <dd className="min-w-0 break-all">{invitation.invitedByEmail}</dd>
                </div>
                <div className="grid grid-cols-[5rem_1fr] gap-3 px-3 py-2.5">
                  <dt className="text-muted-foreground">For</dt>
                  <dd className="min-w-0 break-all">{invitation.email}</dd>
                </div>
                <div className="grid grid-cols-[5rem_1fr] gap-3 px-3 py-2.5">
                  <dt className="text-muted-foreground">Role</dt>
                  <dd className="capitalize">{invitation.role}</dd>
                </div>
              </dl>
              <p className="text-xs leading-relaxed text-muted-foreground">
                If this is your first Sophy project, it becomes your default.
                You can change your default later.
              </p>
              <Button type="submit" className="w-full">
                {identity ? 'Accept invitation' : 'Continue with an email code'}
              </Button>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The invitation may be expired, revoked, already used, or intended for a different
                signed-in email. Ask the Project Admin for a fresh invitation.
              </p>
              <Button className="w-full" nativeButton={false} render={<Link href="/admin/login" />}>
                Go to sign in
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
