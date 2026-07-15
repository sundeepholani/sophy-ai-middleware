/**
 * Project-local eval settings. Falls back to defaults only when the project row
 * has not yet been provisioned; authorization is resolved before this query.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { projectSettings } from '@/db/schema';
import type { ProjectViewer } from '@/lib/auth/viewer';

export interface AppSettings {
  judgeModel: string;
  notifyEmail: string | null;
}

export const DEFAULT_JUDGE_MODEL = 'anthropic/claude-opus-4.8';

export async function getSettings(viewer: ProjectViewer): Promise<AppSettings> {
  const [row] = await getDb()
    .select({
      judgeModel: projectSettings.judgeModel,
      notifyEmail: projectSettings.notifyEmail,
    })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, viewer.projectId))
    .limit(1);
  return {
    judgeModel: row?.judgeModel ?? DEFAULT_JUDGE_MODEL,
    notifyEmail: row?.notifyEmail ?? null,
  };
}
