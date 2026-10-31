# Logs, request ids and slow queries (#2175)

When someone reports "an upload failed at 10:42", this page is how to find the request, and what the database was doing. It covers the structured logs, the request id, the lines of a job, the slowest queries (`pg_stat_statements`) and the database pool sizes. A metrics endpoint and tracing are not part of it: each would be its own issue, filed when an alert needs it.

## 1. Turn the JSON logs on

Set `LOG_FORMAT=json` in `.env` (the default is `text`, plain lines for a laptop) and restart the stack. `pnpm pilot:check` lists it as a manual item on a public URL until it is set.

Every line the API, the worker and the prober print is then one JSON object. The messages are the ones the code always printed; only the format changes.

| Field | Meaning |
|---|---|
| `ts` | UTC time, ISO 8601 |
| `level` | `debug`, `info`, `warn` or `error` |
| `role` | `api`, `worker`, `all` or `prober` |
| `msg` | the message, as the plain line would read |
| `requestId` | the request's id, on every line it made |
| `orgId` | the org, once the request's caller is known to be a member of one, and on a job's lines when its payload names one |
| `jobId`, `queue` | on a job's lines: the job's id (one job at a time) and its queue |
| `method`, `route`, `status`, `durationMs` | only on the access line (`"msg":"request"`), see below |

The one-time commands, the migrations and the CLI roles (`vapid-keys`, `pilot-check`, `restore-report` and the like) print plain text for a person to read.

**What a line never carries.** No token, password, cookie, header, query string, request or response body, address, user agent or personal data is ever added. The access line names the matched *route pattern* (`/api/export/journal.xlsx`, `/api/*` for a path no route matches), never the path itself, which can hold a link token. As a last line of defense, a bearer token, a JWT and the password of a URL with credentials are blanked out of a message even if some code printed one. A test proves it (`apps/kernel/test/log.test.ts`); if you ever find a value in a line that should not be there, treat it as a bug, rotate that value, and file it.

## 2. Find one request

Every answer of the API carries an `x-request-id` header, a fresh random id per request (an id a caller sends is ignored). Read it from the browser's network tab, from `curl -i`, or from the proxy's access log if it prints response headers. Then:

```sh
docker compose logs --no-log-prefix api | jq -cR 'fromjson? | select(.requestId == "<request id>")'
```

With the pilot layout the API is the `api` service; the all-in-one stack calls it `crove`. You get the access line (method, route pattern, status, duration) and every line the request printed, such as an `[http]` error with its message, in order.

Without an id (the person only knows the time and the org), filter by what you have:

```sh
docker compose logs --no-log-prefix --since 2026-11-02T10:30:00 --until 2026-11-02T10:50:00 api \
  | jq -cR 'fromjson? | select(.orgId == "<org id>" and (.level == "error" or .status >= 500))'
```

`fromjson?` skips any line that is not JSON (Node's own warnings, a crash trace, what was printed before the logger started), which a plain `jq -c` would stop at. The access line is written for every request except the health probes (`/healthz`, `/readyz`), at `error` level for a 5xx answer.

## 3. Find a job's lines

Each job of the worker runs with its queue, its id and, when its payload names one, its org on every line it prints:

```sh
docker compose logs --no-log-prefix worker | jq -cR 'fromjson? | select(.queue == "finance-file-extract" and .orgId == "<org id>")'
docker compose logs --no-log-prefix worker | jq -cR 'fromjson? | select(.jobId == "<job id>")'
```

The job id is the one in `crove_jobs.job` (`SELECT id, name, state FROM crove_jobs.job WHERE name = 'finance-file-extract' ORDER BY created_on DESC LIMIT 10`). A job triggered by a request does not carry that request's id: find the request by its time and org, and the job by its org and queue.

## 4. The slowest queries

The database container loads `pg_stat_statements` (the compose file starts PostgreSQL with `shared_preload_libraries=pg_stat_statements`). Two one-time steps on a database that existed before this setting:

1. Recreate the container so it starts with the preload: `docker compose up -d db` (the data volume stays; the API and the worker reconnect).
2. Create the extension in the application database, once: `docker compose exec db psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"`. A database created from scratch needs the same line once. Because it runs as the superuser outside the migration pipeline, the DDL watch records it as out-of-pipeline DDL (`out_of_pipeline_ddl`) and the worker posts a security alert for that session: expected, and the one you caused; match it to this step (docs/runbooks/incidents.md).

Then read the slowest statements by total time (the extension normalizes a SELECT, INSERT, UPDATE or DELETE: constants are replaced by `$1`, `$2`, so no value of a row is stored; utility statements such as `ALTER ROLE ... PASSWORD '...'` are not tracked at all, because the compose file sets `pg_stat_statements.track_utility=off`: they are kept as written, and `migrate` sets the role passwords that way):

```sh
docker compose exec db psql -U postgres -c "SELECT calls, round(total_exec_time::numeric) AS total_ms, round(mean_exec_time::numeric, 1) AS mean_ms, rows, left(query, 120) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15"
```

Sort by `mean_exec_time` for the statements that are slow each time, by `calls` for the chattiest. Start a clean window before a test (a load run, a month-end close) with `SELECT pg_stat_statements_reset()`. The statistics are in memory and survive a restart only through the extension's own file, so they say little about last month.

The managed or hosted database of a deployment that is not this compose file needs the extension enabled by its provider (the setting above is the compose file's; hosted PostgreSQL usually has it in a console).

## 5. Pool sizes

Each process keeps a pool of database connections: `DATABASE_POOL_MAX` for the API (the app login) and `WORKER_DATABASE_POOL_MAX` for the worker, both 10 by default. Raise one when requests or jobs wait for a free connection, which shows as many fast queries in `pg_stat_statements` with a slow request in the access line. The sum over every API and worker process, plus the queue's own pool (pg-boss opens up to 10 connections per worker process, a size this setting does not change) and Supabase Auth's, must stay under the database's `max_connections` (100 by default): `docker compose exec db psql -U postgres -c "SHOW max_connections"`. A bigger pool on a busy database slows it down; change one number at a time.
