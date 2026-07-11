/**
 * A run's own spend: what the eval itself cost (challenger replays + judge
 * calls). Champion cost is real traffic already billed to the key, so it stays
 * out. The sum is written onto eval_runs.eval_cost_usd at every terminal
 * transition (finalize + both cancel paths) BEFORE the sample purge, so the
 * number survives cancellation; the admin queries use the same expression as a
 * live fallback for running runs and for runs frozen before the column existed.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { evalSamples } from '@/db/schema';

type Db = ReturnType<typeof getDb>;
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** SQL for the per-sample spend sum — shared with lib/admin/queries.ts. */
export const evalSpendExpr = () =>
  sql<
    string | null
  >`sum(coalesce(${evalSamples.challengerCostUsd}, 0) + coalesce(${evalSamples.judgeCostUsd}, 0))`;

/**
 * Recorded spend for one run, from its (still present) sample rows. Returns the
 * driver's numeric string (or null when the run has no samples), ready to be
 * assigned to the numeric eval_cost_usd column.
 */
export async function recordedEvalSpendUsd(db: Db | DbTx, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ spend: evalSpendExpr() })
    .from(evalSamples)
    .where(eq(evalSamples.runId, runId));
  return row?.spend ?? null;
}
