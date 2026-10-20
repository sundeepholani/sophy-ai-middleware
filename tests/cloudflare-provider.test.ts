import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));

import { APICallError, RetryError } from 'ai';
import { Column, getTableName, is, SQL, Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema';
import { postCloudflareOnce } from '@/lib/gateway/cloudflare-call';
import { CloudflareModelNotRegisteredError } from '@/lib/gateway/cloudflare-models';
import {
  createExplicitCloudflareRunner,
  normalizeCloudflareAccountId,
  normalizeCloudflareApiToken,
  normalizeProjectCloudflareError,
  resolveProjectCloudflare,
  validateCloudflareCredential,
  type ProjectCloudflareSnapshot,
} from '@/lib/gateway/cloudflare-provider';
import {
  encryptCloudflareCredential,
  GatewayCredentialCryptoError,
} from '@/lib/gateway/credential-crypto';
import {
  ProjectCloudflareUnavailableError,
  ProjectGatewayUnavailableError,
  projectGatewayUnavailableResponse,
  type ProjectGatewayUnavailableReason,
} from '@/lib/gateway/project-provider';

/**
 * The Cloudflare credential runtime (D1–D3): the runner and its URL, connect-time
 * validation, the resolver's 503 reasons, and the health compare-and-set that may
 * only ever touch the Cloudflare row a request snapshotted.
 */

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ROW_A = '00000000-0000-4000-8000-000000000002';
const ROW_B = '00000000-0000-4000-8000-000000000003';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000099';
const ACCT = '0123456789abcdef0123456789abcdef';
const OTHER_ACCT = 'fedcba9876543210fedcba9876543210';
const KEY = Buffer.alloc(32, 7).toString('base64');
const FP = 'fingerprint-test-key-material-32-bytes-minimum';
const TOKEN = 'cf-token';

const dialect = new PgDialect();
const rendered = (where: unknown) => dialect.sqlToQuery(where as SQL);

interface Recorded {
  method: string;
  args: unknown[];
}

/** One drizzle builder step: `method(...args)` records the call and returns the next step. */
function step(calls: Recorded[], methods: string[], end: () => Promise<unknown>): Record<string, unknown> {
  const [method, ...rest] = methods;
  return {
    [method]: (...args: unknown[]) => {
      calls.push({ method, args });
      return rest.length > 0 ? step(calls, rest, end) : end();
    },
  };
}

/**
 * A recording stand-in for getDb(): select → from → leftJoin → where → limit resolves to
 * `rows`; update → set → where resolves, or rejects with `updateError`.
 */
function fakeDb(rows: unknown[] = [], updateError?: Error) {
  const calls: Recorded[] = [];
  const db = {
    select: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'select', args });
      return step(calls, ['from', 'leftJoin', 'where', 'limit'], async () => rows);
    }),
    update: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'update', args });
      return step(calls, ['set', 'where'], async () => {
        if (updateError) throw updateError;
      });
    }),
  };
  mocks.getDb.mockReturnValue(db);
  return { db, calls };
}

function argsOf(calls: Recorded[], method: string): unknown[][] {
  return calls.filter((c) => c.method === method).map((c) => c.args);
}

/** JSON-safe view of recorded arguments: tables and columns by name, SQL rendered. */
function serialisable(value: unknown): unknown {
  if (is(value, Table)) return { table: getTableName(value) };
  if (is(value, Column)) return { column: `${getTableName(value.table)}.${value.name}` };
  if (is(value, SQL)) return dialect.sqlToQuery(value);
  if (Array.isArray(value)) return value.map(serialisable);
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialisable(v)]));
  }
  return value;
}

function stubFetch(respond: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async () => respond(),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** The row resolveProjectCloudflare selects, for a healthy current credential A. */
function credentialRow(patch: Record<string, unknown> = {}) {
  const envelope = encryptCloudflareCredential({
    projectId: PROJECT,
    credentialId: ROW_A,
    accountId: ACCT,
    apiToken: TOKEN,
    key: KEY,
    keyVersion: 'test-v1',
    fingerprintKey: FP,
  });
  return {
    projectStatus: 'active',
    currentCredentialId: ROW_A,
    credentialRevision: 3,
    credentialId: ROW_A,
    credentialProjectId: PROJECT,
    accountId: ACCT,
    lifecycle: 'available',
    health: 'healthy',
    encryptedSecret: envelope.encryptedSecret,
    encryptionNonce: envelope.encryptionNonce,
    encryptionTag: envelope.encryptionTag,
    encryptionKeyVersion: envelope.encryptionKeyVersion,
    ...patch,
  };
}

/** What the left join yields when the pointer matches no credential row. */
const NO_JOIN = {
  credentialId: null,
  credentialProjectId: null,
  accountId: null,
  lifecycle: null,
  health: null,
  encryptedSecret: null,
  encryptionNonce: null,
  encryptionTag: null,
  encryptionKeyVersion: null,
};

function tamperedTag(): string {
  const tag = Buffer.from(credentialRow().encryptionTag, 'base64');
  tag[0] ^= 1;
  return tag.toString('base64');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mocks.getDb.mockReset();
});

describe('Cloudflare credential normalisers', () => {
  it('normalises account ids', () => {
    expect(normalizeCloudflareAccountId('  0123456789ABCDEF0123456789ABCDEF ')).toBe(ACCT);
    for (const raw of [ACCT.slice(1), `${ACCT}0`, `g${ACCT.slice(1)}`, '', undefined as never, 1 as never]) {
      expect(normalizeCloudflareAccountId(raw), String(raw)).toBeNull();
    }
  });

  it('normalises API tokens', () => {
    expect(normalizeCloudflareApiToken(' tok_1 ')).toBe('tok_1');
    for (const raw of ['', 'a b', 'tok\r\nx-evil: 1', 'tökén', 'x'.repeat(513), undefined as never]) {
      expect(normalizeCloudflareApiToken(raw), JSON.stringify(raw)).toBeNull();
    }
    expect(normalizeCloudflareApiToken('x'.repeat(512))).toBe('x'.repeat(512));
  });
});

describe('createExplicitCloudflareRunner', () => {
  it('posts the exact Workers AI run request', async () => {
    const fetchMock = stubFetch(() => new Response('{}'));
    const signal = new AbortController().signal;
    await createExplicitCloudflareRunner(' 0123456789ABCDEF0123456789ABCDEF ', ' cf-token ').run(
      '@cf/cloudflare/clef-flash',
      { a: 1 },
      signal,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef-flash',
    );
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer cf-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect([...headers.keys()].filter((name) => name.startsWith('cf-aig-'))).toEqual([]);
    expect(init?.body).toBe('{"a":1}');
    expect(init?.signal).toBe(signal);
  });

  it('never builds a URL from an unregistered model', async () => {
    const fetchMock = stubFetch(() => new Response('{}'));
    const runner = createExplicitCloudflareRunner(ACCT, TOKEN);
    for (const model of ['@cf/cloudflare/../../workers/scripts', '@cf/meta/llama-3', 'openai/gpt-5-mini']) {
      await expect(runner.run(model, {}, new AbortController().signal)).rejects.toBeInstanceOf(
        CloudflareModelNotRegisteredError,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails eagerly on bad credentials', () => {
    const badAccount = thrown(() => createExplicitCloudflareRunner('nothex', 'tok'));
    expect(badAccount).toBeInstanceOf(GatewayCredentialCryptoError);
    expect(badAccount).toHaveProperty('message', 'Cloudflare account id is malformed.');
    const blankToken = thrown(() => createExplicitCloudflareRunner(ACCT, '  '));
    expect(blankToken).toBeInstanceOf(GatewayCredentialCryptoError);
    expect(blankToken).toHaveProperty('message', 'Cloudflare API token is missing or malformed.');
  });
});

describe('validateCloudflareCredential', () => {
  it('validates with the free models/search call', async () => {
    const fetchMock = stubFetch(() => Response.json({ success: true, result: [] }));
    await expect(validateCloudflareCredential(ACCT, TOKEN)).resolves.toBe('ok');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/models/search?search=clef&per_page=1`,
    );
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each<[string, string, () => Response]>([
    ['200 success:true', 'ok', () => Response.json({ success: true, result: [] })],
    ['401', 'invalid', () => new Response('{}', { status: 401 })],
    ['403', 'invalid', () => new Response('{}', { status: 403 })],
    ['429', 'unreachable', () => new Response('{}', { status: 429 })],
    ['500', 'unreachable', () => new Response('{}', { status: 500 })],
    ['503', 'unreachable', () => new Response('{}', { status: 503 })],
    ['200 success:false', 'unreachable', () => Response.json({ success: false })],
    ['200 <html>', 'unreachable', () => new Response('<html>', { status: 200 })],
    [
      'a dropped connection',
      'unreachable',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      'the 10 s timeout',
      'unreachable',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
  ])('classifies validation outcomes: %s → %s', async (_label, expected, respond) => {
    stubFetch(respond);
    await expect(validateCloudflareCredential(ACCT, TOKEN)).resolves.toBe(expected);
  });

  it('never sends unnormalised input', async () => {
    const fetchMock = stubFetch(() => Response.json({ success: true, result: [] }));
    await expect(validateCloudflareCredential(` ${ACCT}`, 'tok')).resolves.toBe('invalid');
    await expect(validateCloudflareCredential(ACCT, ' tok')).resolves.toBe('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveProjectCloudflare', () => {
  beforeEach(() => {
    vi.stubEnv('PROJECT_GATEWAY_ENCRYPTION_KEY', KEY);
    vi.stubEnv('PROJECT_GATEWAY_ENCRYPTION_KEY_VERSION', 'test-v1');
    vi.stubEnv('PROJECT_GATEWAY_FINGERPRINT_KEY', FP);
  });

  it('resolves a frozen snapshot from the Cloudflare tables only', async () => {
    const { calls } = fakeDb([credentialRow()]);
    const snapshot = await resolveProjectCloudflare(PROJECT);

    expect(snapshot).toMatchObject({
      projectId: PROJECT,
      cloudflareCredentialId: ROW_A,
      credentialRevision: 3,
      accountId: ACCT,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.runner)).toBe(true);
    expect(argsOf(calls, 'from')).toEqual([[schema.projects]]);
    expect(argsOf(calls, 'leftJoin')[0][0]).toBe(schema.projectCloudflareCredentials);
    for (const { args } of calls) {
      for (const arg of args) expect(arg).not.toBe(schema.projectGatewayCredentials);
    }
    const recorded = JSON.stringify(calls.map(({ method, args }) => [method, serialisable(args)]));
    expect(recorded).toContain('project_cloudflare_credentials');
    expect(recorded).not.toContain('project_gateway_credentials');

    const fetchMock = stubFetch(() => new Response('{}'));
    await snapshot.runner.run('@cf/cloudflare/clef', {}, new AbortController().signal);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  const unavailableCases: [string, ProjectGatewayUnavailableReason, Record<string, unknown> | null, string | undefined][] = [
    ['no project row', 'project_not_found', null, undefined],
    ['a suspended project', 'project_inactive', { projectStatus: 'suspended' }, undefined],
    ['a null pointer', 'credential_missing', { currentCredentialId: null, ...NO_JOIN }, undefined],
    ['no joined row', 'credential_missing', NO_JOIN, ROW_A],
    ['a row from another project', 'credential_missing', { credentialProjectId: OTHER_PROJECT }, ROW_A],
    ['a replaced row', 'credential_unavailable', { lifecycle: 'replaced' }, ROW_A],
    ['an invalid row', 'credential_invalid', { health: 'invalid' }, ROW_A],
    ['a billing_attention row', 'credential_billing_attention', { health: 'billing_attention' }, ROW_A],
    ['an unchecked row', 'credential_unchecked', { health: 'unchecked' }, ROW_A],
    ['a tampered tag', 'credential_misconfigured', { encryptionTag: tamperedTag() }, ROW_A],
    ['another account id (AAD mismatch)', 'credential_misconfigured', { accountId: OTHER_ACCT }, ROW_A],
    ['another key version', 'credential_misconfigured', { encryptionKeyVersion: 'other' }, ROW_A],
    ['an unnormalised stored account id', 'credential_misconfigured', { accountId: ACCT.toUpperCase() }, ROW_A],
  ];

  it.each(unavailableCases)(
    'maps every unavailable state to the typed Cloudflare 503: %s → %s',
    async (_label, reason, patch, credentialId) => {
      fakeDb(patch === null ? [] : [credentialRow(patch)]);
      const error = await resolveProjectCloudflare(PROJECT).then(
        () => {
          throw new Error('expected resolveProjectCloudflare to reject');
        },
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ProjectCloudflareUnavailableError);
      expect(ProjectGatewayUnavailableError.isInstance(error)).toBe(true);
      const typed = error as ProjectCloudflareUnavailableError;
      expect(typed).toMatchObject({
        projectId: PROJECT,
        reason,
        provider: 'cloudflare',
        statusCode: 503,
        code: 'project_gateway_unavailable',
      });
      expect(typed.cloudflareCredentialId).toBe(credentialId);
      expect(typed.gatewayCredentialId).toBeUndefined();
      expect(projectGatewayUnavailableResponse(error)!.status).toBe(503);
      if (reason === 'credential_misconfigured') {
        expect(typed.cause).toBeInstanceOf(GatewayCredentialCryptoError);
        const json = JSON.stringify(error).toLowerCase();
        expect(json).not.toContain(TOKEN);
        expect(json).not.toContain(ACCT);
      }
    },
  );
});

describe('normalizeProjectCloudflareError', () => {
  /** A real Cloudflare error, built through the same conversion production uses. */
  async function cfError(status: number, code: number): Promise<unknown> {
    const snapshot: ProjectCloudflareSnapshot = {
      projectId: PROJECT,
      cloudflareCredentialId: ROW_A,
      credentialRevision: 1,
      accountId: ACCT,
      runner: {
        run: async () =>
          new Response(JSON.stringify({ success: false, errors: [{ code, message: 'x' }] }), { status }),
      },
    };
    return postCloudflareOnce(snapshot, '@cf/cloudflare/clef', {}, new AbortController().signal).then(
      () => {
        throw new Error('expected a Cloudflare error');
      },
      (error: unknown) => error,
    );
  }

  /** What a request captured from credential A before it called Cloudflare. */
  const snapshotA: ProjectCloudflareSnapshot = Object.freeze({
    projectId: PROJECT,
    cloudflareCredentialId: ROW_A,
    credentialRevision: 1,
    accountId: ACCT,
    runner: createExplicitCloudflareRunner(ACCT, TOKEN),
  });

  const CAS_SQL =
    '("project_cloudflare_credentials"."id" = $1 and "project_cloudflare_credentials"."project_id" = $2)';

  it('marks only the snapped row invalid on a 401', async () => {
    const { db, calls } = fakeDb();
    const error = await cfError(401, 10000);
    const result = await normalizeProjectCloudflareError(snapshotA, error);

    expect(db.update).toHaveBeenCalledOnce();
    expect(db.update.mock.calls[0][0]).toBe(schema.projectCloudflareCredentials);
    expect(argsOf(calls, 'set')[0][0]).toEqual({
      health: 'invalid',
      lastCheckedAt: expect.any(Date),
      lastFailureCode: 'cloudflare_authentication_failed',
    });
    expect(rendered(argsOf(calls, 'where')[0][0])).toMatchObject({ sql: CAS_SQL, params: [ROW_A, PROJECT] });
    expect(db.select).not.toHaveBeenCalled();

    expect(result).toBeInstanceOf(ProjectCloudflareUnavailableError);
    const typed = result as ProjectCloudflareUnavailableError;
    expect(typed).toMatchObject({
      reason: 'credential_invalid',
      provider: 'cloudflare',
      cloudflareCredentialId: ROW_A,
    });
    expect(typed.cause).toBe(error);
    expect(typed.gatewayCredentialId).toBeUndefined();
  });

  it('cannot invalidate the row a rotation installed while the call was in flight', async () => {
    // The project already points at B; the normaliser must never ask.
    const { db, calls } = fakeDb([credentialRow({ currentCredentialId: ROW_B, credentialId: ROW_B })]);
    await normalizeProjectCloudflareError(snapshotA, await cfError(401, 10000));

    expect(db.select).not.toHaveBeenCalled();
    expect(rendered(argsOf(calls, 'where')[0][0]).params).toEqual([ROW_A, PROJECT]);
    for (const { method, args } of calls) {
      expect(JSON.stringify([method, serialisable(args)])).not.toContain(ROW_B);
    }
  });

  it('treats 403 with code 10000 as a credential failure', async () => {
    const { db, calls } = fakeDb();
    await expect(normalizeProjectCloudflareError(snapshotA, await cfError(403, 10000))).resolves.toMatchObject({
      reason: 'credential_invalid',
    });
    expect(db.update).toHaveBeenCalledOnce();
    expect(rendered(argsOf(calls, 'where')[0][0])).toMatchObject({ sql: CAS_SQL, params: [ROW_A, PROJECT] });
  });

  it('finds the 401 at the end of a retried call', async () => {
    const { db } = fakeDb();
    const retried = new RetryError({
      message: 'x',
      reason: 'errorNotRetryable',
      errors: [await cfError(503, 0), await cfError(401, 10000)],
    });
    await expect(normalizeProjectCloudflareError(snapshotA, retried)).resolves.toMatchObject({
      reason: 'credential_invalid',
      cloudflareCredentialId: ROW_A,
    });
    expect(db.update).toHaveBeenCalledOnce();
  });

  it.each<[string, () => Promise<unknown>]>([
    ['403/3023', () => cfError(403, 3023)],
    ['429/3036', () => cfError(429, 3036)],
    ['429/3040', () => cfError(429, 3040)],
    ['500', () => cfError(500, 0)],
    ['422/3030', () => cfError(422, 3030)],
    [
      'a dropped connection',
      () =>
        postCloudflareOnce(
          {
            ...snapshotA,
            runner: {
              run: async () => {
                throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
              },
            },
          },
          '@cf/cloudflare/clef',
          {},
          new AbortController().signal,
        ).catch((error: unknown) => error),
    ],
    [
      'a Vercel-shaped 401',
      async () =>
        new APICallError({
          message: 'Unauthorized',
          url: 'https://ai-gateway.vercel.sh/v1/evaluate',
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        }),
    ],
    ['a plain Error', async () => new Error('x')],
  ])('leaves health alone for everything else: %s', async (_label, make) => {
    const { db } = fakeDb();
    const error = await make();
    await expect(normalizeProjectCloudflareError(snapshotA, error)).resolves.toBe(error);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('passes a typed 503 through', async () => {
    const { db } = fakeDb();
    const typed = new ProjectCloudflareUnavailableError(PROJECT, 'credential_missing');
    await expect(normalizeProjectCloudflareError(snapshotA, typed)).resolves.toBe(typed);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('still returns the 503 when the health write fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakeDb([], new Error('db down'));
    await expect(normalizeProjectCloudflareError(snapshotA, await cfError(401, 10000))).resolves.toMatchObject({
      reason: 'credential_invalid',
      provider: 'cloudflare',
      cloudflareCredentialId: ROW_A,
    });

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('[cloudflare] failed to persist project credential health', {
      projectId: PROJECT,
      cloudflareCredentialId: ROW_A,
    });
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(ACCT);
  });

  it('still returns the 503 when the database is unreachable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getDb.mockImplementation(() => {
      throw new Error('DATABASE_URL is not set');
    });
    await expect(normalizeProjectCloudflareError(snapshotA, await cfError(401, 10000))).resolves.toMatchObject({
      reason: 'credential_invalid',
      cloudflareCredentialId: ROW_A,
    });
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
