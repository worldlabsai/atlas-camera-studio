# Hosted setup

Use a single application instance with a persistent local disk. SQLite stores credit balances, phone-claim hashes, payments, and resumable jobs. An ephemeral filesystem or multiple independent replicas will lose or split this state.

## Authentication

Create a dedicated Clerk application. Collect email addresses without requiring email verification, and enable phone sign-in with required SMS verification. The backend checks Clerk's verified phone status before accepting work; an unverified phone string is never sufficient. Phone support in production may require a paid Clerk plan.

Set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` for the same instance. Configure its production domain to match `APP_ORIGIN`. Enable Clerk's bot protection and review allowed SMS countries to bound SMS abuse.

Generate `PHONE_HASH_SECRET` once using `openssl rand -hex 32`. Store it securely and retain it across redeployments and database restores. It HMACs normalized phone numbers so the app does not store raw numbers. Rotating this secret without migrating existing claims would allow phones to claim another trial.

## Stripe

Use one Stripe account, a one-time USD $5 Price for three generations, and Stripe Checkout. The app offers fixed quantities of this price: 1 ($5 / 3 generations), 4 ($20 / 12), and 20 ($100 / 60). No additional Stripe products or prices are needed. Existing account API credentials may be reused when their permissions permit these operations. Never reuse another endpoint's webhook signing secret.

Prefer an app-specific restricted key. The running app needs Checkout Sessions read/write and Charges read access, plus any dependencies Stripe requires for those permissions. Create the product, price, and webhook endpoint separately in the dashboard. Test restricted keys (`rk_test_`) and standard test keys (`sk_test_`) both work for a loopback HTTP preview; live keys require HTTPS.

1. Create a product named Atlas Camera Studio, with one-time price $5 for three generations.
2. Set `STRIPE_SECRET_KEY` and the resulting `STRIPE_PRICE_ID`.
3. Create an endpoint at `https://YOUR_DOMAIN/api/stripe/webhook`.
4. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, and `charge.dispute.created`.
5. Put that endpoint's signing secret in `STRIPE_WEBHOOK_SECRET`.

Use test-mode keys and Stripe's test cards for the first pass. Test unpaid, duplicate, invalid-signature, and full-refund cases. Then use a dedicated live product/price and endpoint. A success-page redirect does not grant credits; only a verified paid webhook does.

Full refunds or disputes remove the pack's credits, even if that makes a balance negative after credits were spent. Partial refunds require an operator decision about credits. Do not expose unrestricted partial refunds to customers.

No subscriptions, metering vendor, or automatic top-ups are involved. The pack price is intentionally simple and may subsidize API costs.

## Deployment

Set all variables documented in `.env.example`, including `APP_MODE=hosted`, an HTTPS `APP_ORIGIN`, and `DATA_DIR` on persistent storage. The header links to the public source repository. Set `REPOSITORY_URL` to your own repository when hosting a fork.

```sh
docker build -t atlas-camera-studio .
docker run --init --restart unless-stopped \
  --env-file /secure/camera-studio.env \
  -v camera-studio-data:/data \
  -p 127.0.0.1:3030:3030 \
  atlas-camera-studio
```

Put a managed HTTPS reverse proxy in front of the app. Route the Stripe endpoint to this same instance. Restrict access to the disk and environment file; back up the SQLite database using its online backup API rather than copying a live WAL database file alone. Restore the database and phone-hash secret together.

Completed job inputs, generated-media references, and local videos are removed seven days after submission, with hourly cleanup in batches of 100. Active jobs and source poses used by active generations are retained until work finishes. Phone claims, credit balances, payment receipts, and expired-job identifiers remain for abuse prevention and idempotency. This cleanup applies to the app's live storage; backup retention and the upstream API's retention policy are separate.

Default limits: at most two jobs run concurrently across all users, with one FFmpeg thread per video; additional jobs wait in the persistent queue and resume after a restart. One active job per user; six scene-depth requests and ten generations per user per UTC day; 300 generations and 900 total jobs per day across the demo. Limits count attempts, including failures, to bound repeated costly retries. A phone number makes repeated free accounts harder; it does not eliminate abuse.

Do not launch without exercising the full hosted path: phone sign-in, verified phone, three free generations, exhausted-credit block, test-mode purchase, webhook crediting, restart recovery, failed-task refund, and MP4 download. Have a second person run the same path before announcing it.
