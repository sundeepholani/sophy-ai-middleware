import { notFound } from 'next/navigation';
import { getRouteDetail } from '@/lib/admin/queries';
import { listGatewayModels, type AvailableModel } from '@/lib/gateway/models';
import { RouteConfigForm } from '@/components/admin/route-config-form';

export const dynamic = 'force-dynamic';

export default async function RouteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getRouteDetail(id);
  if (!detail) notFound();

  // Best-effort model list; the form falls back to free text if unavailable.
  let models: AvailableModel[] = [];
  try {
    models = await listGatewayModels();
  } catch {
    models = [];
  }

  const active = detail.active;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          Route <span className="font-mono">{detail.route.name}</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Mode: {detail.route.mode}. Publishing repoints live traffic instantly.
        </p>
      </div>
      <RouteConfigForm
        routeId={detail.route.id}
        mode={detail.route.mode}
        model={active?.model ?? ''}
        params={active?.params ?? {}}
        paramBounds={active?.paramBounds ?? {}}
        promptId={active?.promptId ?? null}
        outputSchema={active?.outputSchema ?? null}
        fallbackModels={active?.fallbackModels ?? []}
        prompts={detail.prompts}
        models={models}
      />
    </div>
  );
}
