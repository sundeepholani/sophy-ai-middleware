import { redirect } from 'next/navigation';
import {
  connectProjectGateway,
  disconnectProjectGateway,
  renameProject,
  setDefaultProject,
} from '@/app/admin/project-actions';
import { GatewayCredentialCard } from '@/components/admin/gateway-credential-card';
import { MakeDefaultProjectButton } from '@/components/admin/make-default-project-button';
import { projectPath } from '@/components/admin/project-path';
import { ProjectSettingsForm } from '@/components/admin/project-settings-form';
import { SettingsForm } from '@/components/admin/settings-form';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getSettings } from '@/lib/admin/settings';
import { requireProjectViewer } from '@/lib/auth/viewer';
import { listGatewayModels, type AvailableModel } from '@/lib/gateway/models';
import { getProjectGatewaySummary } from '@/lib/projects/repository';

export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const viewer = await requireProjectViewer(projectId);
  if (viewer.role !== 'admin') redirect(projectPath(projectId));

  const [settings, gateway] = await Promise.all([
    getSettings(viewer),
    getProjectGatewaySummary(projectId),
  ]);
  let models: AvailableModel[] = [];
  let modelsUnavailable = false;
  try {
    models = await listGatewayModels();
  } catch {
    modelsUnavailable = true;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Project settings</h1>
        <p className="text-sm text-muted-foreground">
          Configuration, Gateway connection, and identity for {viewer.projectName}.
        </p>
      </div>

      <GatewayCredentialCard
        projectId={projectId}
        projectName={viewer.projectName}
        role={viewer.role}
        summary={gateway}
        connectAction={connectProjectGateway}
        disconnectAction={disconnectProjectGateway}
      />

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            Rename this project without changing its stable URL, memberships, Gateway connection,
            or Sophy API keys.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProjectSettingsForm
            projectId={projectId}
            initialName={viewer.projectName}
            projectSlug={viewer.projectSlug}
            renameAction={renameProject}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Eval settings</CardTitle>
          <CardDescription>
            These settings affect evals started from Sophy API keys in this project only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm
            projectId={projectId}
            initial={settings}
            models={models}
            modelsUnavailable={modelsUnavailable}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default project</CardTitle>
          <CardDescription>
            Switching projects changes only this tab. Your default controls where Sophy opens after
            sign-in.
          </CardDescription>
          <CardAction>
            <MakeDefaultProjectButton
              projectId={projectId}
              projectName={viewer.projectName}
              isDefault={viewer.defaultProjectId === projectId}
              setDefaultAction={setDefaultProject}
            />
          </CardAction>
        </CardHeader>
      </Card>
    </div>
  );
}
