import { notFound } from 'next/navigation';
import { getPromptDetail } from '@/lib/admin/queries';
import { PromptEditor } from '@/components/admin/prompt-editor';

export const dynamic = 'force-dynamic';

export default async function PromptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getPromptDetail(id);
  if (!detail) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{detail.prompt.name}</h1>
        <p className="text-sm text-muted-foreground">Edit, save versions, publish or roll back.</p>
      </div>
      <PromptEditor promptId={detail.prompt.id} versions={detail.versions} />
    </div>
  );
}
