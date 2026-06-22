import { describe, it, expect } from 'vitest';
import { safeNextPath } from '@/lib/auth/safe-next';

describe('safeNextPath', () => {
  it('allows same-origin console paths', () => {
    expect(safeNextPath('/admin')).toBe('/admin');
    expect(safeNextPath('/admin/keys')).toBe('/admin/keys');
    expect(safeNextPath('/admin/usage?range=7')).toBe('/admin/usage?range=7');
    expect(safeNextPath('/admin?tab=x')).toBe('/admin?tab=x');
    expect(safeNextPath('/admin/logs/some-id-123')).toBe('/admin/logs/some-id-123');
  });

  it('falls back to /admin for empty / non-admin paths', () => {
    expect(safeNextPath(null)).toBe('/admin');
    expect(safeNextPath(undefined)).toBe('/admin');
    expect(safeNextPath('')).toBe('/admin');
    expect(safeNextPath('/login')).toBe('/admin');
    expect(safeNextPath('/adminish')).toBe('/admin'); // not /admin or /admin/
    expect(safeNextPath('relative/path')).toBe('/admin');
  });

  it('rejects open-redirect / smuggling attempts', () => {
    expect(safeNextPath('//evil.com')).toBe('/admin');
    expect(safeNextPath('https://evil.com')).toBe('/admin');
    expect(safeNextPath('/\\evil.com')).toBe('/admin');
    expect(safeNextPath('/admin/../../etc')).toBe('/admin'); // '..' can't normalize out of /admin
    expect(safeNextPath('javascript:alert(1)')).toBe('/admin');
    expect(safeNextPath('/admin\nSet-Cookie: x')).toBe('/admin'); // control char
    expect(safeNextPath('%2F%2Fevil.com')).toBe('/admin'); // encoded //
    expect(safeNextPath('/admin%20 with space')).toBe('/admin');
  });
});
