import { getSettings } from '@/lib/admin/settings';
import { listGatewayModels, type AvailableModel } from '@/lib/gateway/models';
import { SettingsForm } from '@/components/admin/settings-form';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const settings = await getSettings();
  // Best-effort model list; the judge picker falls back to free text if unavailable.
  let models: AvailableModel[] = [];
  let modelsUnavailable = false;
  try {
    models = await listGatewayModels();
  } catch {
    models = [];
    modelsUnavailable = true;
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Global configuration for the middleware — the eval judge model and where summary reports
          are sent.
        </p>
      </div>
      <SettingsForm initial={settings} models={models} modelsUnavailable={modelsUnavailable} />
    </div>
  );
}
