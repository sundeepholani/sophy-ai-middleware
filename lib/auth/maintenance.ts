/** Remove obsolete authentication records without disturbing resend/attempt limits. */
import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { cliSessions, loginChallenges } from '@/db/schema';

const RETENTION_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 500;

/** At most 500 rows per table per run; overlapping sweeps skip locked records. */
export async function purgeExpiredAuthentication(): Promise<{ challenges: number; sessions: number }> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const db = getDb();
  // Issuance looks back one hour. Keeping 24 hours protects that history even
  // after a code is used or invalidated by a resend.
  const challenges = await db.execute(sql`
    delete from ${loginChallenges}
    where ${loginChallenges.id} in (
      select ${loginChallenges.id} from ${loginChallenges}
      where ${loginChallenges.createdAt} < ${cutoff}
      order by ${loginChallenges.createdAt}
      limit ${BATCH_SIZE} for update skip locked
    )
    returning ${loginChallenges.id}
  `);
  // An old but unexpired session remains usable. Revoked/expired credentials
  // are retained for 24 hours after their termination and cannot authenticate.
  const sessions = await db.execute(sql`
    delete from ${cliSessions}
    where ${cliSessions.id} in (
      select ${cliSessions.id} from ${cliSessions}
      where ${cliSessions.expiresAt} < ${cutoff} or ${cliSessions.revokedAt} < ${cutoff}
      limit ${BATCH_SIZE} for update skip locked
    )
    returning ${cliSessions.id}
  `);
  return { challenges: challenges.rowCount ?? 0, sessions: sessions.rowCount ?? 0 };
}
