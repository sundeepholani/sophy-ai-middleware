import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacySettingsPage() {
  return redirectToDefaultProject('settings');
}
