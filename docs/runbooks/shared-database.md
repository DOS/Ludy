<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: Ludy in a database it shares with other systems

By default Ludy owns its database: `migrate` may change anything database-wide, and the hardening guard checks all of it. Ludy Cloud can instead live inside a PostgreSQL database that other systems own schemas, roles and event triggers in (the first case: the Supabase project of DOS's own products, with sign-in by their accounts). Issue #2284, [plan Decision 23](../plan/crove-os-kernel.md). With `CROVE_SHARED_DATABASE=true` every effect of `migrate` and of the runtime stays with Ludy's own roles (`crove_*`) and schemas (`crove_*`). Self-host and every owned database leave it unset (`false`, the default) and keep every guard exactly as before; the invariant suite runs against that default.

This runbook covers what the mode changes, what it needs from the database, and how to back up and restore Ludy's part. The production steps for one operator's project (creating the logins, running `migrate`) are run by that operator's coordinator with the owner's approval and live in their private deployment layer.

## What the mode changes

| Database-wide effect | Owned database (default) | Shared database |
|---|---|---|
| `REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC` (`20261015120000_crove_kernel_revoke_temp`), and re-granting it to every other role | Done | **Not done.** PostgreSQL has no per-role denial of a privilege PUBLIC holds, so the only way to take TEMPORARY from Ludy's roles is to take it from PUBLIC, which changes every other system's sessions and every role they create later. `migrate` runs `supabase/shared-variants/20261015120000_crove_kernel_revoke_temp.sql` (a no-op) in its place; the ledger records the original's hash. |
| The guard's two TEMPORARY rules (Ludy's roles, and roles that can act as one) | Checked | Skipped. What stays: every `crove_*` function pins `search_path = pg_catalog, pg_temp` and the guard checks it on every run, so a planted temporary object cannot be reached by a definer function. A role of Ludy's can still create temporary objects (through PUBLIC). The membership rule is kept without its TEMPORARY condition: a role that is not Ludy's, not a superuser and not the runner, but can act as a `crove_*` role, fails the guard. |
| The guard's reach into functions outside `crove_*` | Functions bound by OID to a `crove_*` object, and casts found by any type Ludy uses (built-in ones too) | The same, except casts are found by Ludy's own types only: another system's cast on `text` is not reached by anything Ludy defines. Another system's functions are never flagged unless a `crove_*` object is bound to them. |
| DDL watch event triggers (`crove_ddl_watch`, `crove_ddl_watch_drop`, fire on every DDL of the database) | Record every DDL outside the pipeline | The event function (`20261117090000_crove_kernel_ddl_watch_shared`) reads the mode from `crove_meta.deployment` and records only DDL on a `crove_*` schema or object, or by a `crove_*` role. Another system's DDL leaves no row and no alert. A foreign role that touches a Ludy schema is recorded. A GRANT has no object to name, so it is attributed by its role alone. |
| Other systems' default privileges (Supabase grants each new object of its admin roles to `anon`, `authenticated`, `service_role`) reaching Ludy's new objects | Not applicable | After each run `migrate` revokes, from every role that is not Ludy's, what it holds on `crove_*` schemas, tables, sequences and routines, and the guard fails the run when any remain. Nothing of the other system's schemas or default privileges is touched. |
| `auth-grants` (policies and column grants on the tables of Supabase Auth) | Self-host's database session check | **Refused.** Use `AUTH_SESSION_CHECK=jwt`, which reads no `auth` table. |
| Role passwords from the environment (`setRolePasswords`) | `crove_*` roles and `supabase_auth_admin` (bundled Auth) | `crove_*` roles only; a password for any other role is refused. |
| Cluster roles | `crove_*` created if absent; `supabase_auth_admin` (with its `auth` schema and `GRANT CREATE ON DATABASE`) only when absent | The same: a project has `supabase_auth_admin`, so nothing outside `crove_*` is created or changed. A database without it, which is not a Supabase one, would get it as before. |
| Extensions | None created | None. |
| The event triggers themselves | Fire on every DDL statement of the database | The same triggers, but the function records only Ludy's DDL and, in shared mode, an error while recording is a warning, never a failure of the other system's statement. A logical replication publication `FOR ALL TABLES` of the other system would stream Ludy's tables too: have the project's owner list tables instead. |
| pg-boss | Schema `crove_jobs`; `ALTER DEFAULT PRIVILEGES IN SCHEMA crove_jobs` | Unchanged: in-schema only. |
| The advisory lock `hashtext('crove_migrate')` | Takes it | Takes it. Advisory locks share one key space per database; a collision with another system's key is improbable and only delays a migrate run. |

**Schema names.** Ludy keeps its `crove_*` names in a shared database (`crove_kernel`, `crove_finance`, `crove_social`, `crove_crm`, `crove_notes`, `crove_ads`, `crove_jobs`, `crove_meta`); renaming them belongs to the rebrand (#1682). They do not collide with another system's names as long as it has none starting with `crove_`: check it before the first run (the query is below). Nothing else is created in the database.

## What the database needs

- **A migration login of its own**, not the project's admin role (`postgres`, `supabase_admin`). Supabase sets default privileges for those roles that hand every new object to its API roles; `migrate` takes them back from Ludy's objects, but a dedicated role keeps Ludy's objects out of those defaults to begin with. The login needs `CREATEROLE` (it creates the `crove_*` roles) and `CREATE` on the database (it creates the `crove_*` schemas), is not a superuser, and owns what it creates. **It must be the one that creates the `crove_*` roles** (the first `migrate` run does): a role holds `ADMIN OPTION` on the roles it creates, and the guard fails the run when any other non-superuser role, `postgres` included, can act as a `crove_*` role. If the roles already exist, made by another login, that login revokes its memberships and gives the migration login `ADMIN OPTION` on each role first.
- **The DDL watch needs a role that may create event triggers** (a superuser, or on hosted Supabase the privileged `postgres` role): `migrate` runs that step with the same URL and logs `DDL watch skipped` where the role may not, in which case Ludy runs without the watch (docs/runbooks/alerts.md). The event function must be owned by a superuser or by the role that attaches the triggers.
- **A pooler in transaction mode** (Supavisor, PgBouncer) for the API and the worker: `DB_RESET_ON_RELEASE=false` (`.env.example`). `migrate` needs a direct or session connection (an advisory lock).
- **Connections:** the pools are sized against the whole database's `max_connections`, which the other systems share (`DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`, docs/runbooks/observability.md).

Check the schema and role names before the first run (both queries return no row):

```sql
SELECT nspname FROM pg_namespace WHERE nspname LIKE 'crove\_%';
SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\_%';
```

## Switching modes

The ledger records the original hash of the TEMPORARY revoke whichever way it ran, and a variant is not hashed, so the mode is a decision made on the first run:

- **Owned to shared:** the revoke that already ran in the owned mode stays in place (PUBLIC has lost TEMPORARY; the roles that held it were given it directly). The shared guard does not mind.
- **Shared to owned:** the revoke never ran, and the ledger says it did, so it is not run again: the owned guard then fails on the TEMPORARY rule until the database owner revokes by hand, as its message says. Do not switch back without that decision.
- A first run with `CROVE_SHARED_DATABASE` forgotten on a shared project would run the revoke against it. `migrate` therefore refuses, in shared mode, to apply that migration without its variant, but cannot tell the two cases apart in owned mode: the log line `shared-database mode` is the first check of every run.

## Backup: Ludy's schemas only

The project's own backup covers the whole database and belongs to its owner; Ludy keeps its own logical backup of its schemas beside it, so Ludy can be restored without touching anyone else's data.

- **Daily**, from a host that is not the database, as a login that can read every `crove_*` table: the migration login, or a role **named `crove_*`** (a reader named otherwise has its privileges taken back on every `migrate` run, and the next dump breaks). The secret comes from the password manager.

  ```bash
  pg_dump --format=custom --schema='crove_*' \
    --exclude-table-data='crove_kernel.context_key' \
    --exclude-table-data='crove_kernel.context_token_key' \
    --exclude-table-data='crove_kernel.mail_hash_key' \
    --file "ludy-$(date -u +%Y%m%d).dump" "$LUDY_DUMP_URL"
  ```

  The file keeps owners and access rules (`GRANT`, RLS policies): the definer functions are owned by narrow roles (`crove_definer_tenant`, `crove_auth_reader`) and must stay so. The key tables' rows (the context keys and the mail hash key) are left out, as in [backup-and-restore.md](backup-and-restore.md): every restore makes new ones ([context-key-rotation.md](context-key-rotation.md), [context-token-key.md](context-token-key.md)). The queue schema `crove_jobs` is in the file, so a restore of an older day brings back that day's queue state: jobs that finished since may run again, and jobs queued since are gone. Idempotent commands and the outbox make that safe, but expect duplicates of mails and posts in that window and look at `crove_jobs.job` after a restore.
- Seal and upload it as that runbook does for the pilot (`tools/backup/seal.mjs`: AES-256-GCM, a key kept apart from the backup, an upload to a second location), keep 35 days, and alert when a day is missing.
- **Check:** the file lists every `crove_*` schema (`pg_restore --list FILE | grep -c 'SCHEMA - crove_'` is 8 today, one per schema above), and the monthly drill restores it into a scratch database (below) and runs the checks of "After a restore".

## Restore

Both routes replace Ludy's schemas and nothing else. Stop `api` and `worker` first, so nothing writes while the schemas are replaced, and start them last. Run the restore as the migration login: it holds the right to hand objects to the definer roles (the migrations grant it `SET` on them), which the restore needs to give each function back to its owner.

How the schemas are replaced, in one transaction so that a failure leaves them as they were:

```bash
pg_restore --file restore.sql ludy-YYYYMMDD.dump
cat > drop.sql <<'SQL'
DROP SCHEMA IF EXISTS crove_ads, crove_crm, crove_finance, crove_jobs, crove_kernel, crove_meta, crove_notes, crove_social CASCADE;
SQL
psql --single-transaction --set ON_ERROR_STOP=1 --file drop.sql --file restore.sql "$LUDY_ADMIN_URL"
```

`DROP SCHEMA ... CASCADE` also removes the DDL watch's two event triggers (they depend on a function in `crove_kernel`), so nothing fires during the restore, and it removes objects a newer live schema holds that the dump lacks, which `pg_restore --clean` would stop on. `migrate` reinstalls the triggers afterwards (a login that may not create them skips them, as before). The restore does not use `--no-owner`, so each function keeps its owner.

### A. Ludy's data is damaged, the project is fine: restore from the daily dump

1. Take a dump now as in the daily step (with the key tables' rows this time left out too), and save the owners of the definer functions: `SELECT p.oid::regprocedure::text, r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner WHERE n.nspname LIKE 'crove\_%' AND p.prosecdef ORDER BY 1`. **Check:** the file exists and lists the schemas.
2. Restore as above. **Check:** the ledger `crove_meta.schema_migrations` lists the versions of the dump's day, `SELECT count(*) FROM crove_kernel.audit_event` is what that day had, and the query of step 1 gives **the same owners** as before: a definer function owned by the migration login runs with its privileges, which would break the ledger's rules (`migrate` does not repair this, since the ledger says the migrations that set the owners ran).
3. Run `migrate` in shared mode with the current image: it applies any migration newer than the dump, reinstalls the DDL watch where it may, takes foreign privileges back, and runs the guard. **Check:** it prints `done` and the guard passes.
4. Make a new context key and a new mail hash key and set them as in [context-key-rotation.md](context-key-rotation.md), then restart `api` and `worker`.
5. Do "After a restore" in [backup-and-restore.md](backup-and-restore.md) and [ledger-after-restore.md](ledger-after-restore.md) (the audit and journal streams, the gapless numbering, the WORM archive acknowledgement of [worm-archive.md](worm-archive.md)), and look at the queue as the backup step says.
   **Rollback:** restore the dump of step 1 the same way.

### B. Point in time: the project's backup into a temporary project, then copy Ludy's schemas back

The project's point-in-time recovery restores the whole project, which would also roll back every other system in it. Restore it into a **temporary** project instead and copy only Ludy's schemas.

1. The project's owner restores the project's backup, to the chosen time, as a new temporary project. The live project is untouched. **Check:** the temporary project's `crove_meta.schema_migrations` exists, and its newest `crove_kernel.audit_event` row is no later than the chosen time.
2. From a host that is not either database, dump Ludy's schemas from the temporary project as in the daily step (`$LUDY_DUMP_URL` pointing at it). The temporary project holds the roles as they were at that time, so check that the `crove_*` role names exist in the live project with the same memberships: the dump names roles, not their passwords or login rights. Seal and keep the file like any backup.
3. Stop `api` and `worker`, then take route A's step 1 (a dump of the live schemas and the owners of the definer functions) and step 2 (restore the file from step 2 into the live project), then steps 3 to 5.
4. When the check passes, the project's owner deletes the temporary project.
   **What this does not restore:** the other systems' schemas (including Supabase Auth: users and sessions stay as they are now, and a user created after the chosen time still exists with no Ludy account rows) and Ludy's files in the object store (versioned, [backup-and-restore.md](backup-and-restore.md)).
   **Rollback:** restore the live dump of route A's step 1.

### The monthly drill

Restore the newest daily dump into a scratch database on a throwaway PostgreSQL 17 (a container) with the roles created first (run `migrate` in shared mode against an empty database, then drop the `crove_*` schemas and restore as above), run `migrate` in shared mode against it, and check the ledger, the owners and the guard. Record the date and the result as the pilot's drill does ([backup-and-restore.md](backup-and-restore.md), "The restore drill").
