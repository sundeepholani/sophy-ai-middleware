import { listKeys, getEvalStatuses, listUsers, listKnowledgebaseOptions } from '@/lib/admin/queries';
import { getSettings } from '@/lib/admin/settings';
import { requireViewer } from '@/lib/auth/viewer';
import { listKeyModels, type AvailableModel } from '@/lib/gateway/models';
import { KeysManager } from '@/components/admin/keys-manager';

export const dynamic = 'force-dynamic';

export default async function KeysPage() {
  const viewer = await requireViewer();
  const [keys, evalStatuses, settings, knowledgebases] = await Promise.all([
    listKeys(viewer),
    getEvalStatuses(viewer),
    getSettings(),
    listKnowledgebaseOptions(),
  ]);
  // Owner picker is admin-only; editors always own what they create.
  const users = viewer.role === 'admin' ? (await listUsers()).map((u) => ({ id: u.id, email: u.email })) : [];
  // Best-effort model list; the form falls back to free text if unavailable.
  let models: AvailableModel[] = [];
  let modelsUnavailable = false;
  try {
    models = await listKeyModels();
  } catch {
    models = [];
    modelsUnavailable = true;
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API Keys</h1>
        <p className="text-sm text-muted-foreground">
          Each key carries its own model, system prompt, and quota. Create or edit a key here —
          changes apply on the next request, no redeploy. Keys are shown once at creation.
        </p>
      </div>
      <KeysManager
        keys={keys}
        models={models}
        modelsUnavailable={modelsUnavailable}
        evalStatuses={evalStatuses}
        judgeModel={settings.judgeModel}
        role={viewer.role}
        users={users}
        knowledgebases={knowledgebases}
      />
    </div>
  );
}
