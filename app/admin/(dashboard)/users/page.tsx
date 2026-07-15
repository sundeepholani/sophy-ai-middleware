import { redirectToDefaultProject } from '@/app/admin/legacy-project-redirect';

export default async function LegacyUsersPage() {
  return redirectToDefaultProject('members');
}
