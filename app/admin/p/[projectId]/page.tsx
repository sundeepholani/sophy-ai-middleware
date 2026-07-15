import {
  connectProjectGateway,
  disconnectProjectGateway,
  setDefaultProject,
} from '@/app/admin/project-actions';
import { GatewayCredentialCard } from '@/components/admin/gateway-credential-card';
import { MakeDefaultProjectButton } from '@/components/admin/make-default-project-button';
import { projectRoleLabel } from '@/components/admin/project-types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getOverview } from '@/lib/admin/queries';
import { requireProjectViewer } from '@/lib/auth/viewer';
import { getProjectGatewaySummary } from '@/lib/projects/repository';

export const dynamic = 'force-dynamic';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const viewer = await requireProjectViewer(projectId);
  const [overview, gateway] = await Promise.all([
    getOverview(viewer),
    getProjectGatewaySummary(projectId),
  ]);
  const nf = new Intl.NumberFormat('en-US');
  const isDefault = viewer.defaultProjectId === projectId;
  // Editor Flight payloads receive only generic readiness. Credential identity,
  // source, suffix, timestamps, and failure details are Admin-only metadata.
  const clientGateway =
    viewer.role === 'admin'
      ? gateway
      : {
          ...gateway,
          credentialId: null,
          source: null,
          lifecycle: null,
          health: null,
          lastFour: null,
          connectedAt: null,
          verifiedAt: null,
          lastCheckedAt: null,
          lastFailureCode: null,
        };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{projectRoleLabel(viewer.role)}</Badge>
            {isDefault && <Badge variant="outline">Default project</Badge>}
            {viewer.projectStatus !== 'active' && (
              <Badge variant="destructive">{viewer.projectStatus}</Badge>
            )}
          </div>
          <h1 className="mt-2 truncate text-2xl font-semibold tracking-tight">
            {viewer.projectName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Last 30 days {viewer.role === 'admin' ? 'across this project' : 'for your Sophy keys'}.
          </p>
        </div>
        <MakeDefaultProjectButton
          projectId={projectId}
          projectName={viewer.projectName}
          isDefault={isDefault}
          setDefaultAction={setDefaultProject}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Requests" value={nf.format(overview.requests)} />
        <Stat label="Input tokens" value={nf.format(overview.inputTokens)} />
        <Stat label="Output tokens" value={nf.format(overview.outputTokens)} />
        <Stat label="Est. cost" value={`$${overview.cost.toFixed(4)}`} />
        <Stat label="Sophy spend" value={`$${overview.shadowCost.toFixed(4)}`} />
        <Stat label="Errors" value={nf.format(overview.errors)} />
      </div>

      <GatewayCredentialCard
        projectId={projectId}
        projectName={viewer.projectName}
        role={viewer.role}
        summary={clientGateway}
        connectAction={connectProjectGateway}
        disconnectAction={disconnectProjectGateway}
      />
    </div>
  );
}
