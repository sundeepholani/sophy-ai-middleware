import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bind-time rules for Cloudflare Workers AI models (D3, D4, D5; contract §2.15):
 * the pure helpers in lib/admin/keys.ts, and the same rules through the real
 * createKey / updateKey / bulkUpdateKeyModel actions. Every module the actions
 * touch at load time is mocked or pure, and nothing reaches a database or network.
 */

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  revalidatePath: vi.fn(),
  requireProjectViewer: vi.fn(),
  assertCanManageKey: vi.fn(),
  getProjectGatewaySummary: vi.fn(),
  getProjectCloudflareSummary: vi.fn(),
  listAllModels: vi.fn(),
  issueKey: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/auth/viewer', () => ({
  requireProjectViewer: mocks.requireProjectViewer,
  assertProjectAdmin: vi.fn(),
  assertCanManageKey: mocks.assertCanManageKey,
  assertCanManageRun: vi.fn(),
}));
vi.mock('@/lib/auth/api-key', () => ({ issueKey: mocks.issueKey, generateKey: vi.fn() }));
vi.mock('@/lib/projects/repository', () => ({
  getProjectGatewaySummary: mocks.getProjectGatewaySummary,
  getProjectCloudflareSummary: mocks.getProjectCloudflareSummary,
}));
vi.mock('@/lib/gateway/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/models')>()),
  listAllModels: mocks.listAllModels,
}));
vi.mock('@/lib/admin/settings', () => ({ getSettings: vi.fn() }));
vi.mock('@/lib/admin/queries', () => ({ getKeyEvals: vi.fn() }));

import { bulkUpdateKeyModel, createKey, updateKey, type KeyFormInput } from '@/app/admin/actions';
import {
  CLOUDFLARE_NOT_READY,
  UNSUPPORTED_CLOUDFLARE_MODEL,
  cloudflareBindingError,
  cloudflareModelBadges,
  keyFormCloudflareError,
} from '@/lib/admin/keys';
import type { AvailableModel } from '@/lib/gateway/capabilities';
import { CLOUDFLARE_MODELS } from '@/lib/gateway/cloudflare-models';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const KEY = '00000000-0000-4000-8000-000000000002';
const ADMIN = {
  userId: '00000000-0000-4000-8000-000000000005',
  email: 'admin@example.com',
  role: 'admin',
  projectId: PROJECT,
  projectName: 'Project',
  projectSlug: 'project',
  projectStatus: 'active',
  defaultProjectId: PROJECT,
};
const BASE: KeyFormInput = {
  name: 'Clef key',
  model: '@cf/cloudflare/clef',
  systemPrompt: null,
  params: {},
  outputSchema: null,
  rpmLimit: null,
  logContent: false,
};
const UNREGISTERED = '@cf/meta/llama-3.1-8b-instruct';
const GPT: AvailableModel = {
  id: 'openai/gpt-5-mini',
  name: 'GPT-5 mini',
  provider: 'openai',
  type: 'language',
  contextWindow: null,
  maxTokens: null,
  inputPerMTok: null,
  outputPerMTok: null,
  description: null,
  tags: [],
};
/** What assertCanManageKey returns for an active key the admin may manage. */
function managedKey(model: string) {
  return {
    viewer: ADMIN,
    name: 'k1',
    status: 'active',
    model,
    systemPrompt: null,
    params: {},
    ownerUserId: null,
  };
}

type Call = { method: string; args: unknown[] };
/** Drizzle-shaped stub. Every builder method chains and is recorded; awaiting a select chain yields
 *  the next queued rows, and awaiting a write yields undefined. */
function fakeDb(selectQueue: unknown[][] = []) {
  const calls: Call[] = [];
  const chain = (result: () => unknown): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
              try {
                resolve(result());
              } catch (error) {
                reject(error);
              }
            };
          }
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const db = {
    select: (...args: unknown[]) => {
      calls.push({ method: 'select', args });
      return chain(() => selectQueue.shift() ?? []);
    },
    insert: (...args: unknown[]) => {
      calls.push({ method: 'insert', args });
      return chain(() => undefined);
    },
    update: (...args: unknown[]) => {
      calls.push({ method: 'update', args });
      return chain(() => undefined);
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const setArgs = () => calls.filter((c) => c.method === 'set').map((c) => c.args[0]);
  return { db, calls, setArgs };
}

let fake: ReturnType<typeof fakeDb>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireProjectViewer.mockResolvedValue(ADMIN);
  mocks.getProjectGatewaySummary.mockResolvedValue({ isReady: true });
  mocks.getProjectCloudflareSummary.mockResolvedValue({ isReady: true });
  mocks.listAllModels.mockRejectedValue(new Error('catalog down')); // default: Vercel catalog outage
  mocks.issueKey.mockResolvedValue({ id: KEY, fullKey: 'sk-sophy-test' });
  fake = fakeDb();
  mocks.getDb.mockReturnValue(fake.db);
});

describe('cloudflareBindingError', () => {
  it('returns null for non-Workers-AI ids, ready or not', () => {
    for (const id of [
      'openai/gpt-5-mini',
      'typesafe-ai/jev',
      'private/custom-model',
      'cf/cloudflare/clef',
      '',
    ]) {
      expect(cloudflareBindingError(id, true)).toBeNull();
      expect(cloudflareBindingError(id, false)).toBeNull();
    }
  });

  it('accepts every registered id only when the credential is ready', () => {
    expect(CLOUDFLARE_MODELS.length).toBeGreaterThan(0);
    for (const m of CLOUDFLARE_MODELS) {
      expect(cloudflareBindingError(m.id, true)).toBeNull();
      expect(cloudflareBindingError(m.id, false)).toBe(CLOUDFLARE_NOT_READY);
    }
    expect(CLOUDFLARE_NOT_READY).toBe('cloudflare_not_ready');
  });

  it('fails closed for unregistered, mis-cased, padded or traversal ids', () => {
    for (const id of [
      UNREGISTERED,
      '@cf/Cloudflare/Clef',
      '@cf/cloudflare/clef ',
      ' @cf/cloudflare/clef',
      '@cf/cloudflare/../clef',
      '@cf/',
    ]) {
      expect(cloudflareBindingError(id, true)).toBe(UNSUPPORTED_CLOUDFLARE_MODEL);
    }
    expect(UNSUPPORTED_CLOUDFLARE_MODEL).toBe('Unsupported Cloudflare Workers AI model');
  });
});

describe('keyFormCloudflareError', () => {
  it('blocks a Workers AI model on create while not ready', () => {
    expect(
      keyFormCloudflareError({
        model: '@cf/cloudflare/clef',
        initialModel: null,
        cloudflareReady: false,
      }),
    ).toBe('cloudflare_not_ready');
  });

  it('lets an existing Workers AI key be edited while Cloudflare is down', () => {
    expect(
      keyFormCloudflareError({
        model: '@cf/cloudflare/clef',
        initialModel: '@cf/cloudflare/clef',
        cloudflareReady: false,
      }),
    ).toBeNull();
  });

  it('blocks switching a key onto a different Workers AI model while not ready', () => {
    expect(
      keyFormCloudflareError({
        model: '@cf/cloudflare/clef',
        initialModel: 'openai/gpt-5-mini',
        cloudflareReady: false,
      }),
    ).toBe('cloudflare_not_ready');
    expect(
      keyFormCloudflareError({
        model: '@cf/cloudflare/clef-flash',
        initialModel: '@cf/cloudflare/clef',
        cloudflareReady: false,
      }),
    ).toBe('cloudflare_not_ready');
  });

  it('rejects an unregistered id even when the model is unchanged', () => {
    expect(
      keyFormCloudflareError({
        model: UNREGISTERED,
        initialModel: UNREGISTERED,
        cloudflareReady: false,
      }),
    ).toBe(UNSUPPORTED_CLOUDFLARE_MODEL);
  });
});

describe('cloudflareModelBadges', () => {
  it('labels Workers AI models and marks Clairic as a preview', () => {
    expect(cloudflareModelBadges('@cf/cloudflare/clef', true)).toEqual(['Cloudflare']);
    expect(cloudflareModelBadges('@cf/cloudflare/clairic', true)).toEqual(['Cloudflare', 'Preview']);
    expect(cloudflareModelBadges('@cf/cloudflare/clef-flash', false)).toEqual(['Needs Cloudflare']);
    expect(cloudflareModelBadges('@cf/cloudflare/clairic', false)).toEqual([
      'Needs Cloudflare',
      'Preview',
    ]);
    expect(cloudflareModelBadges('openai/gpt-5-mini', true)).toEqual([]);
    expect(cloudflareModelBadges(UNREGISTERED, true)).toEqual([]);
  });
});

describe('createKey', () => {
  it('refuses a Workers AI model while the Cloudflare credential is not ready', async () => {
    mocks.getProjectCloudflareSummary.mockResolvedValue({ isReady: false });
    await expect(createKey({ ...BASE, projectId: PROJECT })).rejects.toThrow(
      'cloudflare_not_ready',
    );
    expect(mocks.getProjectCloudflareSummary).toHaveBeenCalledWith(PROJECT);
    expect(mocks.issueKey).not.toHaveBeenCalled();
  });

  it('keeps the Vercel readiness gate first and unchanged', async () => {
    mocks.getProjectGatewaySummary.mockResolvedValue({ isReady: false });
    await expect(createKey({ ...BASE, projectId: PROJECT })).rejects.toThrow('gateway_not_ready');
    expect(mocks.getProjectCloudflareSummary).not.toHaveBeenCalled();
    expect(mocks.issueKey).not.toHaveBeenCalled();
  });

  it('rejects an unregistered @cf id during a catalog outage', async () => {
    await expect(createKey({ ...BASE, projectId: PROJECT, model: UNREGISTERED })).rejects.toThrow(
      UNSUPPORTED_CLOUDFLARE_MODEL,
    );
    expect(mocks.getProjectCloudflareSummary).not.toHaveBeenCalled();
    expect(mocks.issueKey).not.toHaveBeenCalled();
  });

  it('rejects a padded Workers AI id instead of storing it', async () => {
    await expect(
      createKey({ ...BASE, projectId: PROJECT, model: '@cf/cloudflare/clef ' }),
    ).rejects.toThrow(UNSUPPORTED_CLOUDFLARE_MODEL);
    expect(mocks.issueKey).not.toHaveBeenCalled();
  });

  it('binds a registered model from the registry alone', async () => {
    await expect(
      createKey({ ...BASE, projectId: PROJECT, model: '@cf/cloudflare/clairic' }),
    ).resolves.toEqual({ fullKey: 'sk-sophy-test' });
    expect(mocks.listAllModels).not.toHaveBeenCalled();
    expect(mocks.getProjectCloudflareSummary).toHaveBeenCalledWith(PROJECT);
    expect(mocks.issueKey).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, model: '@cf/cloudflare/clairic' }),
      expect.anything(),
    );
  });

  it('never reads Cloudflare readiness for other models', async () => {
    mocks.listAllModels.mockResolvedValue([GPT]);
    await expect(
      createKey({ ...BASE, projectId: PROJECT, model: 'openai/gpt-5-mini' }),
    ).resolves.toEqual({ fullKey: 'sk-sophy-test' });
    expect(mocks.getProjectCloudflareSummary).not.toHaveBeenCalled();
  });
});

describe('updateKey', () => {
  it('refuses switching a key onto a Workers AI model while not ready', async () => {
    mocks.assertCanManageKey.mockResolvedValue(managedKey('openai/gpt-5-mini'));
    mocks.getProjectCloudflareSummary.mockResolvedValue({ isReady: false });
    await expect(
      updateKey({ ...BASE, projectId: PROJECT, id: KEY, model: '@cf/cloudflare/clef-flash' }),
    ).rejects.toThrow('cloudflare_not_ready');
    expect(mocks.getProjectCloudflareSummary).toHaveBeenCalledWith(PROJECT);
    expect(fake.calls.some((c) => c.method === 'update')).toBe(false);
  });

  it('lets an existing Clef key be renamed while Cloudflare is down', async () => {
    mocks.assertCanManageKey.mockResolvedValue(managedKey('@cf/cloudflare/clef'));
    mocks.getProjectCloudflareSummary.mockResolvedValue({ isReady: false });
    fake = fakeDb([[{ kb: null, params: {} }]]);
    mocks.getDb.mockReturnValue(fake.db);
    await expect(
      updateKey({ ...BASE, projectId: PROJECT, id: KEY, name: 'Renamed' }),
    ).resolves.toEqual({ requiresEvalStop: false, stoppedEval: false });
    expect(mocks.getProjectCloudflareSummary).not.toHaveBeenCalled();
    expect(fake.setArgs()[0]).toMatchObject({ name: 'Renamed', model: '@cf/cloudflare/clef' });
  });

  it('moves a key between Workers AI models when ready', async () => {
    mocks.assertCanManageKey.mockResolvedValue(managedKey('@cf/cloudflare/clef'));
    // The prior row, then no running eval on the key.
    fake = fakeDb([[{ kb: null, params: {} }], []]);
    mocks.getDb.mockReturnValue(fake.db);
    await expect(
      updateKey({ ...BASE, projectId: PROJECT, id: KEY, model: '@cf/cloudflare/clef-omni' }),
    ).resolves.toEqual({ requiresEvalStop: false, stoppedEval: false });
    expect(mocks.getProjectCloudflareSummary).toHaveBeenCalledWith(PROJECT);
    expect(mocks.listAllModels).not.toHaveBeenCalled();
    expect(fake.setArgs()[0]).toMatchObject({ model: '@cf/cloudflare/clef-omni' });
  });
});

describe('bulkUpdateKeyModel', () => {
  it('checks the registry before anything else', async () => {
    await expect(
      bulkUpdateKeyModel({ projectId: PROJECT, ids: [KEY], model: UNREGISTERED }),
    ).rejects.toThrow(UNSUPPORTED_CLOUDFLARE_MODEL);
    expect(mocks.requireProjectViewer).not.toHaveBeenCalled();
    expect(mocks.getProjectCloudflareSummary).not.toHaveBeenCalled();
    expect(mocks.assertCanManageKey).not.toHaveBeenCalled();
  });

  it('authenticates before revealing Cloudflare readiness', async () => {
    mocks.requireProjectViewer.mockRejectedValue(new Error('forbidden'));
    await expect(
      bulkUpdateKeyModel({ projectId: PROJECT, ids: [KEY], model: '@cf/cloudflare/clef' }),
    ).rejects.toThrow('forbidden');
    expect(mocks.getProjectCloudflareSummary).not.toHaveBeenCalled();
  });

  it('refuses the whole batch while not ready', async () => {
    mocks.getProjectCloudflareSummary.mockResolvedValue({ isReady: false });
    await expect(
      bulkUpdateKeyModel({ projectId: PROJECT, ids: [KEY], model: '@cf/cloudflare/clef' }),
    ).rejects.toThrow('cloudflare_not_ready');
    expect(mocks.assertCanManageKey).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('moves keys onto a Workers AI model during a catalog outage', async () => {
    mocks.assertCanManageKey.mockResolvedValue(managedKey('openai/gpt-5-mini'));
    fake = fakeDb([[]]); // no running eval
    mocks.getDb.mockReturnValue(fake.db);
    await expect(
      bulkUpdateKeyModel({ projectId: PROJECT, ids: [KEY], model: '@cf/cloudflare/clef' }),
    ).resolves.toEqual({ done: 1, skipped: [], stoppedEvals: 0 });
    expect(fake.setArgs()).toContainEqual({ model: '@cf/cloudflare/clef' });
  });

  it('does not touch Cloudflare for other targets', async () => {
    mocks.assertCanManageKey.mockResolvedValue(managedKey('vendor/old'));
    await expect(
      bulkUpdateKeyModel({ projectId: PROJECT, ids: [KEY], model: 'openai/gpt-5-mini' }),
    ).resolves.toEqual({ done: 1, skipped: [], stoppedEvals: 0 });
    expect(mocks.getProjectCloudflareSummary).not.toHaveBeenCalled();
    expect(mocks.requireProjectViewer).not.toHaveBeenCalled();
  });
});
