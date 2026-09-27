/**
 * Validate a post-login redirect target to prevent open redirects.
 *
 * Only same-origin, root-relative paths under the console (`/admin…`) are
 * allowed; anything off-origin, protocol-relative, or outside /admin falls back
 * to `/admin`. Both the value as given (what the browser navigates to) and its
 * decoded form (what encoded tricks such as `%2F%2F` or `%2e%2e` become) must
 * pass. The value is returned as given, so percent-encoded query values
 * (`%26`, `%23`, `%2B`) keep their meaning. Pure (no imports) so it is
 * trivially unit-testable.
 */

/** True if the string contains any ASCII control char or space (0x00–0x20). */
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x20) return true;
  }
  return false;
}

function isConsolePath(path: string): boolean {
  // Must be a single-slash root-relative path — reject scheme, protocol-relative
  // (`//evil`), backslash tricks (`/\evil`), and any control/space characters.
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//') || path.startsWith('/\\')) return false;
  if (path.includes('://') || path.includes('\\')) return false;
  if (path.includes('..')) return false; // can't normalize back out of /admin
  if (hasControlOrSpace(path)) return false;
  // Restrict to the console surface.
  return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/admin?');
}

export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/admin';
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return '/admin';
  }
  return isConsolePath(next) && isConsolePath(decoded) ? next : '/admin';
}
