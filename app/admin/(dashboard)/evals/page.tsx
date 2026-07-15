import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyEvalsPage() {
  return redirectToDefaultProject('evals');
}
