/** Vercel supplies x-real-ip; other trusted proxies append the final forwarded hop. */
export function authClientIp(req: Request): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) ?? 'unknown';
}

/** JSON-only auth submissions cannot be posted by cross-site HTML forms. */
export function isAuthJsonRequest(req: Request): boolean {
  return req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json'
    && req.headers.get('sec-fetch-site') !== 'cross-site';
}

/** Bound bytes read, including chunked bodies that have no Content-Length. */
export async function readAuthJson(req: Request): Promise<unknown> {
  const limit = 4096;
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > limit || !req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch { return null; }
  finally { reader.releaseLock(); }
}
