-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3885, S2b of #3854): the queue of one MISA AMIS connection's test. Idempotent; applied files stay untouched.
--
-- finance-misa-amis-test runs one connection: open the access code, ask AMIS for a token and the company's information through the egress guard, and record only the state the answer
-- stands for (finance.misa_amis_connection.record_test: works, wrong_credentials, unreachable). finance.misa_amis_connection.test_requested queues a connection the moment an owner or admin
-- asks; nothing else queues it. The test reads (a token, the company's information): it changes nothing in AMIS.
SET LOCAL lock_timeout = '2s';

SELECT crove_jobs.create_queue('finance-misa-amis-test', '{"policy":"exclusive","deadLetter":"kernel-job.dlq"}'::jsonb);
