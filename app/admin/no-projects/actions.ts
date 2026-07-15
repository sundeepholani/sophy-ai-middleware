'use server';

import { redirect } from 'next/navigation';
import { ensureRecoveryProject } from '@/app/admin/project-actions';

/** Recover an authenticated identity that no longer has any active membership. */
export async function createRecoveryProject(): Promise<never> {
  const { projectId } = await ensureRecoveryProject();
  redirect(`/admin/p/${projectId}`);
}
