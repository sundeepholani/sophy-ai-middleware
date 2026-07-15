import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyKeysPage() {
  return redirectToDefaultProject('keys');
}
