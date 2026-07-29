import {
  getEvalStatuses,
  listKeys,
  listKnowledgebaseOptions,
} from '@/lib/admin/queries';
import { getSettings } from '@/lib/admin/settings';
import { requireProjectViewer } from '@/lib/auth/viewer';
import { listKeyModels, type AvailableModel } from '@/lib/gateway/models';
import { getProjectGatewaySummary, listProjectMembers } from '@/lib/projects/repository';
import { KeysManager } from '@/components/admin/keys-manager';

export const dynamic = 'force-dynamic';

export default async function KeysPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const viewer = await requireProjectViewer(projectId);
  const [keys, evalStatuses, settings, knowledgebases, members, gateway] = await Promise.all([
    listKeys(viewer),
    getEvalStatuses(viewer),
    getSettings(viewer),
    listKnowledgebaseOptions(viewer),
    viewer.role === 'admin' ? listProjectMembers(viewer) : Promise.resolve([]),
    getProjectGatewaySummary(projectId),
  ]);

  let models: AvailableModel[] = [];
  let modelsUnavailable = false;
  try {
    models = await listKeyModels();
  } catch {
    modelsUnavailable = true;
  }
  const transcriptProcessorModels = models.filter((model) => model.type === 'language');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Sophy API keys</h1>
        <p className="text-sm text-muted-foreground">
          Client-facing keys for {viewer.projectName}. Each key uses this project’s Vercel AI
          Gateway connection and cannot access another project.
        </p>
      </div>
      <KeysManager
        projectId={projectId}
        projectName={viewer.projectName}
        gatewayReady={gateway.isReady}
        keys={keys}
        models={models}
        transcriptProcessorModels={transcriptProcessorModels}
        modelsUnavailable={modelsUnavailable}
        evalStatuses={evalStatuses}
        judgeModel={settings.judgeModel}
        role={viewer.role}
        users={members
          .filter((member) => member.status === 'active')
          .map((member) => ({ id: member.userId, email: member.email }))}
        knowledgebases={knowledgebases}
      />
    </div>
  );
}
