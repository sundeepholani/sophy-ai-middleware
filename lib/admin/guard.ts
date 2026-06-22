/**
 * Back-compat re-export. The authorization source of truth is lib/auth/viewer.ts
 * (assertAdmin now returns the Viewer and is role-aware). Prefer importing from
 * there directly.
 */
export { assertAdmin, assertUser, assertCanManageKey, assertCanManageRun } from '@/lib/auth/viewer';
