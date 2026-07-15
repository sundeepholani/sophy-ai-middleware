import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyModelsPage() {
  return redirectToDefaultProject('models');
}
