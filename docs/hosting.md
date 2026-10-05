# Hosted setup

Use a single application instance with a persistent local disk. SQLite stores credit balances, phone-claim hashes, payments, and resumable jobs. An ephemeral filesystem or multiple independent replicas will lose or split this state.

## Authentication

Create a dedicated Clerk application. Enable email sign-in and phone numbers with verification. The backend checks Clerk's verified phone status before accepting work; an unverified phone string is never sufficient. Phone support in production may require a paid Clerk plan.

Set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` for the same instance. Configure its production domain to match `APP_ORIGIN`. Enable Clerk's bot protection and review allowed SMS countries to bound SMS abuse.

Generate `PHONE_HASH_SECRET` once using `openssl rand -hex 32`. Store it securely and retain it across redeployments and database restores. It HMACs normalized phone numbers so the app does not store raw numbers. Rotating this secret without migrating existing claims would allow phones to claim another trial.

## Stripe

Use one Stripe account, a one-time USD $5 Price, and Stripe Checkout. Existing account API credentials may be reused when their permissions permit these operations. Never reuse another endpoint's webhook signing secret.

1. Create a product named Marble Camera Studio, with one-time price $5 for three generations.
2. Set `STRIPE_SECRET_KEY` and the resulting `STRIPE_PRICE_ID`.
3. Create an endpoint at `https://YOUR_DOMAIN/api/stripe/webhook`.
4. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, and `charge.dispute.created`.
5. Put that endpoint's signing secret in `STRIPE_WEBHOOK_SECRET`.

Use test-mode keys and Stripe's test cards for the first pass. Test unpaid, duplicate, invalid-signature, and full-refund cases. Then use a dedicated live product/price and endpoint. A success-page redirect does not grant credits; only a verified paid webhook does.

Full refunds or disputes remove the pack's credits, even if that makes a balance negative after credits were spent. Partial refunds require an operator decision about credits. Do not expose unrestricted partial refunds to customers.

No subscriptions, metering vendor, or automatic top-ups are involved. The pack price is intentionally simple and may subsidize API costs.

## Deployment

Set all variables documented in `.env.example`, including `APP_MODE=hosted`, an HTTPS `APP_ORIGIN`, and `DATA_DIR` on persistent storage. Set `REPOSITORY_URL` when the public source repository is available.

```sh
docker build -t marble-camera-studio .
docker run --init --restart unless-stopped \
  --env-file /secure/camera-studio.env \
  -v camera-studio-data:/data \
  -p 127.0.0.1:3030:3030 \
  marble-camera-studio
```

Put a managed HTTPS reverse proxy in front of the app. Route the Stripe endpoint to this same instance. Restrict access to the disk and environment file; back up the SQLite database using its online backup API rather than copying a live WAL database file alone. Restore the database and phone-hash secret together.

Default limits: one active job per user; six scene-depth requests and ten generations per user per UTC day; 300 generations and 900 total jobs per day across the demo. Limits count attempts, including failures, to bound repeated costly retries. A phone number makes repeated free accounts harder; it does not eliminate abuse.

Do not launch without exercising the full hosted path: email sign-in, verified phone, three free generations, exhausted-credit block, test-mode purchase, webhook crediting, restart recovery, failed-task refund, and MP4 download. Have a second person run the same path before announcing it.
