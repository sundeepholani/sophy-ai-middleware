import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(async () => null),
  getSession: vi.fn(),
  getDb: vi.fn(() => { throw new Error('unexpected_database_access'); }),
  redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }),
}));
vi.mock('@/lib/auth/admin-session', () => ({ currentUser: mocks.currentUser, getSession: mocks.getSession }));
vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
import { acceptProjectInvitation } from '@/app/admin/invitations/accept/actions';
import VerifyPage from '@/app/admin/auth/verify/page';

beforeEach(() => vi.clearAllMocks());

describe('retired link authentication boundaries', () => {
  it('requires OTP sign-in before an invitation token can consume membership or create a session', async () => {
    const form = new FormData();
    form.set('token', 'synthetic-invitation-token');
    await expect(acceptProjectInvitation(form)).rejects.toThrow('redirect:/admin/login?next=');
    expect(mocks.redirect).toHaveBeenCalledWith('/admin/login?next=%2Fadmin%2Finvitations%2Faccept%3Ftoken%3Dsynthetic-invitation-token');
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
  it('sends old login links to OTP without redeeming them or trusting their redirect', async () => {
    await expect(VerifyPage({ searchParams: Promise.resolve({ next: 'https://attacker.invalid' }) })).rejects.toThrow('redirect:/admin/login?next=%2Fadmin');
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});
