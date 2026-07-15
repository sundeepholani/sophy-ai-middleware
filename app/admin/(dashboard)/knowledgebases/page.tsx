import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyKnowledgebasesPage() {
  return redirectToDefaultProject('knowledgebases');
}
