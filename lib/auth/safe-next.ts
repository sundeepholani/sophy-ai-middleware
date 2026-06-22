/**
 * Validate a post-login redirect target to prevent open redirects.
 *
 * Only same-origin, root-relative paths under the console (`/admin…`) are
 * allowed; anything off-origin, protocol-relative, or outside /admin falls back
 * to `/admin`. Pure (no imports) so it is trivially unit-testable.
 */

/** True if the string contains any ASCII control char or space (0x00–0x20). */
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x20) return true;
  }
  return false;
}

export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/admin';
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return '/admin';
  }
  // Must be a single-slash root-relative path — reject scheme, protocol-relative
  // (`//evil`), backslash tricks (`/\evil`), and any control/space characters.
  if (!decoded.startsWith('/')) return '/admin';
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) return '/admin';
  if (decoded.includes('://') || decoded.includes('\\')) return '/admin';
  if (decoded.includes('..')) return '/admin'; // can't normalize back out of /admin
  if (hasControlOrSpace(decoded)) return '/admin';
  // Restrict to the console surface.
  if (decoded === '/admin' || decoded.startsWith('/admin/') || decoded.startsWith('/admin?')) {
    return decoded;
  }
  return '/admin';
}
