import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyOverviewPage() {
  return redirectToDefaultProject();
}
