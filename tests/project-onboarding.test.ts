import { describe, expect, it } from 'vitest';
import {
  invitationDefaultProject,
  invitationMembershipOutcome,
} from '@/lib/projects/onboarding';

describe('invitation onboarding', () => {
  it('makes the first invited project the default', () => {
    expect(invitationDefaultProject(null, 'invited-project')).toBe('invited-project');
  });

  it('never replaces an established default', () => {
    expect(invitationDefaultProject('my-project', 'invited-project')).toBe('my-project');
  });

  it('creates absent membership with the invited role', () => {
    expect(invitationMembershipOutcome('admin', null)).toEqual({
      role: 'admin',
      status: 'active',
      created: true,
    });
  });

  it('preserves an existing role and status when an old invite is redeemed', () => {
    expect(
      invitationMembershipOutcome('admin', {
        role: 'editor',
        status: 'suspended',
      }),
    ).toEqual({
      role: 'editor',
      status: 'suspended',
      created: false,
    });
  });
});
