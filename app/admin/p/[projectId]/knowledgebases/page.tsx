import { KbManager } from '@/components/admin/kb-manager';
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
  const knowledgebases = await listKnowledgebases(viewer);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Knowledgebases</h1>
        <p className="text-sm text-muted-foreground">
          {viewer.role === 'admin'
            ? `Project-owned document collections for retrieval-augmented generation in ${viewer.projectName}.`
            : `Document collections you own in ${viewer.projectName}.`}{' '}
          Attach one to a Sophy API key you manage to ground its answers.
        </p>
      </div>
      <KbManager projectId={projectId} knowledgebases={knowledgebases} />
    </div>
  );
}
