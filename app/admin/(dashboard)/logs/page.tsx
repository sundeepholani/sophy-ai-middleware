import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyLogsPage() {
  return redirectToDefaultProject('logs');
}
