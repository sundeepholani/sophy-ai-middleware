/** The CLI uses the console's actions and queries, including their authorization
 * and audit trail. Validate the JSON boundary before calling typed actions. */
import { z } from 'zod';
import * as keys from '@/app/admin/actions';
import * as projects from '@/app/admin/project-actions';
import * as kb from '@/app/admin/kb-actions';
import * as queries from '@/lib/admin/queries';
import * as repository from '@/lib/projects/repository';
import { getSettings } from '@/lib/admin/settings';
import { listAllModels } from '@/lib/gateway/models';
import { requireIdentity, requireProjectViewer, type ProjectViewer } from '@/lib/auth/viewer';

const uuid = z.uuid();
const text = z.string().trim().min(1).max(500);
const empty = z.strictObject({});
const idInput = z.strictObject({ id: uuid });
const member = z.strictObject({ userId: uuid });
const invitation = z.strictObject({ invitationId: uuid });
const role = z.enum(['admin', 'editor']);
const ids = z.array(uuid).min(1).max(500);
const params = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  allowClientPrompt: z.boolean().optional(),
  transcriptProcessorModel: text.optional(),
});
const keyFields = z.strictObject({
  name: text,
  model: text,
  systemPrompt: z.string().max(500_000).nullable(),
  params,
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  monthlyCostCapUsd: z.number().positive().max(99_999_999.9999).nullable().optional(),
  rpmLimit: z.number().int().positive().max(2_147_483_647).nullable(),
  logContent: z.boolean(),
  ownerUserId: uuid.nullable().optional(),
  knowledgebaseId: uuid.nullable().optional(),
});

export class CliError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

type Handler = (input: unknown, projectId?: string) => Promise<unknown>;

function operation<S extends z.ZodType>(
  schema: S,
  run: (input: z.output<S>) => Promise<unknown>,
): Handler {
  return async (input) => run(schema.parse(input));
}

function projectOperation<S extends z.ZodType>(
  schema: S,
  run: (input: z.output<S>, viewer: ProjectViewer) => Promise<unknown>,
  adminOnly = false,
): Handler {
  return async (input, projectId) => {
    const parsed = schema.parse(input);
    if (!projectId) throw new CliError('project_required', 'Select a project with --project or projects use.');
    // This reloads identity, active membership, project status and role. Every
    // mutation additionally uses the same guards as its console action.
    const viewer = await requireProjectViewer(projectId);
    if (adminOnly && viewer.role !== 'admin') throw new Error('forbidden');
    return run(parsed, viewer);
  };
}

function found<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('not_found');
  return value;
}

const operations: Record<string, Handler> = {
  'identity.get': operation(empty, async () => {
    const identity = await requireIdentity();
    return { ...identity, projects: await repository.listProjectsForUser(identity.userId) };
  }),
  'projects.list': operation(empty, async () => repository.listProjectsForUser((await requireIdentity()).userId)),
  'projects.create': operation(z.strictObject({ name: text.max(120) }), projects.createProject),
  'projects.recover': operation(empty, projects.ensureRecoveryProject),
  'projects.default': projectOperation(empty, (_, v) => projects.setDefaultProject({ projectId: v.projectId })),
  'projects.rename': projectOperation(z.strictObject({ name: text.max(120) }), (i, v) => projects.renameProject({ ...i, projectId: v.projectId }), true),
  'gateway.status': projectOperation(empty, (_, v) => repository.getProjectGatewaySummary(v.projectId)),
  'gateway.connect': projectOperation(z.strictObject({ apiKey: z.string().trim().min(1).max(8192) }), (i, v) => projects.connectProjectGateway({ ...i, projectId: v.projectId }), true),
  'gateway.disconnect': projectOperation(empty, (_, v) => projects.disconnectProjectGateway({ projectId: v.projectId }), true),
  'keys.list': projectOperation(empty, (_, v) => queries.listKeys(v)),
  'keys.get': projectOperation(idInput, async (i, v) => found((await queries.listKeys(v)).find((k) => k.id === i.id))),
  'keys.create': projectOperation(keyFields.extend({
    systemPrompt: keyFields.shape.systemPrompt.default(null),
    params: params.default({}),
    outputSchema: keyFields.shape.outputSchema.default(null),
    rpmLimit: keyFields.shape.rpmLimit.default(null),
    logContent: z.boolean().default(false),
  }), (i, v) => keys.createKey({ ...i, projectId: v.projectId })),
  'keys.update': projectOperation(keyFields.partial().extend({ id: uuid, stopRunningEval: z.boolean().optional() }), async (i, v) => {
    // Partial CLI edits preserve all omitted configuration, especially budgets.
    // listKeys is owner-scoped and never returns stored secret hashes.
    const current = found((await queries.listKeys(v)).find((k) => k.id === i.id));
    return keys.updateKey({ ...current, ...i, projectId: v.projectId });
  }),
  'keys.rotate': projectOperation(idInput, (i, v) => keys.rotateKey({ ...i, projectId: v.projectId })),
  'keys.revoke': projectOperation(idInput, (i, v) => keys.revokeKey({ ...i, projectId: v.projectId })),
  'keys.bulk-model': projectOperation(z.strictObject({ ids, model: text, stopEvalIds: ids.optional() }), (i, v) => keys.bulkUpdateKeyModel({ ...i, projectId: v.projectId })),
  'evals.list': projectOperation(empty, (_, v) => queries.listEvalRuns(v)),
  'evals.get': projectOperation(z.strictObject({ runId: uuid }), async (i, v) => found(await queries.getEvalRunDetail(v, i.runId))),
  'evals.start': projectOperation(z.strictObject({ apiKeyId: uuid, challengerModel: text, targetN: z.number().int().min(1).max(1000).default(100) }), (i, v) => keys.startEvalRun({ ...i, projectId: v.projectId })),
  'evals.bulk-start': projectOperation(z.strictObject({ ids, challengerModel: text, targetN: z.number().int().min(1).max(1000).default(100), stopEvalIds: ids.optional() }), (i, v) => keys.bulkStartEvalRuns({ ...i, projectId: v.projectId })),
  'evals.cancel': projectOperation(z.strictObject({ runId: uuid }), (i, v) => keys.cancelEvalRun({ ...i, projectId: v.projectId })),
  'evals.refresh': projectOperation(z.strictObject({ apiKeyId: uuid }), (i, v) => keys.refreshKeyEval({ ...i, projectId: v.projectId })),
  'overview.get': projectOperation(empty, (_, v) => queries.getOverview(v)),
  'models.list': projectOperation(empty, () => listAllModels()),
  'usage.get': projectOperation(z.strictObject({ sinceDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30), keyId: uuid.optional(), model: text.optional() }), async (i, v) => {
    const [totals, byKey, byModel, bySource, series, stackedModel, stackedKey] = await Promise.all([
      queries.getUsageTotals(v, i), queries.getUsageByKey(v, i), queries.getUsageByModel(v, i),
      queries.getUsageBySource(v, i), queries.getUsageSeries(v, i),
      queries.getUsageStacked(v, i, 'model'), queries.getUsageStacked(v, i, 'key'),
    ]);
    return { totals, byKey, byModel, bySource, series, stackedModel, stackedKey };
  }),
  'logs.list': projectOperation(z.strictObject({ limit: z.number().int().min(1).max(100).default(100), source: z.enum(['proxy', 'processor', 'challenger', 'judge', 'kb']).optional() }), (i, v) => queries.getRecentLogs(v, i.limit, i.source)),
  'logs.get': projectOperation(idInput, async (i, v) => found(await queries.getLogDetail(v, i.id))),
  'knowledgebases.list': projectOperation(empty, (_, v) => queries.listKnowledgebases(v)),
  'knowledgebases.options': projectOperation(empty, (_, v) => queries.listKnowledgebaseOptions(v)),
  'knowledgebases.create': projectOperation(z.strictObject({ name: text.max(200) }), (i, v) => kb.createKnowledgebase({ ...i, projectId: v.projectId })),
  'knowledgebases.delete': projectOperation(idInput, (i, v) => kb.deleteKnowledgebase({ ...i, projectId: v.projectId })),
  'knowledgebases.documents': projectOperation(z.strictObject({ kbId: uuid }), (i, v) => kb.listKbDocumentsAction({ ...i, projectId: v.projectId })),
  'knowledgebases.document-delete': projectOperation(idInput, (i, v) => kb.deleteKbDocument({ ...i, projectId: v.projectId })),
  'knowledgebases.document-retry': projectOperation(idInput, (i, v) => kb.retryKbDocument({ ...i, projectId: v.projectId })),
  'members.list': projectOperation(empty, (_, v) => repository.listProjectMembers(v), true),
  'members.invite': projectOperation(z.strictObject({ email: z.email().max(254), role }), (i, v) => projects.inviteProjectMember({ ...i, projectId: v.projectId }), true),
  'members.role': projectOperation(member.extend({ role }), (i, v) => projects.changeProjectMemberRole({ ...i, projectId: v.projectId }), true),
  'members.status': projectOperation(member.extend({ active: z.boolean() }), (i, v) => projects.changeProjectMemberStatus({ ...i, projectId: v.projectId }), true),
  'members.remove': projectOperation(member, (i, v) => projects.removeProjectMember({ ...i, projectId: v.projectId }), true),
  'invitations.list': projectOperation(empty, (_, v) => repository.listProjectInvitations(v), true),
  'invitations.role': projectOperation(invitation.extend({ role }), (i, v) => projects.changeProjectInvitationRole({ ...i, projectId: v.projectId }), true),
  'invitations.resend': projectOperation(invitation, (i, v) => projects.resendProjectInvitation({ ...i, projectId: v.projectId }), true),
  'invitations.revoke': projectOperation(invitation, (i, v) => projects.revokeProjectInvitation({ ...i, projectId: v.projectId }), true),
  'settings.get': projectOperation(empty, (_, v) => getSettings(v), true),
  'settings.update': projectOperation(z.strictObject({ judgeModel: text, notifyEmail: z.email().max(254).nullable() }), (i, v) => keys.updateSettings({ ...i, projectId: v.projectId }), true),
};

export const cliOperationNames = [...Object.keys(operations), 'knowledgebases.upload'];

const envelope = z.strictObject({ operation: z.string().min(1).max(80), projectId: uuid.optional(), input: z.unknown().optional() });

export async function dispatchCliOperation(body: unknown): Promise<unknown> {
  const { operation, projectId, input } = envelope.parse(body);
  if (!Object.hasOwn(operations, operation)) throw new CliError('unknown_operation', 'Unknown CLI operation.');
  return operations[operation](input ?? {}, projectId);
}

/** Multipart uploads still use the existing owner and file-type checks. */
export async function dispatchCliUpload(form: FormData): Promise<unknown> {
  const fields = [...form.keys()];
  if (new Set(fields).size !== fields.length || fields.some((k) => !['operation', 'projectId', 'kbId', 'file'].includes(k))) {
    throw new CliError('invalid_request', 'Unexpected or duplicate upload fields.');
  }
  z.strictObject({ operation: z.literal('knowledgebases.upload'), projectId: uuid, kbId: uuid }).parse({
    operation: form.get('operation'), projectId: form.get('projectId'), kbId: form.get('kbId'),
  });
  return kb.uploadKbDocumentAction(form);
}
