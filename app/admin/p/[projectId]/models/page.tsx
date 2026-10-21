import { requireProjectViewer } from '@/lib/auth/viewer';
import { listAllModels, type AvailableModel } from '@/lib/gateway/models';
import { ModelsExplorer } from '@/components/admin/models-explorer';

export const dynamic = 'force-dynamic';

export default async function ModelsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectViewer(projectId);

  let models: AvailableModel[] = [];
  let unavailable = false;
  try {
    models = await listAllModels();
  } catch {
    unavailable = true;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Models</h1>
        <p className="text-sm text-muted-foreground">
          Explore every model in the Vercel AI Gateway catalog, plus the Cloudflare Workers AI models
          Sophy serves: Clef for evaluation and Clairic for extraction (preview). Workers AI models run
          on the project’s own Cloudflare credential, which a Project Admin connects in Settings.
          Search, sort, and filter by capability before choosing a model for a project key.
        </p>
      </div>
      {unavailable ? (
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Couldn’t load the model catalog right now. Try again shortly.
        </div>
      ) : (
        <ModelsExplorer models={models} />
      )}
    </div>
  );
}
