-- SPDX-License-Identifier: AGPL-3.0-only
-- The publish queue of the WhatsApp provider (#3131), as for every other channel provider: one queue for each id in CHANNEL_PROVIDERS (the job tests count them).
-- Nothing publishes to WhatsApp, so the queue stays empty; the provider is a messaging channel of the conversation core only.
SELECT crove_jobs.create_queue('social-publish-whatsapp', '{"policy":"stately","expireInSeconds":300}'::jsonb);
