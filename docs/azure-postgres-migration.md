# Move Sophy PostgreSQL from Supabase to Azure

This runbook moves only the Sophy application data. Supabase Auth, Storage, Realtime, and Edge Functions are not application dependencies.

Vercel Blob, Vercel AI Gateway, and ZeptoMail stay in their current services.

## Safety rules

CAUTION: Do not let both databases accept application writes. Two writable databases cause data loss during rollback.

CAUTION: Do not migrate Supabase roles, ownership, or access grants. These objects belong to the managed Supabase service.

CAUTION: Do not allow all public IP addresses through the Azure firewall. Use the two Vercel Static IP addresses.

CAUTION: Keep all dump files on an approved encrypted host. The `request_logs` table can contain customer prompts and image input.

Use these controls for every migration:

1. Use a dedicated Azure Database for PostgreSQL Flexible Server.
2. Keep the Supabase project and source data until Azure passes the acceptance period.
3. Use `sslmode=verify-full` for every Azure connection.
4. Use a source snapshot or logical replication. Do not copy live tables independently.
5. Freeze all application writes before the final comparison.
6. Keep credentials out of commands, logs, pull requests, and shell history.
7. Remove every temporary role, publication, subscription, slot, and dump after acceptance.

## Current application requirements

Revalidate these facts before each migration attempt:

- PostgreSQL major version 17
- UTF-8 encoding, ICU locale `en-US`, and UTC time zone
- Schemas `public` and `drizzle`
- 22 application tables in `public`
- 13 Drizzle entries through migration `0012`
- `vector` in `public`, with `vector(1536)` and an HNSW index
- No PostgreSQL large objects
- A primary key on every replicated table

The source size was approximately 3.7 GB on 2026-08-21. The `request_logs` table used almost all this space.

## Required approvals

Record these decisions before you create a paid resource:

1. Select the Azure subscription and resource group.
2. Approve the General Purpose compute size and storage size.
3. Approve zone-redundant high availability, or record the accepted outage risk.
4. Select the backup-retention period and geo-redundancy option.
5. Approve Vercel Static IPs for `bom1`.

   Vercel listed this feature at US$100 per project each month on 2026-08-21. Data-transfer charges are separate.
6. Approve the maintenance window and maximum downtime.
7. Select the Supabase retention period after cutover.
8. Approve the temporary Supabase network restrictions for the cutover.

Use Central India for the Azure server. The Vercel configuration places Node.js functions in Mumbai (`bom1`).

Use the General Purpose tier when the application uses built-in PgBouncer. The Burstable tier does not include this service.

## Prepare the target

1. Create a dedicated PostgreSQL 17 Flexible Server in Central India.
2. Keep high availability disabled during the rehearsal only.
3. Enable storage auto-grow.
4. Set `require_secure_transport` to `on`.
5. Set `pgbouncer.enabled` to `true`.
6. Add `VECTOR` to the `azure.extensions` server parameter.
7. Enable Vercel Static IPs for `bom1`.
8. Add only those two IP addresses to the Azure firewall.
9. Add the approved operator IP address for the migration period.
10. Select geo-redundant backup when you create the server, if approved.
11. Set the approved backup-retention period when you create the server.

Create the database roles with the Azure administrator connection:

```sql
CREATE ROLE sophy_owner NOLOGIN;
CREATE ROLE sophy_migrator LOGIN;
CREATE ROLE sophy_app LOGIN;
CREATE ROLE sophy_app_readonly LOGIN;
GRANT sophy_owner TO sophy_migrator WITH SET TRUE;
GRANT sophy_owner TO CURRENT_USER WITH SET TRUE;
```

Set each login password with `\password`. Do not put the passwords in a SQL file.

Create the database with the source locale:

```sql
CREATE DATABASE sophy
  ENCODING 'UTF8'
  LOCALE_PROVIDER icu
  ICU_LOCALE 'en-US'
  LC_COLLATE 'en_US.UTF-8'
  LC_CTYPE 'en_US.UTF-8'
  TEMPLATE template0;

ALTER DATABASE sophy SET timezone = 'UTC';
```

Connect to `sophy`. Then create the extension before you restore the schema:

```sql
CREATE EXTENSION vector WITH SCHEMA public;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO sophy_owner;
ALTER SCHEMA public OWNER TO sophy_owner;
ALTER DATABASE sophy OWNER TO sophy_owner;
REVOKE CONNECT, TEMPORARY ON DATABASE sophy FROM PUBLIC;
ALTER ROLE sophy_migrator IN DATABASE sophy SET role = 'sophy_owner';
```

The schema-filtered dump does not contain `CREATE EXTENSION`. A restore fails when `vector` is not present.

## Configure secure client services

Store PostgreSQL services in a file outside the repository. Set the file mode to `0600`.

Create these service names:

- `sophy_source` for the Supabase session pooler
- `sophy_source_direct` for the true Supabase direct endpoint
- `sophy_target_admin` for the Azure direct endpoint on port 5432
- `sophy_target_app` for Azure PgBouncer on port 6432

Store passwords in a separate `PGPASSFILE` with mode `0600`. Do not put passwords in `pg_service.conf`.

Download the Supabase CA certificate from Database Settings. Store it outside the repository with mode `0600`.

Use `sslmode=verify-full` for Azure and Supabase migration clients. Set `SOURCE_DATABASE_CA_FILE` to the Supabase CA file.

## Prepare a fresh work directory

Create a new protected directory for every rehearsal or production attempt:

```bash
umask 077
MIGRATION_DIR="$(mktemp -d /private/tmp/sophy-azure-migration.XXXXXX)"
```

Run all dump and restore commands from the same shell. Never reuse an archive path from an earlier attempt.

## Run the final catalog preflight

Run this read-only query immediately before either copy method:

```sql
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p')) AS table_count,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)) AS tables_without_pk,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'drizzle') AND (c.relrowsecurity OR c.relforcerowsecurity)) AS rls_tables,
  (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'drizzle')) AS policies,
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'drizzle') AND NOT t.tgisinternal) AS user_triggers,
  (SELECT count(*) FROM pg_largeobject_metadata) AS large_objects,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'drizzle') AND c.relpersistence = 'u') AS unlogged_relations,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('v', 'm', 'f', 'c')) AS unsupported_relations,
  (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname IN ('public', 'drizzle') AND t.typtype IN ('d', 'e')) AS custom_types,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'drizzle')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
       WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')) AS custom_functions;
```

The table count must be 23. Every other result must be zero. Stop if any result differs.

## Select the copy method

Do a complete rehearsal before the production move. Record the dump, restore, index-build, and comparison times.

Use the offline method when the measured duration fits the approved maintenance window. This method has fewer moving parts.

Use the online method when the approved downtime is shorter. This method needs the true Supabase direct endpoint.

The direct Supabase endpoint can require IPv6. Enable the temporary Supabase IPv4 add-on when the Azure subscriber cannot use IPv6.

## Complete the availability setup

If high availability is approved, enable it after the initial rehearsal. Repeat the timed restore with high availability active.

Use the second restore time for the maintenance-window decision. Wait until both nodes are healthy, and test one failover.

Complete these steps before the final production copy. If high availability is rejected, record the accepted outage risk first.

## Offline method

### Rehearse the copy

Complete **Prepare a fresh work directory** on the encrypted migration host.

Create a consistent dump of only Sophy-owned schemas:

```bash
pg_dump \
  --dbname=service=sophy_source \
  --format=directory \
  --jobs=4 \
  --schema=public \
  --schema=drizzle \
  --no-owner \
  --no-privileges \
  --no-subscriptions \
  --file="$MIGRATION_DIR/dump"
```

Restore the dump into the empty target:

```bash
pg_restore \
  --dbname=service=sophy_target_admin \
  --format=directory \
  --jobs=4 \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --role=sophy_owner \
  "$MIGRATION_DIR/dump"
```

Run `ANALYZE` after the restore:

```bash
psql service=sophy_target_admin --command='ANALYZE;'
```

Record all command durations and errors. Recreate the empty target before the production copy.

### Freeze source writes

Open Vercel Project Settings, select Cron Jobs, and click **Disable Cron Jobs**. Wait five minutes for an active rollup to finish.

Create a temporary SELECT-only source login as the source table owner:

```sql
CREATE ROLE sophy_cutover_readonly LOGIN;
GRANT CONNECT ON DATABASE postgres TO sophy_cutover_readonly;
GRANT USAGE ON SCHEMA public TO sophy_cutover_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sophy_cutover_readonly;
```

Set its password with `\password`. Build and test its Supavisor transaction-pooler URL.

Verify that this login can read one application table. Verify that an `UPDATE` fails because the login lacks write rights.

Set the Vercel Function region to Mumbai (`bom1`) in Project Settings.

Set the current production `DATABASE_URL` to this SELECT-only URL. Redeploy the exact current production revision.

Verify the deployment commit, `bom1` function region, and assigned Static IP pair.

Wait 15 minutes after the deployment becomes active. This interval lets the longest old function invocation finish.

List every login that can gain write rights through any role:

```sql
WITH application_tables AS (
  SELECT c.oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p')
), writable_roles AS (
  SELECT DISTINCT writable.oid, writable.rolname
  FROM pg_roles writable
  CROSS JOIN application_tables application_table
  WHERE has_table_privilege(writable.oid, application_table.oid, 'INSERT')
     OR has_table_privilege(writable.oid, application_table.oid, 'UPDATE')
     OR has_table_privilege(writable.oid, application_table.oid, 'DELETE')
     OR has_table_privilege(writable.oid, application_table.oid, 'TRUNCATE')
)
SELECT DISTINCT
  login.rolname AS login_role,
  writable.rolname AS writable_via_role
FROM pg_roles login
JOIN writable_roles writable
  ON login.oid = writable.oid
  OR pg_has_role(login.oid, writable.oid, 'MEMBER')
WHERE login.rolcanlogin
ORDER BY login.rolname, writable.rolname;
```

The only permitted login names are `postgres`, `cli_login_postgres`, and `supabase_admin`. Stop if another login appears.

The second login can explicitly become `postgres`. The third login is a Supabase-managed superuser.

Record the current Supabase network restrictions. Allow only the migration host, Vercel Static IPs, and the rehearsed Azure address.

Network restrictions must cover the direct endpoint and both pooler modes. Prove that an unlisted test address cannot connect.

Set the whole source database to start new sessions as read-only:

```sql
ALTER DATABASE postgres SET default_transaction_read_only = on;
```

Reset the Supabase database password in the Supabase dashboard. Update the protected migration service with the new password.

Open a new controlled owner session. Set that session to read-write, and terminate non-superuser writer sessions:

```sql
SET default_transaction_read_only = off;
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename IN ('postgres', 'cli_login_postgres')
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid();
```

Verify that the stale owner password fails. Verify that the application can read and cannot write.

The source operator cannot terminate `supabase_admin`. Supabase had two idle sessions for this role on 2026-08-21.

Begin the hard freeze in the controlled owner session:

```sql
BEGIN READ WRITE;
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = 0;
LOCK TABLE
  drizzle.__drizzle_migrations,
  public.api_keys,
  public.app_settings,
  public.audit_log,
  public.auth_intents,
  public.blob_uploads,
  public.eval_runs,
  public.eval_samples,
  public.kb_chunks,
  public.kb_documents,
  public.knowledgebases,
  public.locks,
  public.login_tokens,
  public.project_gateway_credentials,
  public.project_invitations,
  public.project_memberships,
  public.project_settings,
  public.projects,
  public.rate_counters,
  public.request_logs,
  public.usage_events,
  public.usage_rollups,
  public.users
IN SHARE MODE;

SELECT pg_backend_pid() AS lock_session_pid,
       pg_current_wal_lsn() AS source_freeze_lsn;
```

The locks block table writes from every role, including a superuser. Reads and `pg_dump` remain available.

Keep this transaction and session open. Do not run another command in it until cutover or rollback.

Monitor its process and relation locks from a separate connection. If the session closes, reacquire every lock and repeat reconciliation.

Verify that no writer has a running query. Stop if any session waits for a lock held by the freeze session.

Repeat the writer-role query. Stop if its login-name set changed.

Record the source freeze time, lock-session process ID, and source freeze LSN.

### Copy the frozen source

Prepare a fresh work directory. Repeat the rehearsal commands against a new, empty target database.

Run the quick comparison:

```bash
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
SOURCE_DATABASE_CA_FILE="$SUPABASE_CA_FILE" \
node scripts/database/compare.mjs
```

Run the full row comparison:

```bash
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
SOURCE_DATABASE_CA_FILE="$SUPABASE_CA_FILE" \
node scripts/database/compare.mjs --deep
```

The comparison prints only counts, hashes, and pass or fail results. It does not print row values.

## Online method

Use native PostgreSQL logical replication. Azure Migration Service does not document Supabase as a supported source.

### Prepare the source publisher

Freeze all schema changes before you create these dumps. Do not run a migration until cutover finishes.

Create the temporary source role through the true direct Supabase service:

```bash
PGSERVICE=sophy_source_direct createuser \
  --pwprompt \
  --replication \
  --login \
  --no-superuser \
  --no-createdb \
  --no-createrole \
  --no-bypassrls \
  --no-inherit \
  sophy_azure_replication
```

The command prompts twice for a generated password. It encrypts the password before it sends the role-creation command.

Do not add `--echo`. Do not use `\password` after creation. The managed source login cannot modify a replication role after creation.

Grant only the required database access as the source table owner:

```sql
GRANT CONNECT ON DATABASE postgres TO sophy_azure_replication;
GRANT USAGE ON SCHEMA public, drizzle TO sophy_azure_replication;
GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO sophy_azure_replication;
```

Verify that this login has `REPLICATION` and does not have `BYPASSRLS`.

The online rehearsal must also remove this role with the cleanup commands below. Use the offline method if creation or removal fails.

Create the publication:

```sql
CREATE PUBLICATION sophy_azure_pub FOR TABLE
  drizzle.__drizzle_migrations,
  public.api_keys,
  public.app_settings,
  public.audit_log,
  public.auth_intents,
  public.blob_uploads,
  public.eval_runs,
  public.eval_samples,
  public.kb_chunks,
  public.kb_documents,
  public.knowledgebases,
  public.locks,
  public.login_tokens,
  public.project_gateway_credentials,
  public.project_invitations,
  public.project_memberships,
  public.project_settings,
  public.projects,
  public.rate_counters,
  public.request_logs,
  public.usage_events,
  public.usage_rollups,
  public.users;
```

Run the publication command as the source `postgres` owner. The temporary replication login does not own the tables.

Do not use `FOR TABLES IN SCHEMA`. That form needs a PostgreSQL superuser.

Monitor the retained WAL size. The source slot limit was 2 GB on 2026-08-21.

### Restore the empty schema

Complete **Prepare a fresh work directory** for this online attempt.

Create separate pre-data and post-data dumps:

```bash
pg_dump \
  --dbname=service=sophy_source \
  --format=directory \
  --section=pre-data \
  --schema=public \
  --schema=drizzle \
  --no-owner \
  --no-privileges \
  --no-subscriptions \
  --file="$MIGRATION_DIR/pre-data"

pg_dump \
  --dbname=service=sophy_source \
  --format=directory \
  --section=post-data \
  --schema=public \
  --schema=drizzle \
  --no-owner \
  --no-privileges \
  --no-subscriptions \
  --file="$MIGRATION_DIR/post-data"
```

Restore the pre-data dump into the empty target:

```bash
pg_restore \
  --dbname=service=sophy_target_admin \
  --format=directory \
  --jobs=4 \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --role=sophy_owner \
  "$MIGRATION_DIR/pre-data"
```

Keep `vector` installed before this step. The post-data dump contains indexes and foreign keys.

### Start the subscription

Open Vercel Project Settings, select Cron Jobs, and click **Disable Cron Jobs**. Wait five minutes for an active rollup to finish.

Prove Azure-to-Supabase direct connectivity during the rehearsal. Use the temporary Supabase IPv4 add-on when Azure cannot reach the IPv6 endpoint.

The source certificate must pass `verify-full` from the Azure subscriber. If the managed server cannot trust that CA, stop and use the offline method.

Verify the Azure subscription owner before you create a slot:

```sql
SELECT
  pg_has_role(current_user, 'pg_create_subscription', 'USAGE') AS can_subscribe,
  has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
  pg_has_role(current_user, 'sophy_owner', 'SET') AS can_set_owner;
```

All three results must be `true`.

Create the source slot immediately before the subscription:

```sql
SELECT * FROM pg_create_logical_replication_slot('sophy_azure_slot', 'pgoutput');
```

Do not leave this slot unattached. The source slot limit was 2 GB on 2026-08-21.

CAUTION: Put the source password in a temporary SQL file with mode `0600`. Remove the file immediately after use.

Create the subscription on Azure:

```sql
CREATE SUBSCRIPTION sophy_azure_sub
  CONNECTION 'host=<direct-source-host> port=5432 dbname=postgres user=sophy_azure_replication password=<temporary-password> sslmode=verify-full sslrootcert=system options=-crow_security=off'
  PUBLICATION sophy_azure_pub
  WITH (
    copy_data = true,
    create_slot = false,
    slot_name = 'sophy_azure_slot',
    binary = false,
    run_as_owner = false,
    password_required = true
  );
```

If this command fails, drop `sophy_azure_slot` immediately. Do not retry with `sslmode=require` or another weaker mode.

Verify that every row in `pg_subscription_rel` has state `r`. Monitor the source slot and target subscription during the copy.

Restore indexes and foreign keys after the initial table copy reaches state `r`:

```bash
pg_restore \
  --dbname=service=sophy_target_admin \
  --format=directory \
  --jobs=4 \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --role=sophy_owner \
  "$MIGRATION_DIR/post-data"
```

Run `ANALYZE`. Then verify that every index and constraint is valid.

### Freeze and reconcile

Complete every step in **Freeze source writes**. Keep the hard-lock session open.

Wait until the Azure apply worker reports the recorded source freeze LSN:

```sql
SELECT
  latest_end_lsn,
  latest_end_lsn >= '<source-freeze-lsn>'::pg_lsn AS caught_up
FROM pg_stat_subscription
WHERE subname = 'sophy_azure_sub'
  AND worker_type = 'apply';

SELECT apply_error_count, sync_error_count
FROM pg_stat_subscription_stats
WHERE subname = 'sophy_azure_sub';
```

`caught_up` must be true. Both error counts must be zero.

Logical replication does not copy sequence positions. Reset the Drizzle sequence:

```sql
SELECT setval(
  pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id'),
  (SELECT max(id) FROM drizzle.__drizzle_migrations),
  true
);
```

Verify that all subscription tables remain in state `r`. Then run both database comparisons.

The comparison includes the Drizzle sequence position. Disable the subscription after every comparison passes:

```sql
ALTER SUBSCRIPTION sophy_azure_sub DISABLE;
```

## Grant the application role

Run these commands as `sophy_owner` after the final restore:

```sql
GRANT CONNECT, TEMPORARY ON DATABASE sophy TO sophy_app;
GRANT USAGE ON SCHEMA public TO sophy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sophy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sophy_app;

GRANT CONNECT ON DATABASE sophy TO sophy_app_readonly;
GRANT USAGE ON SCHEMA public TO sophy_app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sophy_app_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE sophy_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sophy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sophy_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sophy_app;
```

Do not grant access to the `drizzle` schema. The application role does not run migrations.

## Validate the target

Use the application role through PgBouncer:

```bash
TARGET_DATABASE_URL="$AZURE_PGBOUNCER_URL" \
TARGET_DATABASE_URL_UNPOOLED="$AZURE_DIRECT_MIGRATOR_URL" \
node scripts/database/smoke.mjs
```

The smoke command uses one transaction and rolls it back. It validates these items:

- A restricted application role
- The exact restricted application and migration roles
- Verified TLS for pooled and direct connections
- Database, schema, table, index, and sequence ownership
- The complete Drizzle ledger
- The 1536-dimension vector type
- The valid HNSW index
- A successful HNSW nearest-neighbour search
- Transaction advisory locks
- Insert, update, row-lock, and delete rights

Run the durable write checks only on the disposable rehearsal target:

1. Revoke a temporary key and verify immediate rejection.
2. Run one approved low-cost model request.
3. Run the rollup cron once.
4. Correlate the new usage and request-log rows.

Recreate the final target after these rehearsal writes.

Use only rollback-contained or read-only checks on the final target before cutover:

1. Run `node scripts/database/smoke.mjs`. Its transaction rolls back.
2. Load the operator console with an existing session.
3. Authenticate one existing key with a harmless model-list request.
4. Restart Azure PostgreSQL and verify pool reconnection.
5. Restore one Azure backup to a separate validation server.

The backup test creates another paid copy of production data. Get cost and data-handling approval first. Delete that server after validation.

## Verify the Vercel preview path

Complete this gate before you change any Production variable:

1. Deploy the exact pull-request commit as a protected Preview deployment.
2. Give that Preview only the Azure SELECT-only PgBouncer URL.
3. Set the expected Azure host suffix and pool size for that Preview.
4. Keep the migrator URL out of Vercel.
5. Verify the deployment metadata reports `bom1`.
6. Verify its outbound address is one of the purchased Static IP pair.
7. Verify Azure accepts that address and rejects an unlisted address.
8. Verify a database-backed read succeeds through verified TLS.
9. Verify an application write fails because the Preview role lacks write rights.

## Run the final source release gate

Run this gate immediately before Azure writes or a pre-write rollback.

From a separate source connection, verify the hard locks and blocked-session count:

```sql
SELECT
  (SELECT count(*)
   FROM pg_locks
   WHERE pid = <lock-session-pid>
     AND locktype = 'relation'
     AND mode = 'ShareLock'
     AND granted) AS granted_share_locks,
  (SELECT count(*)
   FROM pg_stat_activity activity
   WHERE <lock-session-pid> = ANY(pg_blocking_pids(activity.pid))) AS blocked_sessions;
```

The lock count must be at least 23. The blocked-session count must be zero.

Keep this query running as a watcher until the lock transaction ends. Do not release locks while a writer waits.

Contact Supabase when a waiting `supabase_admin` session cannot be cancelled. Do not continue through that condition.

Run the quick database comparison again. It rechecks the unlocked Drizzle sequence.

Stop and investigate if the sequence differs. Repeat the full comparison if the lock-session process changed.

## Cut over Vercel

Keep the first Azure production deployment read-only. Use the `sophy_app_readonly` PgBouncer URL.

Set these Production variables in Vercel:

```text
DATABASE_URL=<Azure sophy_app_readonly PgBouncer URL on port 6432>
DATABASE_EXPECTED_HOST_SUFFIX=.postgres.database.azure.com
DATABASE_POOL_MAX=5
```

Keep the direct migrator credential only on the protected migration host. Do not put it in Vercel.

Remove `DATABASE_SSL_NO_VERIFY`. Do not change the key, session, Gateway-encryption, fingerprint, Blob, or cron secrets.

Merge the reviewed migration pull request only after the target passes every database comparison. This merge deploys the strict Azure connection policy.

Verify that the production deployment uses the expected commit and the `bom1` function region. Repeat the read-only checks and prove that a write is rejected.

Complete **Run the final source release gate**. Keep its separate watcher active.

Change only `DATABASE_URL` to the `sophy_app` PgBouncer URL. Redeploy the same commit to reopen writes on Azure.

After the first successful Azure write, the instant rollback boundary ends.

For an online migration, detach and remove the disabled target subscription:

```sql
ALTER SUBSCRIPTION sophy_azure_sub DISABLE;
ALTER SUBSCRIPTION sophy_azure_sub SET (slot_name = NONE);
DROP SUBSCRIPTION sophy_azure_sub;
```

Verify that `sophy_azure_slot` reports `active = false` on the source.

Commit the source hard-lock transaction. For an online migration, immediately remove its source objects:

```sql
COMMIT;
SELECT pg_drop_replication_slot('sophy_azure_slot');
DROP PUBLICATION sophy_azure_pub;
REVOKE SELECT ON ALL TABLES IN SCHEMA public, drizzle
  FROM sophy_azure_replication;
REVOKE USAGE ON SCHEMA public, drizzle
  FROM sophy_azure_replication;
REVOKE CONNECT ON DATABASE postgres FROM sophy_azure_replication;
DROP ROLE sophy_azure_replication;
```

Every online cleanup block is a stop gate. Keep the source network restrictions active until every command passes.

For an offline migration, run only `COMMIT`. Close the source session after the required commands pass.

Keep the source database default read-only. The source is now retired, not an exact rollback copy.

Keep the protected dump and comparison report as the immutable pre-cutover reference.

Revoke a temporary key and run one approved low-cost request. Correlate its usage and request-log rows.

Re-enable Vercel Cron Jobs and run one verified rollup cycle.

Monitor errors, connections, CPU, storage, and latency during the acceptance period.

## Rollback

Before Azure accepts writes, first prove that Azure contains no new application write.

Complete **Run the final source release gate**. Keep its separate watcher active.

For an online migration, detach and remove the disabled target subscription:

```sql
ALTER SUBSCRIPTION sophy_azure_sub DISABLE;
ALTER SUBSCRIPTION sophy_azure_sub SET (slot_name = NONE);
DROP SUBSCRIPTION sophy_azure_sub;
```

Verify that `sophy_azure_slot` reports `active = false` on the source.

Use the source hard-lock session to release the locks. Remove online source objects before you reopen writes:

```sql
COMMIT;
SELECT pg_drop_replication_slot('sophy_azure_slot');
DROP PUBLICATION sophy_azure_pub;
REVOKE SELECT ON ALL TABLES IN SCHEMA public, drizzle
  FROM sophy_azure_replication;
REVOKE USAGE ON SCHEMA public, drizzle
  FROM sophy_azure_replication;
REVOKE CONNECT ON DATABASE postgres FROM sophy_azure_replication;
DROP ROLE sophy_azure_replication;
```

Skip the replication commands after an offline copy. Reset the database default and terminate non-superuser writer sessions:

```sql
SET default_transaction_read_only = off;
ALTER DATABASE postgres RESET default_transaction_read_only;
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename IN ('postgres', 'cli_login_postgres')
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid();
```

Set Production `DATABASE_URL` to the source owner URL with the rotated password. Redeploy the exact pre-migration commit.

Verify one rolled-back write canary. Then verify the application can write, and re-enable Vercel Cron Jobs.

Restore the recorded Supabase network restrictions after the rollback is stable.

This pre-write rollback does not lose data.

After Azure accepts writes, do not point traffic directly to Supabase. Supabase does not contain the new Azure writes.

For a later rollback, freeze Azure first. Then copy and reconcile the Azure changes before you change traffic.

Do not add dual writes as a rollback mechanism.

## Clean up after acceptance

Open a controlled source owner session. Set it to read-write, drain the retired read-only sessions, and remove their role:

```sql
SET default_transaction_read_only = off;
ALTER ROLE sophy_cutover_readonly NOLOGIN;
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename = 'sophy_cutover_readonly'
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid();
REVOKE SELECT ON ALL TABLES IN SCHEMA public
  FROM sophy_cutover_readonly;
REVOKE USAGE ON SCHEMA public FROM sophy_cutover_readonly;
REVOKE CONNECT ON DATABASE postgres FROM sophy_cutover_readonly;
DROP ROLE sophy_cutover_readonly;
```

Use the Azure administrator after Vercel uses `sophy_app`. Block new read-only logins, drain connections, and remove the role:

```sql
ALTER ROLE sophy_app_readonly NOLOGIN;
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename = 'sophy_app_readonly'
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid();
SET ROLE sophy_owner;
REVOKE SELECT ON ALL TABLES IN SCHEMA public
  FROM sophy_app_readonly;
REVOKE USAGE ON SCHEMA public FROM sophy_app_readonly;
REVOKE CONNECT ON DATABASE sophy FROM sophy_app_readonly;
RESET ROLE;
DROP ROLE sophy_app_readonly;
```

Remove the temporary operator firewall rule. Keep only the Vercel Static IP addresses.

Remove the temporary Supabase IPv4 add-on, if it was enabled.

Remove the Vercel and Azure addresses from the Supabase allowlist. Keep only the approved observation access.

Erase the protected dump directory after the accepted retention period. Remove every temporary credential file.

Delete the approved backup-restore validation server and its copied data.

Confirm that Vercel Cron Jobs are enabled.

Keep Supabase isolated for the approved observation period. It is not a writable rollback target after Azure accepts writes.

Remove the Supabase project only after a separate deletion approval.

## References

- [Azure PgBouncer](https://learn.microsoft.com/en-us/azure/postgresql/connectivity/concepts-pgbouncer)
- [Azure pgvector](https://learn.microsoft.com/en-us/azure/postgresql/extensions/how-to-use-pgvector)
- [Azure dump and restore](https://learn.microsoft.com/en-us/azure/postgresql/migrate/how-to-migrate-using-dump-and-restore)
- [Azure PostgreSQL pricing](https://azure.microsoft.com/pricing/details/postgresql/flexible-server/)
- [Supabase external logical replication](https://supabase.com/docs/guides/database/postgres/setup-replication-external)
- [Supabase network restrictions](https://supabase.com/docs/guides/platform/network-restrictions)
- [Vercel function regions](https://vercel.com/docs/functions/configuring-functions/region)
- [Vercel Static IPs](https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address)
