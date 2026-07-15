import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyLogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return redirectToDefaultProject(`logs/${id}`);
}
