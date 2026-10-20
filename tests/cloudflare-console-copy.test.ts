import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_ERROR_COPY,
  CLOUDFLARE_TOAST,
  cloudflareBindingCopy,
  cloudflareFailureLabel,
  cloudflareFormError,
  cloudflareHealthLabel,
  cloudflareKeysNotice,
  cloudflareStatusCopy,
  cloudflareThrownErrorCopy,
  cloudflareViewerNote,
} from '@/components/admin/cloudflare-copy';
import type { ProjectCloudflareSummary } from '@/components/admin/project-types';

/**
 * Console copy for the optional Cloudflare Workers AI credential (D10, contract §4.3).
 * The card and the Keys callouts render these strings; a .tsx file cannot be tested in
 * this node-only vitest setup, so the copy lives in its own pure module.
 */

const STATES: ProjectCloudflareSummary['state'][] = ['not_connected', 'ready', 'attention'];
const HEALTHS: ProjectCloudflareSummary['health'][] = [
  'unchecked',
  'healthy',
  'invalid',
  'billing_attention',
  null,
];

describe('Cloudflare console copy', () => {
  it('maps every action code to its §4.3 sentence', () => {
    expect(Object.keys(CLOUDFLARE_ERROR_COPY).sort()).toEqual(
      [
        'cloudflare_invalid_account_id',
        'cloudflare_invalid',
        'cloudflare_unreachable',
        'cloudflare_in_use',
        'not_found',
      ].sort(),
    );
    expect(CLOUDFLARE_ERROR_COPY.cloudflare_invalid_account_id).toBe(
      'Account ID must be 32 hexadecimal characters.',
    );
    expect(CLOUDFLARE_ERROR_COPY.cloudflare_invalid).toBe(
      'Cloudflare rejected that account ID and API token. Use the "Workers AI" token template.',
    );
    expect(CLOUDFLARE_ERROR_COPY.cloudflare_unreachable).toBe(
      "Couldn't reach Cloudflare to check the token. Try again.",
    );
    expect(CLOUDFLARE_ERROR_COPY.cloudflare_in_use).toBe(
      'That API token is already connected to another Sophy project.',
    );
    expect(CLOUDFLARE_ERROR_COPY.not_found).toBe('This project is no longer available.');
  });

  it('never echoes a thrown message', () => {
    expect(
      cloudflareThrownErrorCopy(new Error('Failed query: insert … params: cf_tok_secret')),
    ).toBe("Couldn't update the Cloudflare connection. Try again.");
    expect(cloudflareThrownErrorCopy(new Error('forbidden'))).toBe(
      'Only a Project Admin can manage this connection.',
    );
    expect(cloudflareThrownErrorCopy(new Error('unauthorized'))).toBe(
      'Your session expired — sign in again.',
    );
    expect(cloudflareThrownErrorCopy('forbidden')).toBe(
      "Couldn't update the Cloudflare connection. Try again.",
    );
    expect(cloudflareThrownErrorCopy(undefined)).toBe(
      "Couldn't update the Cloudflare connection. Try again.",
    );
  });

  it('calls an unconnected project optional, never "setup required"', () => {
    const optional = cloudflareStatusCopy({ state: 'not_connected', isReady: false, health: null });
    expect(optional.badge).toBe('Optional · Not connected');
    expect(optional.variant).toBe('outline');
    expect(optional.icon).toBe('optional');
    for (const state of STATES) {
      for (const health of HEALTHS) {
        for (const isReady of [true, false]) {
          const copy = cloudflareStatusCopy({ state, isReady, health });
          expect(JSON.stringify(copy)).not.toMatch(/setup required/i);
        }
      }
      expect(cloudflareViewerNote(state, 'Acme')).not.toMatch(/setup required/i);
    }
    expect(JSON.stringify(CLOUDFLARE_ERROR_COPY)).not.toMatch(/setup required/i);
    expect(JSON.stringify(CLOUDFLARE_TOAST)).not.toMatch(/setup required/i);
  });

  it('shows the connected state only for a ready credential', () => {
    const ready = cloudflareStatusCopy({ state: 'ready', isReady: true, health: 'healthy' });
    expect(ready).toMatchObject({
      icon: 'connected',
      badge: 'Connected',
      variant: 'default',
      title: 'Cloudflare Workers AI is connected',
    });
    // An Editor's redacted summary keeps isReady, so Editors see the same connected copy.
    expect(cloudflareStatusCopy({ state: 'ready', isReady: true, health: null }).badge).toBe(
      'Connected',
    );
  });

  it('gives Editors only generic attention wording', () => {
    const copy = cloudflareStatusCopy({ state: 'attention', isReady: false, health: null });
    expect(copy.title).toBe('Cloudflare connection needs attention');
    expect(copy.badge).toBe('Needs attention');
    expect(copy.variant).toBe('destructive');
    expect(copy.description).not.toMatch(/rejected|billing/i);
  });

  it('tells Admins when Cloudflare rejected the token', () => {
    const copy = cloudflareStatusCopy({ state: 'attention', isReady: false, health: 'invalid' });
    expect(copy.badge).toBe('Needs attention');
    expect(copy.variant).toBe('destructive');
    expect(copy.title).toBe('Cloudflare credential needs attention');
    expect(copy.description).toMatch(/rejected/);

    const billing = cloudflareStatusCopy({
      state: 'attention',
      isReady: false,
      health: 'billing_attention',
    });
    expect(billing.badge).toBe('Billing attention');
    expect(billing.title).toBe('Cloudflare billing needs attention');
  });

  it('pre-checks the form like the server normaliser', () => {
    expect(cloudflareFormError('0123456789ABCDEF0123456789ABCDEF', 'tok')).toBeNull();
    expect(cloudflareFormError(' 0123456789abcdef0123456789abcdef ', 'tok')).toBeNull();
    expect(cloudflareFormError('xyz', 'tok')).toBe(
      'Account ID must be 32 hexadecimal characters.',
    );
    expect(cloudflareFormError('0123456789abcdef0123456789abcdef', '   ')).toBe(
      'Enter the API token.',
    );
  });

  it('binding copy depends on the role and passes other text through', () => {
    expect(cloudflareBindingCopy('cloudflare_not_ready', 'admin')).toBe(
      'Connect Cloudflare Workers AI in Settings before using this model.',
    );
    expect(cloudflareBindingCopy('cloudflare_not_ready', 'editor')).toBe(
      'A Project Admin must connect Cloudflare Workers AI before keys can use this model.',
    );
    expect(cloudflareBindingCopy('Unsupported Cloudflare Workers AI model', 'editor')).toBe(
      'Unsupported Cloudflare Workers AI model',
    );
  });

  it('keys notice pluralises and names the right actor', () => {
    const one = cloudflareKeysNotice(1, 'admin');
    expect(one.title).toBe('Cloudflare Workers AI is not ready');
    expect(
      one.body.startsWith(
        '1 active key uses a Cloudflare Workers AI model. Requests to it fail until you connect',
      ),
    ).toBe(true);
    const three = cloudflareKeysNotice(3, 'editor');
    expect(three.body).toContain('3 active keys use');
    expect(three.body).toContain('a Project Admin connects');
  });

  it('labels health and failure codes', () => {
    expect(cloudflareHealthLabel('healthy')).toBe('Healthy');
    expect(cloudflareHealthLabel('invalid')).toBe('Rejected by Cloudflare');
    expect(cloudflareHealthLabel('billing_attention')).toBe('Billing attention');
    expect(cloudflareHealthLabel('unchecked')).toBe('Not checked yet');
    expect(cloudflareHealthLabel(null)).toBe('—');
    expect(cloudflareFailureLabel('cloudflare_authentication_failed')).toBe(
      'Cloudflare rejected the API token',
    );
    expect(cloudflareFailureLabel(null)).toBeNull();
  });

  it('names the project in the non-Admin notes', () => {
    expect(cloudflareViewerNote('ready', 'Acme')).toBe(
      'A Project Admin manages the Cloudflare Workers AI connection for Acme.',
    );
    expect(cloudflareViewerNote('not_connected', 'Acme')).toMatch(/^Optional\./);
    expect(cloudflareViewerNote('attention', 'Acme')).toBe(
      'A Project Admin needs to check the Cloudflare Workers AI connection for Acme.',
    );
  });
});
