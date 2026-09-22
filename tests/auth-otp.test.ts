import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashOtp, invitationTokenFromNext } from '@/lib/auth/otp';
import { isAuthJsonRequest, readAuthJson } from '@/lib/auth/request';
import { getScopedCliIdentity, resolveCliSession, withCliIdentity } from '@/lib/auth/cli-session';

const password = 'test-session-password-with-at-least-32-characters';
afterEach(() => vi.unstubAllEnvs());

describe('OTP secrets and invitation context', () => {
  it('binds low-entropy codes to the server secret, challenge and email', () => {
    vi.stubEnv('SESSION_PASSWORD', password);
    const hash = hashOtp('challenge-a', 'A@B.com', '001234');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOtp('challenge-a', 'a@b.com', '001234')).toBe(hash);
    expect(hashOtp('challenge-b', 'a@b.com', '001234')).not.toBe(hash);
    expect(hashOtp('challenge-a', 'c@b.com', '001234')).not.toBe(hash);
    expect(hashOtp('challenge-a', 'a@b.com', '001235')).not.toBe(hash);
    vi.stubEnv('SESSION_PASSWORD', `${password}-changed`);
    expect(hashOtp('challenge-a', 'a@b.com', '001234')).not.toBe(hash);
  });
  it('accepts invitation context only from the exact local acceptance page', () => {
    expect(invitationTokenFromNext('/admin/invitations/accept?token=example')).toBe('example');
    for (const next of ['https://evil.test/admin/invitations/accept?token=x', '//evil.test/admin/invitations/accept?token=x', '/admin?token=x']) {
      expect(invitationTokenFromNext(next)).toBeNull();
    }
  });
});

describe('public authentication request bounds', () => {
  it('requires JSON and rejects cross-site browser submission', () => {
    expect(isAuthJsonRequest(new Request('https://sophy.test', { method: 'POST', body: 'email=a' }))).toBe(false);
    expect(isAuthJsonRequest(new Request('https://sophy.test', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' }))).toBe(false);
  });
  it('bounds chunked bodies without content-length', async () => {
    const oversized = new Request('https://sophy.test', { method: 'POST', body: JSON.stringify({ email: 'a'.repeat(5000) }) });
    expect(await readAuthJson(oversized)).toBeNull();
    expect(await readAuthJson(new Request('https://sophy.test', { method: 'POST', body: '{' }))).toBeNull();
    expect(await readAuthJson(new Request('https://sophy.test', { method: 'POST', body: '{"code":"001234"}' }))).toEqual({ code: '001234' });
  });
});

describe('CLI credential isolation', () => {
  it('rejects missing credentials, client API keys, cookies and malformed bearer tokens before DB access', async () => {
    for (const authorization of [null, '', 'Bearer mw_live_example', 'aimw_admin=sealed', 'Bearer sophy_cli_short']) {
      expect(await resolveCliSession(authorization)).toBeNull();
    }
  });
  it('isolates concurrent identity scopes and clears them after dispatch', async () => {
    const make = (userId: string) => ({ userId, email: `${userId}@example.test`, sessionId: userId, expiresAt: new Date() });
    expect(getScopedCliIdentity()).toBeUndefined();
    const ids = await Promise.all(['one', 'two'].map((id) => withCliIdentity(make(id), async () => {
      await new Promise((resolve) => setTimeout(resolve, id === 'one' ? 5 : 1));
      return getScopedCliIdentity()?.userId;
    })));
    expect(ids).toEqual(['one', 'two']);
    expect(getScopedCliIdentity()).toBeUndefined();
  });
});
