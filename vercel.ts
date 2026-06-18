import type { VercelConfig } from '@vercel/config/v1';

/**
 * Vercel project configuration.
 *
 * Per-function `maxDuration` / runtime are declared natively in each route
 * handler (`export const maxDuration`, `export const runtime`), which is the
 * reliable mechanism for the Next.js App Router. This file owns project-level
 * concerns: framework detection and Cron schedules.
 *
 * Cron is best-effort (no retries; may be missed or duplicated) so the rollup
 * endpoint is idempotent and guarded by CRON_SECRET + a Redis lock.
 */
export const config: VercelConfig = {
  framework: 'nextjs',
  crons: [
    // Idempotent usage rollups + stale-blob sweep every 15 minutes.
    { path: '/api/cron/rollup', schedule: '*/15 * * * *' },
  ],
};

export default config;
