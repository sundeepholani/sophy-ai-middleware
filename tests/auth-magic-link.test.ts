import { describe, it, expect } from 'vitest';
import {
  authIntentOnboardingDecision,
  normalizeEmail,
  hashToken,
} from '@/lib/auth/magic-link';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(normalizeEmail('a@b.co')).toBe('a@b.co');
  });
});

describe('hashToken', () => {
  it('is a deterministic 64-char hex digest, never the raw token', () => {
    const raw = 'abc123';
    const h = hashToken(raw);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashToken(raw)); // deterministic
    expect(h).not.toBe(raw);
    expect(hashToken('abc124')).not.toBe(h); // sensitive to input
  });
});

describe('self-signup onboarding decision', () => {
  it('creates My Project only when no identity exists', () => {
    expect(authIntentOnboardingDecision(null)).toBe('create_my_project');
  });

  it('signs in an active invitation-created identity without another project', () => {
    expect(authIntentOnboardingDecision('active')).toBe('sign_in');
  });

  it('does not reactivate an inactive identity', () => {
    expect(authIntentOnboardingDecision('inactive')).toBe('reject');
  });
});
