import Link from 'next/link';
import { listRoutes, listClientsSimple } from '@/lib/admin/queries';
import { CreateRoute } from '@/components/admin/create-route';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function RoutesPage() {
  const [routes, clients] = await Promise.all([listRoutes(), listClientsSimple()]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Routes</h1>
        <p className="text-sm text-muted-foreground">
          A route maps a client&apos;s `model` to a provider/model, master prompt, params and
          schema. Repoint it here — no client change, no redeploy.
        </p>
      </div>
      <CreateRoute clients={clients} />
      {routes.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Route</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Active model</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Structured</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono">{r.name}</TableCell>
                <TableCell>{r.clientName}</TableCell>
                <TableCell className="font-mono text-xs">
                  {r.activeModel ?? <span className="text-muted-foreground">— not configured —</span>}
                </TableCell>
                <TableCell>{r.mode}</TableCell>
                <TableCell>{r.structured ? <Badge>JSON</Badge> : '—'}</TableCell>
                <TableCell className="text-right">
                  <Link className="text-sm underline" href={`/admin/routes/${r.id}`}>
                    Edit
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
