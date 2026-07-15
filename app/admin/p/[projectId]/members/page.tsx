import { redirect } from 'next/navigation';
import {
  inviteProjectMember,
  removeProjectMember,
  resendProjectInvitation,
  revokeProjectInvitation,
  changeProjectInvitationRole,
  changeProjectMemberRole,
} from '@/app/admin/project-actions';
import { MembersManager } from '@/components/admin/members-manager';
import { projectPath } from '@/components/admin/project-path';
import { requireProjectViewer } from '@/lib/auth/viewer';
import { listProjectInvitations, listProjectMembers } from '@/lib/projects/repository';

export const dynamic = 'force-dynamic';

export default async function ProjectMembersPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const viewer = await requireProjectViewer(projectId);
  if (viewer.role !== 'admin') redirect(projectPath(projectId));
  const [members, invitations] = await Promise.all([
    listProjectMembers(viewer),
    listProjectInvitations(viewer),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Members</h1>
        <p className="text-sm text-muted-foreground">
          Access to {viewer.projectName}. A person’s role here does not change their access in any
          other Sophy project.
        </p>
      </div>
      <MembersManager
        projectId={projectId}
        projectName={viewer.projectName}
        selfUserId={viewer.userId}
        members={members}
        invitations={invitations}
        inviteAction={inviteProjectMember}
        changeMemberRoleAction={changeProjectMemberRole}
        removeMemberAction={removeProjectMember}
        changeInvitationRoleAction={changeProjectInvitationRole}
        resendInvitationAction={resendProjectInvitation}
        revokeInvitationAction={revokeProjectInvitation}
      />
    </div>
  );
}
