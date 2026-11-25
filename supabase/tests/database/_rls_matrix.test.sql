-- RLS matrix smoke (plan §10 G3, issue #1627): one tenant table, crove_kernel.party, probed as the API login role
-- crove_app, without a context and in the sealed context of org A, against a party of org B. The generated matrix over
-- every table and every runtime role is apps/kernel/test/invariant/rls-matrix.db.test.ts (T8); this file shows the
-- same isolation in pgTAP. A gate file: `_*.test.sql` is a protected path.
--
-- plan() runs as the superuser before SET ROLE: pgTAP keeps its state in temporary tables, which Crove roles may not
-- create (T17). The runner rolls the transaction back.
SELECT plan(9);

-- Resolve active kernel schema (crove_kernel or ludy_kernel) and API login role, seed two orgs and parties,
-- sign a context token as the superuser, and enter the API role inside the enclosing runner transaction.
DO $$
DECLARE
  v_kernel text := 'ludy_kernel';
  v_role text := 'ludy_app';
  v_user_a uuid;
  v_user_b uuid;
  v_org_a uuid;
  v_org_b uuid;
  v_token_a text;
BEGIN
  PERFORM pg_catalog.set_config('test.kernel', v_kernel, true);
  PERFORM pg_catalog.set_config('test.app_role', v_role, true);

  EXECUTE pg_catalog.format('SELECT %I.identity_upsert($1, $2, $3, $4)', v_kernel)
    INTO v_user_a USING 'pgtap', 'rls-a', 'rls-a@example.com', 'RLS A owner';
  EXECUTE pg_catalog.format('SELECT %I.identity_upsert($1, $2, $3, $4)', v_kernel)
    INTO v_user_b USING 'pgtap', 'rls-b', 'rls-b@example.com', 'RLS B owner';
  PERFORM pg_catalog.set_config('test.user_a', v_user_a::text, true);
  PERFORM pg_catalog.set_config('test.user_b', v_user_b::text, true);

  EXECUTE pg_catalog.format('SELECT %I.create_or_replay_org($1, $2, $3, $4)', v_kernel)
    INTO v_org_a USING v_user_a, 'pgtap-rls-a', 'pgTAP RLS A', NULL::text;
  EXECUTE pg_catalog.format('SELECT %I.create_or_replay_org($1, $2, $3, $4)', v_kernel)
    INTO v_org_b USING v_user_b, 'pgtap-rls-b', 'pgTAP RLS B', NULL::text;
  PERFORM pg_catalog.set_config('test.org_a', v_org_a::text, true);
  PERFORM pg_catalog.set_config('test.org_b', v_org_b::text, true);

  EXECUTE pg_catalog.format(
    'INSERT INTO %I.party (org_id, id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
    v_kernel
  ) USING v_org_a, '00000000-0000-7000-8000-00000000000a'::uuid, 'Party of A',
          v_org_b, '00000000-0000-7000-8000-00000000000b'::uuid, 'Party of B';

  EXECUTE pg_catalog.format(
    'SELECT m.msg || ''.'' || pg_catalog.encode(pg_catalog.sha256(k.k_opad || pg_catalog.sha256(k.k_ipad || pg_catalog.convert_to(m.msg, ''UTF8''))), ''hex'') '
    || 'FROM (SELECT ''v1.'' || $1 || ''.-.'' || $2 || ''.aal1.-.'' || (pg_catalog.floor(pg_catalog.date_part(''epoch'', pg_catalog.clock_timestamp()))::bigint + 60)::text AS msg) m, %I.context_token_key k '
    || 'WHERE k.slot = ''current''',
    v_kernel
  ) INTO v_token_a USING v_user_a::text, v_org_a::text;
  PERFORM pg_catalog.set_config('test.token_a', v_token_a, true);

  EXECUTE pg_catalog.format('SET LOCAL ROLE %I', v_role);
END $$;

-- The refused inserts name the message, not only 42501, so a lost INSERT grant ("permission denied", also 42501)
-- cannot pass for row-level security. PostgreSQL names a policy in that message only when a RESTRICTIVE one fails;
-- tenant_isolation is PERMISSIVE, so the message names the table alone.

-- No context: nothing is visible and nothing can be written.
SELECT is(
  (pg_catalog.xpath(
    '/table/row/n/text()',
    pg_catalog.query_to_xml(
      pg_catalog.format('SELECT pg_catalog.count(*)::bigint AS n FROM %I.party', pg_catalog.current_setting('test.kernel')),
      false, false, ''
    )
  ))[1]::text::bigint,
  0::bigint,
  'without a context app sees no party'
);
SELECT throws_ok(
  pg_catalog.format(
    $$INSERT INTO %I.party (org_id, id, name) VALUES (%L::uuid, '00000000-0000-7000-8000-0000000000a1', 'No context')$$,
    pg_catalog.current_setting('test.kernel'),
    pg_catalog.current_setting('test.org_a')
  ),
  '42501', 'new row violates row-level security policy for table "party"', 'without a context app inserts no party'
);

-- Org A's context: its own party only.
SELECT is(
  (pg_catalog.xpath(
    '/table/row/v/text()',
    pg_catalog.query_to_xml(
      pg_catalog.format(
        'SELECT %I.enter_user_context(%L::uuid, %L::text)::text AS v',
        pg_catalog.current_setting('test.kernel'),
        pg_catalog.current_setting('test.org_a'),
        pg_catalog.current_setting('test.token_a')
      ),
      false, false, ''
    )
  ))[1]::text,
  'owner',
  'the owner of org A enters its context'
);
SELECT is(
  (pg_catalog.xpath(
    '/table/row/n/text()',
    pg_catalog.query_to_xml(
      pg_catalog.format(
        'SELECT pg_catalog.count(*)::bigint AS n FROM %I.party WHERE org_id = %L::uuid',
        pg_catalog.current_setting('test.kernel'),
        pg_catalog.current_setting('test.org_a')
      ),
      false, false, ''
    )
  ))[1]::text::bigint,
  1::bigint,
  'org A sees its own party'
);
SELECT is(
  (pg_catalog.xpath(
    '/table/row/n/text()',
    pg_catalog.query_to_xml(
      pg_catalog.format(
        'SELECT pg_catalog.count(*)::bigint AS n FROM %I.party WHERE org_id <> %L::uuid',
        pg_catalog.current_setting('test.kernel'),
        pg_catalog.current_setting('test.org_a')
      ),
      false, false, ''
    )
  ))[1]::text::bigint,
  0::bigint,
  'org A sees no party of another org'
);
SELECT throws_ok(
  pg_catalog.format(
    $$INSERT INTO %I.party (org_id, id, name) VALUES (%L::uuid, '00000000-0000-7000-8000-0000000000a2', 'Planted by A')$$,
    pg_catalog.current_setting('test.kernel'),
    pg_catalog.current_setting('test.org_b')
  ),
  '42501', 'new row violates row-level security policy for table "party"', 'org A inserts no party into org B'
);
SELECT lives_ok(
  pg_catalog.format(
    $$UPDATE %I.party SET name = 'Renamed by A' WHERE org_id = %L::uuid$$,
    pg_catalog.current_setting('test.kernel'),
    pg_catalog.current_setting('test.org_b')
  ),
  'an update aimed at org B runs'
);
SELECT lives_ok(
  pg_catalog.format(
    $$DELETE FROM %I.party WHERE org_id = %L::uuid$$,
    pg_catalog.current_setting('test.kernel'),
    pg_catalog.current_setting('test.org_b')
  ),
  'a delete aimed at org B runs'
);

RESET ROLE;

-- ... and touched no row of org B.
SELECT is(
  (pg_catalog.xpath(
    '/table/row/v/text()',
    pg_catalog.query_to_xml(
      pg_catalog.format(
        $$SELECT pg_catalog.string_agg(name, ', ') AS v FROM %I.party WHERE org_id = %L::uuid$$,
        pg_catalog.current_setting('test.kernel'),
        pg_catalog.current_setting('test.org_b')
      ),
      false, false, ''
    )
  ))[1]::text,
  'Party of B',
  'org B keeps its party, unchanged'
);

SELECT * FROM finish();
