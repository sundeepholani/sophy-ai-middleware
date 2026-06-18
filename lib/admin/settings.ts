/**
 * Global app settings (singleton row, id='global'). Currently holds the eval
 * judge model and the notification email. Falls back to defaults when unset.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { appSettings } from '@/db/schema';

export interface AppSettings {
  judgeModel: string;
  notifyEmail: string | null;
}

export const DEFAULT_JUDGE_MODEL = 'anthropic/claude-opus-4.8';

export async function getSettings(): Promise<AppSettings> {
  const [row] = await getDb()
    .select({ judgeModel: appSettings.judgeModel, notifyEmail: appSettings.notifyEmail })
    .from(appSettings)
    .where(eq(appSettings.id, 'global'))
    .limit(1);
  return {
    judgeModel: row?.judgeModel ?? DEFAULT_JUDGE_MODEL,
    notifyEmail: row?.notifyEmail ?? null,
  };
}
