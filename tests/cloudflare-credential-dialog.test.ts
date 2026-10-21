import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectCloudflareSummary } from '@/components/admin/project-types';

/**
 * The Cloudflare credential dialog must stay open while connect or rotate is being verified
 * (up to 10 s): its inline error is the only report of a failed attempt, so a dismissal mid-check
 * would hide it. This vitest setup is node-only, so the card is rendered on the server with the
 * dialog primitives replaced by stubs that capture their props, and with `useTransition`
 * reporting the pending state the test chooses. Every state-setter call is recorded, so a close
 * request that is ignored is visible as no call at all.
 */

const ui = vi.hoisted(() => ({
  pending: false,
  setStateCalls: [] as unknown[],
  dialog: undefined as undefined | { open: boolean; onOpenChange: (open: boolean) => void },
  content: undefined as undefined | { showCloseButton?: boolean },
  buttons: [] as Array<{ type?: string; disabled?: boolean; children?: ReactNode }>,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    // A server render never has a pending transition; the test supplies it.
    useTransition: () => [ui.pending, (callback: () => void) => callback()],
    useState: (initial: unknown) => {
      const [value, set] = actual.useState(initial);
      return [value, (next: unknown) => {
        ui.setStateCalls.push(next);
        set(next);
      }];
    },
  };
});

const { passthrough } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: ReactNode }) => children ?? null,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: (props: { open: boolean; onOpenChange: (open: boolean) => void; children?: ReactNode }) => {
    ui.dialog = props;
    return props.children;
  },
  DialogContent: (props: { showCloseButton?: boolean; children?: ReactNode }) => {
    ui.content = props;
    return props.children;
  },
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
}));
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: () => null,
  AlertDialogAction: passthrough,
  AlertDialogCancel: passthrough,
  AlertDialogContent: passthrough,
  AlertDialogDescription: passthrough,
  AlertDialogFooter: passthrough,
  AlertDialogHeader: passthrough,
  AlertDialogTitle: passthrough,
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { type?: string; disabled?: boolean; children?: ReactNode }) => {
    ui.buttons.push(props);
    return props.children;
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CloudflareCredentialCard } from '@/components/admin/cloudflare-credential-card';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const SUMMARY: ProjectCloudflareSummary = {
  projectId: PROJECT,
  state: 'not_connected',
  isReady: false,
  credentialId: null,
  accountId: null,
  lifecycle: null,
  health: null,
  lastFour: null,
  connectedAt: null,
  verifiedAt: null,
  lastCheckedAt: null,
  lastFailureCode: null,
};

function render(pending: boolean) {
  ui.pending = pending;
  ui.dialog = undefined;
  ui.content = undefined;
  ui.buttons = [];
  renderToStaticMarkup(
    createElement(CloudflareCredentialCard, {
      projectId: PROJECT,
      projectName: 'Acme',
      role: 'admin',
      summary: SUMMARY,
      connectAction: vi.fn(),
      disconnectAction: vi.fn(),
    }),
  );
  ui.setStateCalls = [];
}

function cancelButton() {
  const found = ui.buttons.filter((b) => b.type === 'button' && b.children === 'Cancel');
  expect(found).toHaveLength(1);
  return found[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Cloudflare credential dialog', () => {
  it('ignores Escape, backdrop and close-button requests while the credential is being verified', () => {
    render(true);
    expect(ui.dialog).toBeDefined();
    ui.dialog!.onOpenChange(false);
    expect(ui.setStateCalls).toEqual([]);
    expect(ui.content?.showCloseButton).toBe(false);
    expect(cancelButton().disabled).toBe(true);
  });

  it('closes normally when nothing is pending', () => {
    render(false);
    ui.dialog!.onOpenChange(false);
    expect(ui.setStateCalls).toEqual([false]);
    // DialogContent shows its close button unless told otherwise.
    expect(ui.content?.showCloseButton ?? true).toBe(true);
    expect(cancelButton().disabled).toBeFalsy();
  });

  it('never blocks opening', () => {
    render(true);
    ui.dialog!.onOpenChange(true);
    expect(ui.setStateCalls).toEqual([true]);
  });
});
