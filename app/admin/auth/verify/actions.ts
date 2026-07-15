'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/admin-session';
import { consumeToken } from '@/lib/auth/magic-link';
import { safeNextPath } from '@/lib/auth/safe-next';

/**
 * Redeem the magic-link token (POST only, so email scanners that prefetch the
 * link with GET can't burn it) and establish the session. Invalid/expired tokens
 * bounce back to the landing page in an error state.
 */
export async function confirmSignIn(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const next = formData.get('next');

  const user = await consumeToken(token);
  if (!user) redirect('/admin/auth/verify?error=1');

  const session = await getSession();
  // The cookie is fully re-serialized on save(), so set the new identity and clear
  // every legacy authority claim. Project roles are always loaded from Postgres.
  session.userId = user.id;
  session.role = undefined;
  session.email = undefined;
  session.loginAt = Date.now();
  session.sealedAt = Date.now();
  session.isAdmin = undefined;
  await session.save();

  redirect(safeNextPath(typeof next === 'string' ? next : null));
}
