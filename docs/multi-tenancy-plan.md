# Sophy multi-tenancy implementation

Status: implemented in this change after prototype approval on 2026-07-15. The
application, migration, console, API isolation, onboarding, and public docs now
match the project experience below. Production rollout still requires the
coordinated migration procedure and operational checks in sections 10 and 12.

## 1. Goal

Turn Sophy from one shared enterprise console into a project-based multi-tenant product where:

- One email address represents one Sophy identity.
- A person can belong to multiple projects.
- Their role is assigned independently in each project.
- Every Sophy API key and every related resource belongs to exactly one project.
- Every AI-enabled project must connect one Admin-managed, project-owned Vercel AI Gateway credential for all AI work and upstream usage.
- A person can choose which accessible project Sophy opens after sign-in.
- A person who signs up independently receives a renameable project named `My Project`, becomes its Admin, and lands there by default.
- A person whose first entry is an invitation joins the invited project with the invited role and uses that project as their default.

## 2. Implemented product decisions

These decisions define the shipped UX:

1. **Project is the tenant boundary.** “Enterprise,” “account,” and the current global admin scope are replaced by a project context in the console.
2. **Identity is global; access is local.** The same normalized email can be an Admin in one project and an Editor in another.
3. **Roles remain Admin and Editor for the first release.** This preserves Sophy’s current permission model. A read-only role can be added later without blocking the migration.
4. **Current project and default project are different.** Switching projects changes the current context only. Setting a default is a separate, explicit action.
5. **Invitation-first onboarding does not create an extra `My Project`.** The invited project becomes default. If the project-creation and billing policy permits it, the person can create their own project later and will be its Admin.
6. **An invitation to an existing user never changes their default.** It adds access and opens the newly joined project for that visit.
7. **Project names are renameable and need not be globally unique.** URLs and relationships use an immutable project ID or stable slug.
8. **Key ownership remains useful but is not the tenant boundary.** A project owns the key; an active member of the same project may be assigned as its operational owner.
9. **The two key types stay distinct.** A _Gateway credential_ is the project-level upstream Vercel secret. A _Sophy API key_ is the client-facing bearer key issued inside Sophy.
10. **Each project has at most one current healthy Gateway credential.** Any Project Admin can add or safely replace it; it remains owned by the project if that Admin later leaves.
11. **Gateway setup is a readiness gate.** Members, invitations, rename, and switching work before setup, but Sophy API-key creation and every AI operation stay blocked until the project credential is active.
12. **Tenant AI traffic never falls back.** Live proxy calls, embeddings, images, KB work, evaluations, and structured-output retries must use the current project credential, never Sophy deployment OIDC, a global `AI_GATEWAY_API_KEY`, or another project’s credential.
13. **A Vercel Gateway key is dedicated to one Sophy project.** Sophy rejects a matching active HMAC fingerprint in another project so Vercel-side usage and budgets remain attributable to one tenant. The fingerprint HMAC key is immutable after first use unless every active credential is re-fingerprinted in one coordinated rotation.

## 3. User journeys

### Independent first-time signup

1. The person enters their email on “Sign in or create an account.”
2. Sophy sends a one-time verification link without revealing whether the email already exists.
3. After verification, one transaction creates:
   - the user;
   - `My Project`;
   - an Admin membership;
   - the user’s default-project preference.
4. Sophy opens the new project’s Overview with a “Connect Vercel AI Gateway” action.
5. After the Admin connects and Sophy verifies the project credential, Sophy unlocks “Create your first Sophy API key.”

### Invitation-first signup

1. A Project Admin invites an email and assigns Admin or Editor.
2. The recipient opens the invitation and sees the project, inviter, and role before accepting.
3. After email verification and explicit acceptance, one transaction creates the user if needed and adds the membership.
4. If this is the user’s first accepted access, the invited project becomes default.
5. Sophy opens the invited project. No additional personal project is created.
6. If the invited project is not Gateway-ready, an invited Admin sees “Connect Vercel AI Gateway”; an invited Editor sees “Waiting for a Project Admin.” Neither can create a Sophy API key or run AI work until setup completes.

### Existing user accepts an invitation

1. Sophy matches the normalized email to the existing identity.
2. Acceptance adds one membership or reports that access already exists.
3. The existing default remains unchanged.
4. Sophy opens the newly joined project for the current visit.

### Switch and set a default project

1. The project switcher lists only active memberships and shows the role in each project.
2. Choosing a row changes the URL and current data scope.
3. Choosing “Make default” changes the user’s personal preference, not anyone else’s.
4. The next fresh sign-in opens that project.

### Rename `My Project`

1. A Project Admin opens Project settings.
2. They change the display name and save.
3. The header, switcher, invitation copy, and future audit events use the new name.
4. The immutable project identifier and all keys remain unchanged.

### Invite and manage members

1. A Project Admin opens Members and invites an email with a role.
2. Pending invitations show role, inviter, expiry, resend, change-role, and revoke actions.
3. Active members show their project role and key count.
4. Sophy prevents removal or demotion of the last active Project Admin.
5. Removing project access does not deactivate the person’s global Sophy identity.

### Connect or rotate a project Gateway credential

1. A new project starts in the derived `setup_required` readiness state; its lifecycle status remains `active`, but it has no current usable credential and incurs no model spend.
2. A Project Admin opens Overview or Project settings and chooses “Connect Vercel AI Gateway.”
3. Sophy submits the candidate directly to a server action, validates it with an authentication-sensitive, non-generation request, and never persists it in browser storage or places it in logs, analytics, or audit text. The browser necessarily holds the Admin-entered form value until submission.
4. A valid candidate is envelope-encrypted at rest. The UI returns only status, last four characters, and verification time.
5. An invalid first candidate leaves the project in `setup_required`. An invalid replacement leaves the previous current healthy credential untouched.
6. A successful rotation atomically switches future work while requests already in flight may finish with the immutable credential row they captured at start.
7. Existing Sophy API keys, memberships, KBs, and evaluation definitions remain unchanged.
8. Disconnecting pauses all AI work but does not delete or revoke Sophy API keys. It also does not revoke the Vercel key; an Admin must do that in Vercel.

### Create a project-scoped Sophy API key

1. The project must have a current healthy Gateway credential.
2. The create dialog states “Creating in {project name}.”
3. Owner choices and knowledgebases come only from the current project.
4. Editors become the owner of keys they create; Admins can assign any active project member.
5. The existing show-once secret, model policy, quotas, logging, Agent mode, structured output, rotation, revocation, and eval behavior remain intact.

## 4. Permission model

| Capability | Admin | Editor |
| --- | ---: | ---: |
| Open and switch to an accessible project | Yes | Yes |
| Set their own default project | Yes | Yes |
| Rename or configure the project | Yes | No |
| Invite, remove, or change member roles | Yes | No |
| View Gateway connection health | Yes | Yes |
| Add, test, replace, or disconnect the Gateway credential | Yes | No |
| Create Sophy API keys once the Gateway is active | Yes | Yes |
| Manage every project key | Yes | No |
| Manage keys they own | Yes | Yes |
| Reassign key ownership or budgets | Yes | No |
| View all project usage, logs, and evals | Yes | No |
| View telemetry for their keys | Yes | Yes |
| Manage project knowledgebases | Yes | No |
| Attach a project knowledgebase to an owned key | Yes | Yes |

Platform operations, support tooling, and model-catalog administration should use a separate platform role rather than overloading Project Admin.

## 5. Target data model

### `users`

Keep the user as the global authentication identity.

- `id`
- `email` — globally unique and normalized, enforced by `citext`, a unique `lower(email)` index, or an equivalent database constraint
- `status` — global login status
- `default_project_id` — nullable during migration, otherwise an active membership
- `onboarded_at` — distinguishes a pre-created/invited identity from completed onboarding
- `last_login_at`
- timestamps

Remove global `users.role` after the project-aware authorization rollout is complete.

### `projects`

- `id`
- `name`
- `slug` or other stable URL key — unique and not derived again when renamed
- `created_by_user_id` — nullable only for a system-created migrated project, otherwise required
- `status` — `active | suspended | archived`
- `current_gateway_credential_id` — nullable; a same-project reference used for atomic replacement. Null means no current credential.
- `gateway_credential_revision` — increments on each compare-and-set replacement or disconnect
- `created_at`
- `updated_at`
- lifecycle timestamps such as `suspended_at` and `archived_at`

### `project_memberships`

- `project_id`
- `user_id`
- `role` — `admin | editor`
- `status` — `active | suspended`
- `joined_at`
- `last_accessed_at` — updated when the user deliberately opens the project and used only for fallback selection
- timestamps

Use a composite primary key or unique index on `(project_id, user_id)`.

### `project_invitations`

- `id`
- `project_id`
- `email` — normalized
- `role`
- `invited_by_user_id`
- `token_hash` — store no raw invite token
- `expires_at`
- `accepted_at`
- `accepted_by_user_id`
- `revoked_at`
- timestamps

Allow at most one live invitation per `(project_id, email)`. An invitation must not create a membership until the recipient verifies and accepts it.

### `project_settings`

Replace the singleton `app_settings` row with one row per project:

- `project_id`
- `judge_model`
- `notify_email`
- future project-level policy and billing fields

### `project_gateway_credentials`

Keep retrievable secrets out of `project_settings`. Store versioned project credentials in a dedicated server-only table:

- `id`
- `project_id`
- `source` — `encrypted_api_key | platform_env`; `platform_env` is migration-only and cannot be chosen by a Project Admin
- `lifecycle` — `available | replaced | disconnected`; each row represents one secret version, and its secret material/fingerprint never changes after validation
- `health` — `unchecked | healthy | invalid | billing_attention`; health does not rewrite credential history
- `encrypted_secret`, nonce, authentication tag, and other AEAD metadata — nullable only for the migration-only `platform_env` source
- `encryption_key_version`
- `secret_fingerprint` — keyed HMAC for duplicate detection, never a plain hash
- `secret_last_four`
- `verified_at`, `last_checked_at`, and `last_used_at`
- `last_failure_code` — sanitized classification only, never a raw upstream response
- `created_by_user_id`
- `replaced_at`, `disconnected_at`, and timestamps

Each immutable credential row ID is its non-secret version identifier; `usage_events.gateway_credential_id` needs no second credential-version column. Enforce `projects.current_gateway_credential_id` with a composite same-project foreign key. Historical rows remain for non-secret audit context, while exactly one nullable pointer identifies the current row even when its health is `invalid` or `billing_attention`. Use a partial unique index for at most one `available` row per project and a global unique index on `available` secret fingerprints so one Vercel key cannot serve two Sophy projects.

For `encrypted_api_key`, require ciphertext/AEAD fields and a non-null creating Admin. For `platform_env`, require those encryption fields and `created_by_user_id` to be null. The resolver may select `platform_env` only when both the source and the one configured migrated-project ID match; it is never a generic fallback branch.

Encrypt with envelope encryption backed by KMS, or AES-256-GCM with a separate versioned production encryption key. Bind the project ID, credential ID, credential type, and key version as authenticated associated data. Do not reuse `KEY_HASH_PEPPER`, `SESSION_PASSWORD`, or an application signing secret. Never return ciphertext or plaintext after save. Safely erase replaced ciphertext while retaining non-secret audit history.

### `auth_intents`

The current `login_tokens.user_id` is required, so it cannot represent a verified self-signup before a user exists. Add a separate email-bound intent table, or evolve the token schema equivalently:

- `id`
- `email` — normalized
- `purpose` — `login | signup`
- optional `user_id` for existing identities
- `token_hash`
- `expires_at`
- `consumed_at`
- timestamps

The raw token exists only in the emailed link. Consumption decides transactionally whether to log in an existing identity or provision a new one.

### Tenant ownership on existing records

Add mandatory `project_id` to every tenant-owned or job-facing table:

- `api_keys`
- `knowledgebases`
- `usage_events`, including keyless KB spend and the immutable non-secret Gateway credential row ID for each successful upstream call after cutover; null is allowed for work blocked before an upstream call and for historical rows that cannot be attributed safely
- `usage_rollups`
- `request_logs`
- `blob_uploads`
- `eval_runs`
- `eval_samples`
- `kb_documents`
- `kb_chunks`
- `audit_log`

Use composite same-project foreign keys or equivalent constraints so a child cannot reference a parent from another project. This is deliberate denormalization: several background jobs and retention queries address child tables directly, and the current schema has no foreign keys to guarantee parent integrity.

The gateway model catalog, login throttles, and infrastructure locks can remain platform-global. Fetch the public catalog without deployment authorization. Any future credential-specific availability/config cache must instead be keyed by the immutable credential row ID and must never cross projects.

## 6. Routing and session model

Use explicit project context in the URL:

```text
/admin                                      -> redirect to default project
/admin/p/[projectId]                        -> Overview
/admin/p/[projectId]/keys
/admin/p/[projectId]/models
/admin/p/[projectId]/usage
/admin/p/[projectId]/evals
/admin/p/[projectId]/logs
/admin/p/[projectId]/knowledgebases
/admin/p/[projectId]/members
/admin/p/[projectId]/settings
/admin/invitations/accept?token=...
/admin/no-projects                         -> explicit access-recovery screen
```

The signed session should establish the user identity only. It must not be the authoritative source for a project role. Every request resolves an active membership for the project in the URL. During rollout, `session-config.isAuthenticated()` and `currentUser()` need a compatibility window for old role-bearing cookies before the role field is removed. The invitation landing path must be added to the proxy’s public allowlist while acceptance remains an explicit POST.

Path-based context prevents a project switch in one tab from silently changing the tenant shown in another tab. `/admin` reads the persisted default and redirects. A switcher navigation changes the path; it does not mutate the default.

## 7. Authorization design

Replace the current global `Viewer` with two layers:

- `IdentityViewer`: active authenticated user.
- `ProjectViewer`: identity plus `projectId`, membership role, and membership status.

Required guards:

- `requireIdentity()`
- `requireProjectViewer(projectId)`
- `assertProjectAdmin(projectId)`
- `assertCanManageProjectKey(projectId, keyId)`
- `assertCanManageProjectRun(projectId, runId)`

Every read and mutation must apply checks in this order:

1. The selected project membership is active.
2. The resource belongs to the selected project.
3. The membership role permits the operation.
4. Editor-only ownership rules are satisfied when relevant.

A Project Admin must never translate to an unfiltered database query. A resource ID from another project should behave as not found, avoiding both data leakage and project-existence disclosure.

Owner assignment and knowledgebase attachment must validate that the referenced rows belong to the current project. Background work, cron jobs, and analytics queries must carry an explicit project context too.

Public Gateway authentication derives the project from the Sophy API key itself, never from console state. `VerifiedKey`, Gateway call contexts, `recordUsage`, eval capture/processing, file validation, and KB ingestion/retrieval must propagate that project ID. `verifyKey()` must also reject a key whose project is suspended or archived, even when the key itself remains active.

Keep Sophy key authentication and Gateway readiness as separate typed outcomes. `VerifiedKey` identifies a valid Sophy key and its project, never a Gateway credential. Only after authentication succeeds does a server-only resolver load the project’s current healthy credential, verify that the project is active, decrypt with authenticated project-bound metadata, and create an explicit `createGateway({ apiKey })` provider. A valid Sophy key plus unavailable Gateway returns `503 project_gateway_unavailable`, not `401 invalid_api_key`.

Live Chat Completions, Responses, embeddings, images, structured-output retries, KB ingest/query embeddings, and eval challenger/judge calls must use the provider resolved for that project. KB retrieval may degrade to no context for a transient embedding failure, but credential resolution, decryption, authentication, and billing failures are fatal and must propagate instead of being swallowed by a broad catch.

Remove module-level singleton providers and plain model-string call paths that can implicitly read deployment OIDC or `AI_GATEWAY_API_KEY`. If resolved providers are cached, use a bounded TTL/LRU keyed by immutable credential row ID, invalidate it on rotation, and never key it by a raw secret. A request instantiates and snapshots one provider before its upstream work starts, so retries and in-flight work cannot switch billing identity midway through an operation.

Credential failure updates use compare-and-set semantics against the captured immutable row ID and current project pointer. A late `401` or billing failure from an old in-flight provider may annotate only that old row and must never invalidate its replacement. Replaced ciphertext may be erased once no new request can resolve it; in-flight requests already hold their provider snapshot in memory.

Fail closed:

- Missing, inactive, undecryptable, or project-mismatched credentials make no upstream call and return an OpenAI-shaped generic `503` such as `project_gateway_unavailable`.
- Gateway authentication failures remain opaque to API clients, mark that credential invalid asynchronously, and block later work until an Admin replaces it.
- Exhausted credits or a Gateway-key budget become `billing_attention`; they never trigger fallback spend through Sophy or another project.
- Network errors, rate limits, and upstream `5xx` responses do not automatically invalidate a credential.
- Gateway account IDs, balances, secret identifiers, top-up links, and raw upstream bodies never appear in client errors.
- Background jobs enter a retryable `blocked_gateway_credential` or `billing_attention` state instead of failing permanently or consuming every cron slot.

Managed Sophy Blob URLs must fail closed when no matching project-owned `blob_uploads` row exists. KB source blobs need an explicit allowed path instead of relying on the current “unknown URL is acceptable” behavior.

## 8. Authentication and invitation lifecycle

### Self-signup

The login route now supports both existing identities and verified self-signup without weakening account-enumeration protections:

1. Always return the same public response.
2. Create an email-bound `auth_intent`, but no user/project, until the link is verified.
3. On token consumption, transactionally insert the normalized identity or lock the existing one.
4. If the identity is not onboarded and the token is a self-signup intent, create `My Project`, Admin membership, and default.
5. If another transaction already completed onboarding, treat the link as an ordinary login.

### Invitation acceptance

1. Invitation tokens are separate from ordinary login tokens.
2. The invitation binds project, normalized email, role, inviter, and expiry on the server.
3. A signed-in user with a different email must switch identity before accepting.
4. Acceptance is explicit and single-use.
5. In one transaction, lock or insert the user, insert the membership only when absent, mark the invitation accepted, and set `default_project_id` only if onboarding/default has not already been established. A stale invite must never overwrite an existing membership’s role; role changes use the explicit member-management action.

### Race handling

- The first successfully accepted invitation for a new identity establishes the default.
- Later invitations add memberships but do not overwrite it.
- If independent signup completes first, `My Project` remains default.
- Unique email, membership, and live-invitation indexes make retries idempotent.
- Concurrent accepts must not create duplicate users, projects, or memberships.

## 9. Default-project integrity

- A user can set only a project where they have an active membership.
- Switching projects never changes the default implicitly.
- Membership removal or suspension updates an affected default atomically in the same transaction.
- If the default membership is removed, choose the active membership with the newest `last_accessed_at` and persist it.
- If no active membership remains and the user is eligible to create a project, an explicit recovery transaction creates `My Project`, adds the user as Admin, and makes it default. Do not create a potentially billable project as a side effect of a read or redirect.
- If project creation is not permitted, land on a non-billable recovery screen that explains how to regain access; never leave the console in a broken redirect loop.
- A project cannot be archived or its final Admin removed until a valid replacement is established.
- Last-Admin removal/demotion is protected by a per-project transaction or advisory lock so concurrent changes cannot both pass the floor check.

## 10. Migration of the current enterprise

Migration `0010_yielding_fabian_cortez.sql` performs the schema expansion,
legacy-tenant data move, backfill, and final constraints as one coordinated
cutover. It is not rolling-compatible with the old application: quiesce old
writers, take a verified backup, apply the migration, deploy this project-aware
build, and run the row-count/relationship checks before reopening traffic. A
zero-downtime rollout must first split this into separate expand, dual-write,
and contract releases.

1. Provision the credential-encryption/KMS key in every production runtime before any secret-storage migration.
2. Add project, membership, invitation, auth-intent, project-settings, and project-gateway-credential tables.
3. Add nullable project columns, `usage_events.gateway_credential_id`, and supporting indexes to every tenant-owned table.
4. Create one system-owned project representing the existing single-tenant installation. It gets a stable name and slug, and `created_by_user_id` is null for this migrated row.
5. Install a temporary database default/trigger or use a maintenance window so old application instances cannot create projectless rows while the rollout is mixed-version.
6. Convert every existing user into a membership, mapping the current global Admin/Editor role exactly. Mark each existing user onboarded and set their default to the migrated project.
7. Assign every existing key, KB, usage event, rollup, request log, blob, eval, KB child record, setting, and audit record to the migrated project.
8. Clean or quarantine pre-existing orphans before constraints, including logs, rollups, KB documents/chunks, eval samples, and usage rows. Account for the current KB ingest/delete race that can leave dead chunks.
9. Seed project settings, backfill `eval_runs.project_id`, and deploy project-aware eval start/finalization before retiring the global notification setting so in-flight runs still finish correctly.
10. Create a non-secret, migration-only `platform_env` credential identity scoped only to the migrated enterprise project. Do not copy the deployment `AI_GATEWAY_API_KEY` into the database and never allow new projects to select this source. Attribute historical successful usage to that identity only where deployment evidence supports it; leave unverifiable historical rows null.
11. Deploy the explicit project-provider resolver across live proxy, Responses, embeddings, images, KB ingest/retrieval, eval challenger/judge, structured retry, usage/error handling, model catalog/config, and cron paths. Audit the easy-to-miss modules such as `lib/gateway/upstream-error.ts`, `lib/kb/retrieve.ts`, and `lib/gateway/models.ts`. Plain model-string calls must no longer be able to select a global secret implicitly.
12. Test two projects with distinct fake credentials across every call path, including retries and background jobs, and assert that each path uses only the expected project credential. Repeat with both OIDC and a deliberately wrong global `AI_GATEWAY_API_KEY` present to prove explicit providers prevent SDK fallback.
13. Have an existing enterprise Admin add and validate a dedicated project-owned Gateway key. Atomically switch the migrated project, then remove its time-limited `platform_env` fallback.
14. Verify row counts, same-project relationships, orphan checks, normalized-email uniqueness, credential-version attribution, and existing Sophy API-key authentication.
15. Remove the temporary legacy-write bridge only after every tenant writer supplies `project_id` and every successful AI-usage writer supplies `gateway_credential_id`.
16. Make tenant columns non-null and add final uniqueness/composite foreign-key constraints.
17. Remove global role reads, expire the compatibility window for old cookies, and then retire `users.role`, the singleton setting shape, and the tenant-call use of global Gateway auth.

Existing Sophy API key values, prefixes, hashes, and client integrations must remain unchanged throughout the migration. The legacy credential bridge exists only to avoid an outage for the migrated project; every project must have an Admin-supplied credential before the multi-tenant cutover is complete.

Rollback to global Gateway authentication is forbidden once a second tenant is active. After that point, rollback may disable new signup/project creation or restore a prior project-aware build, but it must preserve per-project credential routing and isolation.

## 11. Delivery phases

### Phase A — Foundation (complete)

- Schema, migration, project repository layer, identity/project viewer, and isolation tests.
- Encrypted project Gateway credentials, explicit project-provider resolution across every live and background call path, typed Gateway-readiness errors, and a migrated-enterprise-only legacy bridge.
- Backfill the current enterprise into one project.
- Preserve the existing UI behind project-aware routes.

### Phase B — Memberships and navigation (complete)

- Project switcher and URL context.
- Project-scoped navigation, settings, members, default preference, rename, and Admin-only Gateway connection UX.
- Refactor all console queries and actions to require project scope.

### Phase C — Onboarding and invitations (complete)

- Safe open signup.
- New-project `setup_required` flow: connect Gateway, then create a Sophy API key.
- Pending invitation model, acceptance route, resend/revoke/change-role actions.
- Invitation-first and existing-user flows.
- Race, expiry, identity-mismatch, and last-Admin coverage.
- Signup, new-project creation, and new Sophy-key issuance are enabled because the tenant-complete call paths in Phase D are project-bound and Gateway-gated.

### Phase D — Tenant-complete operations (complete for the product paths in this repository)

- Project-scoped settings, KB ingestion, eval processing, usage accounting, logs, files, retention, rollups, notifications, and audit trails.
- Verify credential-aware live calls and background jobs have no deployment-auth fallback in the completed tenant-scoped workflows.
- Fair background scheduling and per-project quotas so one project cannot monopolize the global KB-ingest or eval-processing batches.
- Platform-wide support tooling remains a separate future surface and must use an explicit platform role.

### Phase E — Operational hardening and launch (deployment work)

- Cross-project negative tests for every read and mutation.
- Load/performance tests for scoped indexes.
- Abuse, spend-cap, billing, and signup controls.
- Migration rehearsal, observability, rollback plan, and staged release.
- Remove the migrated project’s legacy Gateway bridge after its Admin-managed credential is active.
- Keep the landing page, public API docs (including the new `503` behavior), README, `.env.example`, and Gateway-auth comments aligned with future behavior changes; they are updated in this implementation.

## 12. Security and commercial prerequisites

New projects incur no model spend until a Project Admin connects a project-owned Gateway credential. Login requests already have IP and per-email throttles, and project AI work remains bounded by its Sophy-key limits and dedicated Vercel Gateway key. Open signup can still consume Sophy database, Blob, email, and compute resources, so the production operator must define:

- who may create a project and key;
- email/domain verification or allowlisting;
- how the dedicated Vercel Gateway key’s project budget is set;
- any independent Sophy per-key or per-project quota;
- payment or approval requirements;
- rate, project-creation, and invitation abuse limits;
- project suspension and incident-response controls.

Project suspension is enforced on both console access and public API-key verification. A suspended project cannot continue spending through an otherwise active key.

Gateway validation and secret management enforce Project-Admin authorization, use the authenticated non-generation `getCredits` check, and write only the actor, project, HMAC fingerprint, last four, and lifecycle classification to the audit trail. A failed replacement never displaces the current healthy credential. A recent-authentication challenge and a dedicated Gateway-validation attempt limiter are launch hardening items if the deployment's session and abuse policy require them.

Tenant isolation tests are release blockers. Include cross-project IDs for keys, owners, KBs, logs, evals, usage, files, settings, invitations, and audit records, and assert that no response exposes another project’s data.

## 13. Acceptance criteria

- The same email can be Admin in one project and Editor in another.
- Inviting an existing email adds a membership and never creates a duplicate user.
- Self-signup creates exactly one `My Project`, Admin membership, and default.
- Invitation-first signup makes the invited project default without creating `My Project`.
- Later invitations never change an existing user’s default.
- Switching projects does not change the default.
- A user can set any active membership as default.
- Renaming a project changes no IDs, URLs, keys, memberships, or defaults.
- Every Sophy key, Gateway credential, owner choice, KB attachment, usage record, log, eval, file, setting, and audit event is tenant-safe.
- Editors can manage only their own keys and related telemetry; Admins can manage all resources only inside the current project.
- A new project derives `setup_required` from the absence of a current healthy credential and cannot create a Sophy API key or run AI work until a Project Admin connects one.
- Editors can see generic Gateway health but cannot add, replace, disconnect, decrypt, retrieve, or view Admin-only credential metadata.
- Two projects with distinct Gateway credentials route Chat Completions, Responses, embeddings, images, KB work, eval work, and structured retries only through the correct project credential.
- Except for the explicitly scoped migrated-enterprise bridge, no tenant AI call succeeds through deployment OIDC, global `AI_GATEWAY_API_KEY`, or another project’s credential. Before multi-tenant launch, no active `platform_env` credential remains and no new project has ever used it.
- No candidate credential becomes current and healthy until the pinned authentication-sensitive, non-generation validation check is implemented and passes; an invalid first candidate leaves readiness at `setup_required`.
- Rotating a Gateway credential leaves every Sophy API key unchanged; a failed replacement leaves the prior credential operational.
- Concurrent Admin replacements commit exactly one current healthy credential row.
- One request and all of its structured retries use one snapped immutable credential row ID.
- Removing the Admin who supplied a credential does not disconnect it from the project.
- Disconnecting revokes neither Sophy API keys nor the Vercel key; it pauses AI work until reconnection.
- Project suspension or archival makes zero upstream calls even when a credential and Sophy API key are active.
- Gateway authentication failure marks the current credential invalid; network failure, ordinary rate limiting, and upstream `5xx` do not.
- Gateway-key budget exhaustion marks `billing_attention` and blocks every live and background AI operation in that project without fallback.
- Missing, invalid, disconnected, budget-blocked, or undecryptable credentials never shift cost to Sophy or another tenant.
- Raw Gateway secrets are encrypted at rest, are never returned after save or retained in browser storage, and never appear in logs, analytics, audit events, or client errors.
- Every successful upstream call after cutover records the project and immutable non-secret Gateway credential row ID used for reconciliation; work blocked before an upstream call and unverifiable historical rows may be null.
- Reconnection makes existing Sophy API keys and paused jobs eligible again without recreating project resources.
- A foreign-project resource ID returns not found.
- The final active Project Admin cannot be removed or demoted.
- Concurrent signup and invitation acceptance is idempotent.
- Existing Sophy API keys continue to authenticate after migration.
- A person who loses their final membership receives an explicit recovery path: an eligible user can create `My Project`; an ineligible user sees a stable access-recovery screen rather than a broken account.

## 14. Resolved decisions and operational policy

- Invitation-first users receive no extra personal project; the invited project is their default.
- Admin and Editor are the launch roles.
- The migrated enterprise project is the original single-tenant installation.
- Verified users may create projects and become their Admin; plan or billing limits can be layered on later.
- Eval judge and notification settings are project-specific.
- Each project has one current credential; no automatic cross-project or platform failover exists.
- Candidate credentials are validated with the authenticated, non-generation Gateway `getCredits` operation.
- Sophy-side commercial quotas, approval rules, and platform support procedures remain deployment policy. They do not weaken the tenant or Gateway isolation implemented here.
