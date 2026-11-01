<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: Ludy in a database it shares with other systems

By default Ludy owns its database: `migrate` may change anything database-wide, and the hardening guard checks all of it. Ludy Cloud can instead live inside a PostgreSQL database that other systems own schemas, roles and event triggers in (the first case: the Supabase project of DOS's own products, with sign-in by their accounts). Issue #2284, [plan Decision 23](../plan/crove-os-kernel.md). With `CROVE_SHARED_DATABASE=true` every effect of `migrate` and of the runtime stays with Ludy's own roles (`crove_*`) and schemas (`crove_*`). Self-host and every owned database leave it unset (`false`, the default) and keep every guard exactly as before; the invariant suite runs against that default.

This runbook covers what the mode changes, what it needs from the database, and how to back up and restore Ludy's part. The production steps for one operator's project (creating the logins, running `migrate`) are run by that operator's coordinator with the owner's approval and live in their private deployment layer.

## What the mode changes

| Database-wide effect | Owned database (default) | Shared database |
|---|---|---|
| `REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC` (`20261015120000_crove_kernel_revoke_temp`), and re-granting it to every other role | Done | **Not done.** PostgreSQL has no per-role denial of a privilege PUBLIC holds, so the only way to take TEMPORARY from Ludy's roles is to take it from PUBLIC, which changes every other system's sessions and every role they create later. `migrate` runs `supabase/shared-variants/20261015120000_crove_kernel_revoke_temp.sql` (a no-op) in its place; the ledger records the original's hash. |
| The guard's two TEMPORARY rules (Ludy's roles, and roles that can act as one) | Checked | Skipped. What stays: every `crove_*` function pins `search_path = pg_catalog, pg_temp` and the guard checks it on every run, so a planted temporary object cannot be reached by a definer function. A role of Ludy's can still create temporary objects (through PUBLIC). |
| The guard's reach into functions outside `crove_*` | Functions bound by OID to a `crove_*` object, and casts found by any type Ludy uses (built-in ones too) | The same, except casts are found by Ludy's own types only: another system's cast on `text` is not reached by anything Ludy defines. Another system's functions are never flagged unless a `crove_*` object is bound to them. |
| DDL watch event triggers (`crove_ddl_watch`, `crove_ddl_watch_drop`, fire on every DDL of the database) | Record every DDL outside the pipeline | The event function (`20261117090000_crove_kernel_ddl_watch_shared`) reads the mode from `crove_meta.deployment` and records only DDL on a `crove_*` schema or object, or by a `crove_*` role. Another system's DDL leaves no row and no alert. A foreign role that touches a Ludy schema is recorded. A GRANT has no object to name, so it is attributed by its role alone. |
| Other systems' default privileges (Supabase grants each new object of its admin roles to `anon`, `authenticated`, `service_role`) reaching Ludy's new objects | Not applicable | After each run `migrate` revokes, from every role that is not Ludy's, what it holds on `crove_*` schemas, tables, sequences and routines, and the guard fails the run when any remain. Nothing of the other system's schemas or default privileges is touched. |
| `auth-grants` (policies and column grants on the tables of Supabase Auth) | Self-host's database session check | **Refused.** Use `AUTH_SESSION_CHECK=jwt`, which reads no `auth` table. |
| Role passwords from the environment (`setRolePasswords`) | `crove_*` roles and `supabase_auth_admin` (bundled Auth) | `crove_*` roles only; a password for any other role is refused. |
| Cluster roles | `crove_*` created if absent; `supabase_auth_admin` only when absent | The same: nothing outside `crove_*` is created or changed (the bootstrap leaves an existing `supabase_auth_admin` alone). |
| Extensions | None created | None. |
| pg-boss | Schema `crove_jobs`; `ALTER DEFAULT PRIVILEGES IN SCHEMA crove_jobs` | Unchanged: in-schema only. |
| The advisory lock `hashtext('crove_migrate')` | Takes it | Takes it. Advisory locks share one key space per database; a collision with another system's key is improbable and only delays a migrate run. |

**Schema names.** Ludy keeps its `crove_*` names in a shared database (`crove_kernel`, `crove_finance`, `crove_social`, `crove_crm`, `crove_notes`, `crove_ads`, `crove_jobs`, `crove_meta`); renaming them belongs to the rebrand (#1682). They do not collide with another system's names as long as it has none starting with `crove_`: check it before the first run (the query is below). Nothing else is created in the database.

## What the database needs

- **A migration login of its own**, not the project's admin role (`postgres`, `supabase_admin`). Supabase sets default privileges for those roles that hand every new object to its API roles; `migrate` takes them back from Ludy's objects, but a dedicated role keeps Ludy's objects out of those defaults to begin with. The login needs `CREATEROLE` (it creates the `crove_*` roles) and `CREATE` on the database (it creates the `crove_*` schemas), is not a superuser, and owns what it creates.
- **The DDL watch needs a role that may create event triggers** (a superuser, or on hosted Supabase the privileged `postgres` role): `migrate` runs that step with the same URL and logs `DDL watch skipped` where the role may not, in which case Ludy runs without the watch (docs/runbooks/alerts.md). The event function must be owned by a superuser or by the role that attaches the triggers.
- **A pooler in transaction mode** (Supavisor, PgBouncer) for the API and the worker: `DB_RESET_ON_RELEASE=false` (`.env.example`). `migrate` needs a direct or session connection (an advisory lock).
- **Connections:** the pools are sized against the whole database's `max_connections`, which the other systems share (`DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`, docs/runbooks/observability.md).

Check the schema and role names before the first run (both queries return no row):

```sql
SELECT nspname FROM pg_namespace WHERE nspname LIKE 'crove\_%';
SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\_%';
```

## Backup: Ludy's schemas only

The project's own backup covers the whole database and belongs to its owner; Ludy keeps its own logical backup of its schemas beside it, so Ludy can be restored without touching anyone else's data.

- **Daily**, from a host that is not the database: as the migration login (or a read role that may select every `crove_*` table), with the secret read from the password manager:

  ```bash
  pg_dump --format=custom --no-owner --schema='crove_*' \
    --exclude-table-data='crove_kernel.context_key' \
    --file "ludy-$(date -u +%Y%m%d).dump" "$LUDY_DUMP_URL"
  ```

  `--no-owner` makes the file independent of the role that owns the objects; the access rules (`GRANT`, RLS policies) stay in it. The context key's rows are left out, as in [backup-and-restore.md](backup-and-restore.md): every restore makes a new key.
- Seal and upload it as that runbook does for the pilot (`tools/backup/seal.mjs`: AES-256-GCM, a key kept apart from the backup, an upload to a second location), keep 35 days, and alert when a day is missing.
- **Check:** the file lists every `crove_*` schema (`pg_restore --list FILE | grep -c 'SCHEMA - crove_'` is 8 today, one per schema above) and a monthly drill restores it into a scratch database (below) and runs the checks of "After a restore".

## Restore

Both routes replace Ludy's schemas and nothing else. Stop `api` and `worker` first, so nothing writes while the schemas are replaced, and start them last.

### A. Ludy's data is damaged, the project is fine: restore from the daily dump

1. Take a dump now as in the daily step, so the damage can be looked at later. **Check:** the file exists and lists the schemas.
2. Restore: `pg_restore --clean --if-exists --no-owner --single-transaction --dbname "$LUDY_ADMIN_URL" ludy-YYYYMMDD.dump`. It drops and recreates only the `crove_*` objects the dump holds, in one transaction, so a failure leaves the schemas as they were. **Check:** the ledger `crove_meta.schema_migrations` lists the same versions as the dump's day, and `SELECT count(*) FROM crove_kernel.audit_event` is what that day had.
3. Run `migrate` in shared mode with the current image: it applies any migration newer than the dump, takes foreign privileges back, and runs the guard. **Check:** it prints `done` and the guard passes.
4. Make a new context key and set it as in [context-key-rotation.md](context-key-rotation.md), then restart `api` and `worker`.
5. Do "After a restore" in [backup-and-restore.md](backup-and-restore.md) and [ledger-after-restore.md](ledger-after-restore.md) (the audit and journal streams, the gapless numbering, the WORM archive acknowledgement of [worm-archive.md](worm-archive.md)).
   **Rollback:** restore the dump of step 1 the same way.

### B. Point in time: the project's backup into a temporary project, then copy Ludy's schemas back

The project's point-in-time recovery restores the whole project, which would also roll back every other system in it. Restore it into a **temporary** project instead and copy only Ludy's schemas.

1. The project's owner restores the project's backup, to the chosen time, as a new temporary project. The live project is untouched. **Check:** the temporary project's `crove_meta.schema_migrations` exists, and its newest `crove_kernel.audit_event` row is no later than the chosen time.
2. From a host that is not either database, dump Ludy's schemas from the temporary project as in the daily step (`$LUDY_DUMP_URL` pointing at it), with no `--exclude-table-data` needed since the key is replaced anyway. Seal and keep the file like any backup.
3. Stop `api` and `worker`, then take route A's step 1 (a dump of the live schemas) and step 2 (restore the file from step 2 into the live project), then steps 3 to 5.
4. When the check passes, the project's owner deletes the temporary project.
   **What this does not restore:** the other systems' schemas (including Supabase Auth: users and sessions stay as they are now, and a user created after the chosen time still exists with no Ludy account rows) and Ludy's files in the object store (versioned, [backup-and-restore.md](backup-and-restore.md)).
   **Rollback:** restore the live dump of route A's step 1.

### The monthly drill

Restore the newest daily dump into a scratch database on a throwaway PostgreSQL 17 (a container), run `migrate` in shared mode against it, and check the ledger and the guard. Record the date and the result as the pilot's drill does ([backup-and-restore.md](backup-and-restore.md), "The restore drill").
