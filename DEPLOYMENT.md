# Ubuntu/Debian VPS Deployment

This is a single-instance preview deployment. Use a domain pointed to the VPS, allow inbound TCP 80/443, and install Docker Engine with the Compose plugin.

For the local development → GitHub → server update workflow, see [GITHUB_DEPLOYMENT.md](GITHUB_DEPLOYMENT.md). Server-side AI configuration saved from the dashboard is persisted in `data/ai-config.json` through the existing data mount.

## Configure

1. Copy the project to the server. Do not copy local `ai-config.json`, `.env`, `data/`, or `node_modules/`.
2. Create `.env` containing `DOMAIN=your-domain.example` for Compose variable substitution.
3. Copy `.env.production.example` to `.env.production`; set a unique administrator password, the server-side model API key, and the final `PUBLIC_BASE_URL`. Restrict both files to the deployment operator (`chmod 600 .env .env.production`). The administrator password is used to seed the account only once; change it from the signed-in studio settings afterward. Restarting the container will not replace an existing password. Keep WeChat login and payment secrets out of Git, backups shared with third parties, browser code, and support screenshots.
4. Confirm DNS A/AAAA records point to this server and remove any stale AAAA record. Open TCP ports 80 and 443 in both cloud firewall and host firewall.
5. Create the persistent database folder and give it to the container's non-root Node user (`mkdir -p data && chown 1000:1000 data`).

## Start

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app caddy
```

Open `https://your-domain.example/admin`, sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, create or invite test accounts, and set the membership prices, durations, and AI call allotments in the membership-plan section. Free accounts default to 10 calls monthly and member accounts to 300; change the limits in `.env.production` and recreate the app container to apply them.

## WeChat website login and payment

1. Complete the required merchant and website-app approvals with WeChat Open Platform and WeChat Pay. Set the callback domain to the final HTTPS hostname. Each login identity is stored as a distinct account. Use `WECHAT_ALLOW_REGISTRATION=false` to restrict first-time sign-up; an existing user can then bind their WeChat account from the signed-in studio.
2. Put the production Open Platform website app credentials in `WECHAT_LOGIN_APP_ID` and `WECHAT_LOGIN_APP_SECRET`. The website requires a reachable HTTPS callback at `/api/auth/wechat/callback`.
3. Configure WeChat Pay APIv3 Native QR merchant details: the matching `WECHAT_PAY_APP_ID`, merchant ID and API certificate serial, base64-encoded API private-key PEM, the current platform certificate or public-key PEM and its exact serial, and the 32-byte UTF-8 APIv3 key. Point `WECHAT_PAY_NOTIFY_URL` at `https://your-domain.example/api/pay/wechat/notify`. Never paste credentials or certificates in a browser or commit them to the project.
4. Restart the application and verify `/admin` reports both approved login and payment credentials configured. Add a low-priced test plan from the admin dashboard, place a genuine test purchase under the merchant's authorized test procedure, and confirm the signed payment notification changes that user's order to paid and grants exactly the purchased days and calls. Verify invalid signatures, wrong amount, duplicate notifications, and a refused/canceled transaction before enabling public checkout.
5. User-initiated automatic renewals and in-site payment refunds are not implemented. Refunds must be processed through the authorized merchant workflow and the related membership must be reconciled by an administrator.

The store leaves checkout disabled when the verified HTTPS callback, merchant ID, RSA keys, platform serial, or APIv3 key is missing. Keep checkout closed until the merchant has verified callbacks end to end; setting a package price alone cannot accept payments.

## Backups and restore

Create an online SQLite snapshot (the script retains the newest 14 snapshots):

```sh
docker compose exec app node scripts/backup.cjs
```

Copy `data/backups/` off the VPS as well. For restore, stop the app, preserve a copy of `data/`, replace `data/youshu.sqlite` with a verified snapshot, then start the stack. Test restore before inviting users. Backups on the same VPS do not protect against disk or account loss.

## Current launch boundary

- Accounts are created by an administrator by default; first-time WeChat sign-up is independently controlled by `WECHAT_ALLOW_REGISTRATION`. Email verification is not implemented.
- Admin membership grants are for testing. Signed WeChat Native QR checkout, payment-notification verification/decryption, amount checks, order idempotency, plan pricing, and dashboard order display are implemented. Real acceptance requires the merchant credentials and a live end-to-end signed-notification test; automatic refunds are not implemented.
- Existing browser-only work can be exported from the old local site and imported after logging into the new account. User account data and conversations then sync to that account's cloud record.
- SQLite is intended for one application instance on persistent storage. Do not run multiple app replicas against this database. Move to PostgreSQL before horizontal scaling or higher concurrent write load.
- No public registration, password reset/email verification, automated recurring billing, or legal/ICP launch review is included. The overseas VPS choice may not satisfy mainland China hosting or ICP requirements.
- Configure an external uptime check and off-site encrypted backup before production use. Caddy obtains and renews HTTPS certificates after DNS and firewall are correct.
