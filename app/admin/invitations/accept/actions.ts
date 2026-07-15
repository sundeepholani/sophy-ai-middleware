'use server';

import { redirect } from 'next/navigation';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  auditLog,
  projectInvitations,
  projectMemberships,
  projects,
  users,
} from '@/db/schema';
import { currentUser, getSession } from '@/lib/auth/admin-session';
import { hashToken } from '@/lib/auth/magic-link';
import {
  invitationDefaultProject,
  invitationMembershipOutcome,
} from '@/lib/projects/onboarding';

/**
 * Explicit POST acceptance. Merely opening/prefetching the link never consumes
 * it. The email-bound token can create the identity, but never creates “My
 * Project”; the invited project becomes default only when the identity has none.
 */
export async function acceptProjectInvitation(formData: FormData): Promise<void> {
  const rawToken = String(formData.get('token') ?? '');
  if (!rawToken) redirect('/admin/invitations/accept?error=1');
  const tokenHash = hashToken(rawToken);
  const signedIn = await currentUser();

  let accepted: {
    userId: string;
    projectId: string;
    membershipAlreadyExisted: boolean;
  } | null;
  try {
    accepted = await getDb().transaction(async (tx) => {
      // Every invitation mutation locks project, then invitation, in that
      // order. Resolve the candidate project without trusting it until both
      // rows are locked and the invitation is revalidated below.
      const [candidate] = await tx
        .select({ projectId: projectInvitations.projectId })
        .from(projectInvitations)
        .where(eq(projectInvitations.tokenHash, tokenHash))
        .limit(1);
      if (!candidate) return null;
      await tx.execute(sql`
        select ${projects.id}
        from ${projects}
        where ${projects.id} = ${candidate.projectId}
        for update
      `);
      await tx.execute(sql`
        select ${projectInvitations.id}
        from ${projectInvitations}
        where ${projectInvitations.tokenHash} = ${tokenHash}
        for update
      `);
      // A losing redemption observes acceptedAt after the lock and exits
      // without leaving partial onboarding state behind.
      const [invitation] = await tx
        .select({
          id: projectInvitations.id,
          projectId: projectInvitations.projectId,
          email: projectInvitations.email,
          role: projectInvitations.role,
        })
        .from(projectInvitations)
        .innerJoin(
          projects,
          and(
            eq(projects.id, projectInvitations.projectId),
            eq(projects.status, 'active'),
          ),
        )
        .where(
          and(
            eq(projectInvitations.tokenHash, tokenHash),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
            gt(projectInvitations.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!invitation) return null;

      let identity:
        | {
            id: string;
            email: string;
            status: 'active' | 'inactive';
            defaultProjectId: string | null;
          }
        | undefined;
      if (signedIn) {
        [identity] = await tx
          .select({
            id: users.id,
            email: users.email,
            status: users.status,
            defaultProjectId: users.defaultProjectId,
          })
          .from(users)
          .where(eq(users.id, signedIn.userId))
          .limit(1);
        if (
          !identity ||
          identity.status !== 'active' ||
          identity.email !== invitation.email
        ) {
          throw new Error('invitation_email_mismatch');
        }
      } else {
        [identity] = await tx
          .select({
            id: users.id,
            email: users.email,
            status: users.status,
            defaultProjectId: users.defaultProjectId,
          })
          .from(users)
          .where(eq(users.email, invitation.email))
          .limit(1);
        if (identity?.status === 'inactive') {
          throw new Error('invitation_inactive_identity');
        }
        if (!identity) {
          const [created] = await tx
            .insert(users)
            .values({
              email: invitation.email,
              role: 'editor',
              status: 'active',
            })
            .onConflictDoNothing({ target: users.email })
            .returning({
              id: users.id,
              email: users.email,
              status: users.status,
              defaultProjectId: users.defaultProjectId,
            });
          identity = created;

          // Different project invitations for one unknown email can be
          // accepted concurrently. The unique email winner creates the
          // identity; every other transaction safely reuses it.
          if (!identity) {
            [identity] = await tx
              .select({
                id: users.id,
                email: users.email,
                status: users.status,
                defaultProjectId: users.defaultProjectId,
              })
              .from(users)
              .where(eq(users.email, invitation.email))
              .limit(1);
            if (!identity || identity.status !== 'active') {
              throw new Error('invitation_inactive_identity');
            }
          }
        }
      }
      if (!identity) return null;

      // Share the same per-identity linearization point as no-project recovery.
      // Whichever onboarding path commits first owns the initial default;
      // the other observes/preserves it instead of racing in a second project.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.id}::text, 0))`,
      );

      const [createdMembership] = await tx
        .insert(projectMemberships)
        .values({
          projectId: invitation.projectId,
          userId: identity.id,
          role: invitation.role,
          status: 'active',
        })
        .onConflictDoNothing({
          target: [projectMemberships.projectId, projectMemberships.userId],
        })
        .returning({ projectId: projectMemberships.projectId });
      const [effectiveMembership] = await tx
        .select({
          role: projectMemberships.role,
          status: projectMemberships.status,
        })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, invitation.projectId),
            eq(projectMemberships.userId, identity.id),
          ),
        )
        .limit(1);
      if (!effectiveMembership) throw new Error('invitation_membership_failed');
      const membership = invitationMembershipOutcome(
        invitation.role,
        createdMembership ? null : effectiveMembership,
      );
      const defaultProjectId = invitationDefaultProject(
        identity.defaultProjectId,
        invitation.projectId,
      );
      await tx
        .update(users)
        .set({
          // Preserve whichever invitation/default choice won a concurrent
          // race. A stale invitation never makes suspended access the default.
          ...(membership.status === 'active'
            ? {
                defaultProjectId: sql`coalesce(${users.defaultProjectId}, ${defaultProjectId}::uuid)`,
              }
            : {}),
          onboardedAt: sql`coalesce(${users.onboardedAt}, now())`,
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, identity.id));
      const [consumed] = await tx
        .update(projectInvitations)
        .set({
          acceptedAt: new Date(),
          acceptedByUserId: identity.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projectInvitations.id, invitation.id),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
            gt(projectInvitations.expiresAt, new Date()),
          ),
        )
        .returning({ id: projectInvitations.id });
      if (!consumed) throw new Error('invitation_already_consumed');
      await tx.insert(auditLog).values({
        projectId: invitation.projectId,
        actor: identity.email,
        action: 'invitation.accept',
        target: invitation.id,
        after: {
          invitedRole: invitation.role,
          membershipCreated: membership.created,
          effectiveRole: membership.role,
          effectiveStatus: membership.status,
        },
      });
      return {
        userId: identity.id,
        projectId: invitation.projectId,
        membershipAlreadyExisted: !membership.created,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'invitation_email_mismatch') {
      redirect(
        `/admin/invitations/accept?error=account_mismatch&token=${encodeURIComponent(rawToken)}`,
      );
    }
    if (
      message === 'invitation_inactive_identity' ||
      message === 'invitation_already_consumed' ||
      message === 'invitation_membership_failed'
    ) {
      accepted = null;
    } else {
      throw error;
    }
  }

  if (!accepted) redirect('/admin/invitations/accept?error=1');
  const session = await getSession();
  session.userId = accepted.userId;
  session.role = undefined;
  session.email = undefined;
  session.loginAt = Date.now();
  session.sealedAt = Date.now();
  session.isAdmin = undefined;
  await session.save();
  if (accepted.membershipAlreadyExisted) {
    redirect('/admin/invitations/accept?accepted=existing');
  }
  redirect(`/admin/p/${accepted.projectId}`);
}

/** Sign out the mismatched identity without consuming the invitation token. */
export async function switchInvitationAccount(formData: FormData): Promise<never> {
  const rawToken = String(formData.get('token') ?? '');
  const session = await getSession();
  session.destroy();
  redirect(
    rawToken
      ? `/admin/invitations/accept?token=${encodeURIComponent(rawToken)}`
      : '/admin/login',
  );
}
