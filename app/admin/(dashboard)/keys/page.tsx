import { listClientsWithKeys } from '@/lib/admin/queries';
import { KeysManager } from '@/components/admin/keys-manager';

export const dynamic = 'force-dynamic';

export default async function KeysPage() {
  const clients = await listClientsWithKeys();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Clients &amp; Keys</h1>
        <p className="text-sm text-muted-foreground">
          Issue and manage the API keys your client systems use. Keys are shown once at creation.
        </p>
      </div>
      <KeysManager clients={clients} />
    </div>
  );
}
