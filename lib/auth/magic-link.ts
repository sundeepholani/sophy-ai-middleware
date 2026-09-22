/** Shared identity/token helpers. Legacy email sign-in links are no longer accepted. */
import { createHash } from 'node:crypto';
import type { UserStatus } from '@/db/schema';

export interface AuthUser { id: string; email: string }

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** High-entropy invitation and CLI tokens can safely use a SHA-256 digest. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Pure onboarding decision shared by implementation and focused tests. */
export function authIntentOnboardingDecision(
  existingStatus: UserStatus | null,
): 'create_my_project' | 'sign_in' | 'reject' {
  if (existingStatus === null) return 'create_my_project';
  return existingStatus === 'active' ? 'sign_in' : 'reject';
}
