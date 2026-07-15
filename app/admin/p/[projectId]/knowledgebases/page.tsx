import { redirect } from 'next/navigation';
import { KbManager } from '@/components/admin/kb-manager';
import { projectPath } from '@/components/admin/project-path';
import { listKnowledgebases } from '@/lib/admin/queries';
import { requireProjectViewer } from '@/lib/auth/viewer';

export const dynamic = 'force-dynamic';

export default async function KnowledgebasesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const viewer = await requireProjectViewer(projectId);
  if (viewer.role !== 'admin') redirect(projectPath(projectId));
  const knowledgebases = await listKnowledgebases(viewer);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Knowledgebases</h1>
        <p className="text-sm text-muted-foreground">
          Project-owned document collections for retrieval-augmented generation in{' '}
          {viewer.projectName}. Attach one to a Sophy API key to ground its answers.
        </p>
      </div>
      <KbManager projectId={projectId} knowledgebases={knowledgebases} />
    </div>
  );
}
