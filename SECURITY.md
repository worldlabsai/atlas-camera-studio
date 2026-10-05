# Security

Please report a suspected vulnerability privately to support@worldlabs.ai rather than including credentials or customer content in a public issue.

For your own deployment:
- Keep World Labs, Clerk, and Stripe secret keys on the server.
- Use hosted mode and HTTPS for any shared deployment.
- Keep the SQLite data directory and phone-hash secret private and persistent.
- Verify Stripe webhook signatures; never grant credits from a redirect or a browser claim.
- Run a single app instance per SQLite database and keep dependencies updated.
