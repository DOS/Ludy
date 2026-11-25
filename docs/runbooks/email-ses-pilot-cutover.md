<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: Amazon SES v2 pilot email cutover (`ap-southeast-1`)

How to switch outbound email on the pilot deployment to official Amazon SES v2 (`MAIL_PROVIDER=ses`, issue `#4960`, [ADR-0034](../adr/0034-outbound-email.md)), wire verified AWS SNS bounce/complaint/delivery webhooks (`/webhooks/mail/ses`), configure separate SES SMTP credentials for bundled Supabase Auth, verify end-to-end with the AWS SES Mailbox Simulator, and roll back cleanly if needed.

> **Production / pilot gate:** Every command that touches the pilot host, DNS records, IAM keys, or `/opt/ludy/.env` is a production step. Present the concrete step list to the owner and wait for explicit approval in the coordinator chat before running it ([contributing.md](../contributing.md#production-secret-and-credential-steps)). Never paste credentials, secret keys, or private host details into issues, PRs, or logs.

## Overview

Ludy has two outbound email paths that share `SMTP_FROM` on the verified `ludy.vn` domain:

1. **Ludy kernel & module mail (`MAIL_PROVIDER=ses`):** Invites, notifications, quotes, eSign links, and reports sent by `api` and `worker` over HTTPS (`POST https://email.ap-southeast-1.amazonaws.com/v2/email/outbound-emails`) signed with AWS SigV4, plus delivery/bounce/complaint events received from Amazon SNS at `POST https://<PUBLIC_DOMAIN>/webhooks/mail/ses`.
2. **Bundled Supabase Auth (`auth` service):** Sign-up confirmations, password resets, magic links, and auth invites sent by GoTrue using `GOTRUE_SMTP_*` (mapped from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` in `docker-compose.yml`). GoTrue only speaks SMTP, so it uses separate Amazon SES SMTP credentials on `email-smtp.ap-southeast-1.amazonaws.com:587`.

## Prerequisites

- AWS account with **Amazon SES production sending approved in `ap-southeast-1`** (e.g. 50,000 messages/day, 14 messages/sec).
- DNS access for `ludy.vn`.
- Pilot host running a Ludy release containing `#4960` (`MAIL_PROVIDER=ses` support), deployed behind HTTPS (`PUBLIC_URL=https://<PUBLIC_DOMAIN>`).

## 1. Verify `ludy.vn` in Amazon SES (`ap-southeast-1`)

In the AWS Console (region **Asia Pacific (Singapore) `ap-southeast-1`**) -> **Amazon SES** -> **Identities** -> **Create identity**:

1. Choose **Domain**, enter `ludy.vn`, and select **Easy DKIM** (`RSA_2048_BIT`).
2. Publish the **3 DKIM `CNAME` records** SES provides in `ludy.vn` DNS (turn proxy off / DNS-only if using Cloudflare, so `CNAME` resolution reaches AWS DKIM keys).
3. **Custom `MAIL FROM` domain (recommended vs default):**
   - **Option A (recommended, custom `MAIL FROM`):** Configure a dedicated unused subdomain such as `bounce.ludy.vn` with behavior on failure `USE_DEFAULT_VALUE`, and publish:
     - `bounce.ludy.vn` `MX` `10 feedback-smtp.ap-southeast-1.amazonses.com`
     - `bounce.ludy.vn` `TXT` `"v=spf1 include:amazonses.com ~all"`
     Custom `MAIL FROM` aligns the envelope sender (`SPF`) with `ludy.vn` and avoids `via amazonses.com` labels in mail clients. Never use the root domain `ludy.vn` or your `INBOUND_DOMAIN` subdomain as `MAIL FROM` (their `MX` records must stay intact).
   - **Option B (default `amazonses.com`):** Skip the custom `MAIL FROM` records; DMARC still passes via `DKIM` alignment on `ludy.vn`.
4. **SPF on `ludy.vn`:** Ensure `ludy.vn` has a single `v=spf1` `TXT` record that includes `include:amazonses.com` (merge into any existing `v=spf1` record rather than adding a second `TXT` record).
5. **DMARC on `_dmarc.ludy.vn`:** If not already published, start with monitoring mode:
   - `_dmarc.ludy.vn` `TXT` `"v=DMARC1; p=none; rua=mailto:<dmarc-aggregate-mailbox>; adkim=r; aspf=r"`
   - Move to `p=quarantine` after confirming aggregate DMARC reports pass.
6. Verify DNS propagation and SES identity status before proceeding:

```bash
dig +short CNAME <dkim-token-1>._domainkey.ludy.vn
dig +short TXT _dmarc.ludy.vn
aws sesv2 get-email-identity --region ap-southeast-1 --email-identity ludy.vn \
  --query '{Verified:VerifiedForSendingStatus,DkimStatus:DkimAttributes.Status,MailFromStatus:MailFromAttributes.MailFromDomainStatus}'
```

Expected: `Verified: true` and `DkimStatus: "SUCCESS"`.

## 2. Create least-privilege IAM credentials for `MAIL_PROVIDER=ses`

Create a dedicated IAM user for the Ludy kernel (`ludy-pilot-ses-sender`) with **no console access**, **no S3 permissions**, and **only** `ses:SendEmail` / `ses:SendRawEmail` scoped to the `ludy.vn` identity (and the Configuration Set ARN created in section 3):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendViaVerifiedDomainIdentity",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail"
      ],
      "Resource": [
        "arn:aws:ses:ap-southeast-1:<aws-account-id>:identity/ludy.vn",
        "arn:aws:ses:ap-southeast-1:<aws-account-id>:configuration-set/ludy-pilot"
      ]
    }
  ]
}
```

Generate one programmatic access key pair (`SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY`) and store it in the owner's secret store. Never reuse S3 bucket credentials or root keys.

## 3. Create SNS topic and SES Configuration Set (`ap-southeast-1`)

1. In **Amazon SNS** (`ap-southeast-1`), create a **Standard** topic named `ludy-pilot-ses-events`. Record its ARN (`SES_SNS_TOPIC_ARN=arn:aws:sns:ap-southeast-1:<aws-account-id>:ludy-pilot-ses-events`).
   - Keep the topic access policy restricted so only Amazon SES in your AWS account (`aws:SourceAccount` = `<aws-account-id>`) can publish to it.
   - Do **not** subscribe the HTTPS endpoint yet until step 5 brings `/webhooks/mail/ses` online.
2. In **Amazon SES** (`ap-southeast-1`) -> **Configuration sets**, create `ludy-pilot` (`SES_CONFIGURATION_SET=ludy-pilot`).
3. Inside `ludy-pilot`, add an **Event destination**:
   - Destination type: **Amazon SNS**
   - Topic: `ludy-pilot-ses-events`
   - Event types: select **`Delivery`**, **`Bounce`**, **`Complaint`**, and **`Delivery delay`** (`Delivery`, `Bounce`, `Complaint`, `DeliveryDelay`). Leave `Send`, `Open`, `Click` unselected (Ludy ignores them safely if enabled, so excluding them reduces webhook noise).

## 4. Create separate SES SMTP credentials for Supabase Auth

Bundled Supabase Auth (`auth`) sends sign-up confirmations, password resets, and magic links over SMTP (`GOTRUE_SMTP_*` via `SMTP_*`).

1. In **Amazon SES** (`ap-southeast-1`) -> **SMTP settings**, choose **Create SMTP credentials**.
2. Name the dedicated IAM user (e.g. `ludy-pilot-ses-smtp`, separate from `ludy-pilot-ses-sender`).
3. Save the generated SMTP username (`SMTP_USER`) and SMTP password (`SMTP_PASS`) in the owner's secret store.
   - Note: SES SMTP passwords are derived differently from raw IAM secret keys; always use the SMTP password generated by SES (never put `SES_SECRET_ACCESS_KEY` into `SMTP_PASS`).
4. SMTP endpoint for `ap-southeast-1`:
   - `SMTP_HOST=email-smtp.ap-southeast-1.amazonaws.com`
   - `SMTP_PORT=587` (STARTTLS)

## 5. Update `/opt/ludy/.env`, recreate services, and subscribe SNS

1. Back up `/opt/ludy/.env` on the pilot host with mode `600` (inside `.deploy/` or a root/deploy-owned backup path, never world-readable):

```bash
umask 077
cp /opt/ludy/.env "/opt/ludy/.env.bak-$(date -u +%Y%m%dT%H%M%SZ)"
```

2. Update the mail variables in `/opt/ludy/.env` (keep `SMTP_FROM` on a verified `ludy.vn` address, e.g. `Ludy <noreply@<verified-domain>>`):

```dotenv
# Bundled Supabase Auth SMTP (SES SMTP credentials from section 4)
SMTP_HOST=email-smtp.ap-southeast-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=<ses-smtp-username>
SMTP_PASS=<ses-smtp-password>
SMTP_FROM=Ludy <noreply@<verified-domain>>

# Ludy kernel & module mail (SES v2 HTTP API + SNS webhooks)
MAIL_PROVIDER=ses
SES_REGION=ap-southeast-1
SES_ACCESS_KEY_ID=<ses-api-access-key-id>
SES_SECRET_ACCESS_KEY=<ses-api-secret-access-key>
SES_CONFIGURATION_SET=ludy-pilot
SES_SNS_TOPIC_ARN=arn:aws:sns:ap-southeast-1:<aws-account-id>:ludy-pilot-ses-events
```

3. Validate preflight checks and recreate `worker`, `api`, and `auth` (worker before API, per [deploy.md](deploy.md)):

```bash
cd /opt/ludy
docker compose up -d worker
docker compose up -d api auth
```

4. Confirm startup logs and readiness:

```bash
docker compose logs --tail=50 api | grep '\[mail\]'    # [mail] Amazon SES (ap-southeast-1)
docker compose logs --tail=50 worker | grep '\[mail\]' # [mail] Amazon SES (ap-southeast-1)
curl -fsS https://<PUBLIC_DOMAIN>/readyz
```

5. Now subscribe the webhook in **Amazon SNS** (`ap-southeast-1`) -> Topic `ludy-pilot-ses-events` -> **Create subscription**:
   - Protocol: **HTTPS**
   - Endpoint: `https://<PUBLIC_DOMAIN>/webhooks/mail/ses`
   - **Enable raw message delivery:** **unchecked / false** (required so SNS sends the signed JSON envelope `SubscriptionConfirmation` and `Notification`).
6. Ludy verifies the `SubscriptionConfirmation` signature against the `sns.ap-southeast-1.amazonaws.com` certificate and fetches `SubscribeURL` automatically (`200`). Confirm in AWS SNS within 30 seconds:

```bash
aws sns list-subscriptions-by-topic --region ap-southeast-1 \
  --topic-arn "arn:aws:sns:ap-southeast-1:<aws-account-id>:ludy-pilot-ses-events" \
  --query 'Subscriptions[*].{Endpoint:Endpoint,Status:SubscriptionArn}'
```

Expected: `SubscriptionArn` is an ARN (no longer `"PendingConfirmation"`).

7. Run `pilot:check` from a checkout with the pilot `.env` (or in the deployment tool environment):

```bash
pnpm pilot:check -- --url https://<PUBLIC_DOMAIN>
```

Expected: `Outbound mail`, `Email confirmation and MFA step-up`, and `Secrets` all report `PASS`, and `0` checks report `FAIL`.

## 6. Verify with Amazon SES Mailbox Simulator

Test both paths without emailing external mailboxes, using a dedicated internal test org (never a customer org, because the bounce simulator inserts a `mail_suppression` row for that org):

1. **Delivered (`success@simulator.amazonses.com`):**
   - Trigger a transactional mail (e.g. test invite in the internal test org) to `success@simulator.amazonses.com`.
   - Confirm `ludy_kernel.mail_message` moves to `status = 'sent'` (with `provider = 'ses'` and `provider_message_id`), then after SNS delivers the `Delivery` notification, moves to `status = 'delivered'` with a `ludy_kernel.mail_event` row (`kind = 'delivered'`).
2. **Hard bounce (`bounce@simulator.amazonses.com`):**
   - Trigger a mail in the internal test org to `bounce@simulator.amazonses.com`.
   - Confirm `ludy_kernel.mail_event` records `kind = 'bounce_hard'`, `ludy_kernel.mail_message.status = 'bounced'`, and `ludy_kernel.mail_suppression` records `scope = 'all'`, `reason = 'hard_bounce'`.
   - Trigger a second mail to `bounce@simulator.amazonses.com` in the same test org and confirm `mail_message.status = 'suppressed'` (blocked locally without calling SES).
3. **Complaint (`complaint@simulator.amazonses.com`):**
   - Trigger a mail in the internal test org to `complaint@simulator.amazonses.com`.
   - Confirm `ludy_kernel.mail_event` records `kind = 'complaint'`, `ludy_kernel.mail_message.status = 'complained'`, and `ludy_kernel.mail_suppression` records `scope = 'marketing'`, `reason = 'complaint'`.
4. **Supabase Auth SMTP check:**
   - Send a password recovery or confirmation email to a controlled test mailbox and verify it arrives via `email-smtp.ap-southeast-1.amazonaws.com` with passing SPF, DKIM (`ludy.vn`), and DMARC headers.
5. **Audit logs for zero PII leakage:**
   - Check `docker compose logs api worker` around the tests and verify no recipient email address, subject, or invite token appears in any log line.

## 7. Rollback to previous SMTP provider

If SES fails verification, hits unexpected rejections, or SNS delivery issues prevent cutover:

1. Restore `/opt/ludy/.env` from the pre-cutover backup (or switch `MAIL_PROVIDER=smtp` and restore the previous `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` values):

```bash
cp /opt/ludy/.env.bak-<timestamp> /opt/ludy/.env
chmod 600 /opt/ludy/.env
```

2. Recreate `worker`, `api`, and `auth`:

```bash
cd /opt/ludy
docker compose up -d worker
docker compose up -d api auth
```

3. Verify the rollback:

```bash
docker compose logs --tail=30 api | grep '\[mail\]'    # [mail] SMTP at <previous-host>:<port>
docker compose logs --tail=30 worker | grep '\[mail\]' # [mail] SMTP at <previous-host>:<port>
curl -fsS https://<PUBLIC_DOMAIN>/readyz
pnpm pilot:check -- --url https://<PUBLIC_DOMAIN>
```

4. Note: Existing `ludy_kernel.mail_message` rows already sent via SES retain `provider = 'ses'` and their `provider_message_id` (immutable). New sends route immediately through the restored SMTP provider. Once rolled back, delete or pause the SNS HTTPS subscription if you do not keep `/webhooks/mail/ses` active.
