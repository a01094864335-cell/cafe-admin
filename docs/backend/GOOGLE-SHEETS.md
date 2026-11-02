# Google Sheets automatic mirror

The owner opens 자료 이전 · 백업 → 구글 시트 만들고 연결. The existing Google account consents to `drive.file` with offline access. The app creates one private spreadsheet with the same 14 business tabs as XLSX export. Reauthorization reuses the existing spreadsheet. Disconnect removes stored credentials and pending authorization, retaining the Google file. Site edits overwrite the managed tabs; additional user tabs are preserved. This is a one-way mirror, not a backup/restore format or two-way editing.

## Authorization and storage

The existing `/auth/google/callback` is reused. Dedicated state is browser-, session-, owner- and cafe-bound, single-use, ten-minute expiry, with PKCE and an ID-token nonce. The Google subject must match the signed-in site user. CSRF and owner guards protect all link mutations. Stored refresh tokens use AES-GCM with cafe AAD and an HKDF domain-separated key derived from `INVITATION_TOKEN_KEY`; this key must be preserved during deployment and recovery. Rotating it requires reconnecting links. Tokens never reach client responses or logs. No Google sharing permissions are added.

## Reliable delivery

Migration `0006_google_sheets.sql` adds the link/outbox and OAuth transaction tables. A trigger on `cafes.revision` queues changes in the same transaction as the business write, including import commits and soft deletes. `waitUntil` starts a sync after successful cafe mutations; a minute cron catches interruptions and retries. Keep the existing hourly cleanup cron as well. The Google failure does not fail the saved business transaction.

An atomic D1 snapshot covers the active dataset and revision. A five-minute CAS lease serializes writers. One Sheets batch updates all tabs atomically, clears stale values, freezes headers and applies readable formatting. Explicit string values prevent spreadsheet formula injection. Pending newer revisions remain queued; failures back off to one hour. After uncertain Google timeouts the lease remains until five minutes, exceeding Google's documented 180-second processing window. Ownership is checked before reading and again before writing.

Limits: 10,000 rows per table, 2MiB serialized batch, five pending cafes per cron tick. A large snapshot is reported in the UI instead of truncating data. Google scopes/expired grants, deleted files, ownership changes and transient failures appear as actionable statuses. Disconnect cannot recall an already accepted in-flight Google request.

## Deployment

1. Apply 0006 to the actual `cafe-admin-test` D1 database (the existing user-facing installation). The migration is additive, with no business-data rewrite.
2. Preserve `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INVITATION_TOKEN_KEY`, and `APP_ORIGIN`; deploy with `--keep-vars`.
3. Configure crons `["17 * * * *", "* * * * *"]`. Version rollback must retain 0006; its trigger is harmless with the previous Worker.
4. Enable Sheets API in Google project `cafe-admin-511011`. No new redirect URI is required.
5. Google OAuth currently has Testing publication status (confirmed 2026-11-02). Offline grants with `drive.file` can expire after seven days in Testing. Production publication requires completing Google Branding configuration; do not promise permanent unattended sync until resolved. Reconnect is supported in the meantime.
6. The owner must explicitly consent to the new Google file permission. Feature deployment alone does not create a spreadsheet or grant access.

## Verification

`tests/server/google-sheets.d1.mjs` exercises owner/CSRF restrictions, offline narrow scope, encrypted token isolation, committed outbox revisions, same-file reconnect, one-use OAuth, account mismatch, active-dataset isolation, simultaneous sync, overlapping edits, soft-delete clearing, formula-like text, failed grants and owner changes. Existing cloud browser integration checks the new disconnected panel alongside JSON/XLSX downloads. Run `pnpm check:backend` and `PLAYWRIGHT_CHANNEL=chrome pnpm test:cloud` before deployment.
