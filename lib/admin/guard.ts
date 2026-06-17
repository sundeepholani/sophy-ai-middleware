import { isAdminAuthed } from '@/lib/auth/admin-session';

/** Throw if the caller is not an authenticated admin. Defense in depth behind middleware. */
export async function assertAdmin(): Promise<void> {
  if (!(await isAdminAuthed())) {
    throw new Error('unauthorized');
  }
}
