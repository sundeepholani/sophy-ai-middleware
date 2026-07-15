import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyEvalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return redirectToDefaultProject(`evals/${id}`);
}
