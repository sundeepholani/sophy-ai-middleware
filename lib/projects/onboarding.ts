import type { MembershipStatus, ProjectRole } from '@/db/schema';

/**
 * Invitation onboarding never overwrites an established preference. A user
 * whose first verified entry is an invitation has no default, so that project
 * becomes the default without creating a personal project.
 */
export function invitationDefaultProject(
  currentDefaultProjectId: string | null,
  invitedProjectId: string,
): string {
  return currentDefaultProjectId ?? invitedProjectId;
}

export interface InvitationMembershipOutcome {
  role: ProjectRole;
  status: MembershipStatus;
  created: boolean;
}

/**
 * A stale invitation can fill an absent membership, but it cannot be used as a
 * role/status mutation for access that a Project Admin already manages.
 */
export function invitationMembershipOutcome(
  invitedRole: ProjectRole,
  existingMembership: {
    role: ProjectRole;
    status: MembershipStatus;
  } | null,
): InvitationMembershipOutcome {
  return existingMembership
    ? { ...existingMembership, created: false }
    : { role: invitedRole, status: 'active', created: true };
}
