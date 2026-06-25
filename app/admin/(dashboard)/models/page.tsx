import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { listAllModels, type AvailableModel } from '@/lib/gateway/models';
import { ModelsExplorer } from '@/components/admin/models-explorer';

export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/admin/login');

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
          Every model available through the AI Gateway, with capabilities, context window, and
          price. Search, sort, or filter by capability — e.g. tick “Image analysis” to find
          vision-capable models for a key.
        </p>
      </div>
      {unavailable ? (
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Couldn’t load the model catalog from the gateway right now. Try again shortly.
        </div>
      ) : (
        <ModelsExplorer models={models} />
      )}
    </div>
  );
}
