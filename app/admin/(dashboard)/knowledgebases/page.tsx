import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { listKnowledgebases } from '@/lib/admin/queries';
import { KbManager } from '@/components/admin/kb-manager';

export const dynamic = 'force-dynamic';

export default async function KnowledgebasesPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/admin/login');
  if (viewer.role !== 'admin') redirect('/admin');
  const knowledgebases = await listKnowledgebases();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Knowledgebases</h1>
        <p className="text-sm text-muted-foreground">
          Files-backed knowledge any key can be grounded against. Upload documents (text, Markdown,
          CSV, JSON, PDF, or Word); they’re chunked and embedded in the background, then keys with
          this knowledgebase attached retrieve the most relevant passages at request time.
        </p>
      </div>
      <KbManager knowledgebases={knowledgebases} />
    </div>
  );
}
