# Council onboarding — new tenant in production

For deployment owners bringing a local council or community organisation onto
BlakPath. Data residency stays `ap-southeast-2` throughout.

## 1. Create tenant

1. Insert `organisations` row: `organisationType='council'`, status `onboarding`,
   region `ap-southeast-2`, slug reserved.
2. Seed system roles + permission catalogue (`pnpm db:seed` covers platform
   defaults; tenant clones roles on first admin sign-in).
3. Create teams (Intake, Casework, Committee support) and groups via
   `/settings/teams` or `POST /api/teams`, `/api/groups`.
4. Record consent wording + evidence requirements in `organisation_settings`.

## 2. Identity

- Invite staff via membership invitations (hash-only tokens, verified email).
- Assign team/group memberships. Verify deny-by-default with
  `tests/e2e/team-isolation.spec.ts` against staging.
- Optional SSO: register provider (`src/lib/auth/sso-provider.ts`), add
  binding `POST /api/sso/providers`, verify domain in `organisation_domains`,
  then enable. SCIM maps onto membership status transitions.

## 3. Go live

1. Complete `docs/production-readiness.md` release gate in exact EKS images.
2. Run EKS restore drill (`docs/eks-runbook.md`), attach record.
3. Flip status to `active`, open `publicApplicationsOpen` when ready.
4. Confirm audit chain clean, alarms firing to on-call, SES suppression flow
   wired (`POST /api/email/events` reachable from SNS).

## 4. Legacy import

Staff open **Settings → Legacy import** (`/settings/imports`), choose a CSV and
run **Check file (dry run)**. The dry run validates every row, reports rows that
are already in BlakPath and rows with problems, and writes nothing. **Start
import** stages the file and the `import` worker queue imports it in chunks of
250 rows, recording progress (`GET /api/imports/{id}`). Up to 10,000 rows / 5 MB
per file; split larger migrations.

- **Idempotent.** Every row needs `external_reference` (the matter's id in the
  previous system), unique per organisation. Re-running the same file — or a
  worker retry resuming mid-file — skips rows already imported, never
  duplicates them.
- **Columns.** `external_reference`, `applicant_name` (required); `priority`,
  `status`, `submitted_on`, `decided_on`, `withdrawn_on`, `withdrawn_reason`,
  `closed_on`, `outcome`, `outcome_recorded_by`, `outcome_note`,
  `certificate_reference`, `certificate_issued_on`, `certificate_revoked_on`,
  `certificate_revoked_reason`, and any `intake.<field>`. Dates are
  `YYYY-MM-DD`. Unknown columns reject the file.
- **Historical status and recorded outcomes.** The matter keeps its historical
  status (status history action `legacy_import`). An `outcome` copies a
  determination authorised humans already recorded before BlakPath: it needs
  status `decided`/`closed`, `decided_on` and `outcome_recorded_by`, and is
  stored as a finalised decision flagged `recorded_before_blakpath`. The import
  never computes or infers an outcome.
- **Legacy certificates.** A `certificate_reference` (with a `confirmed`
  outcome and `certificate_issued_on`) creates a certificate flagged
  `issued_before_blakpath`. It has no PDF and no BlakPath digital seal; staff
  share its verification page from the case, and `/verify/{code}` reports it
  as "issued before BlakPath". Revoked legacy certificates import as revoked.
- **Permissions.** `application:create` + `application:read-any` to import
  matters; files with outcomes also need `decision:finalise`, files with
  certificates also need `certificate:sign`. The worker re-checks the
  requester's live membership and permissions before writing.
- **Audit.** `import.validated`, `import.requested`, one
  `application.imported` / `decision.imported` / `certificate.imported` per
  record, then `import.completed` or `import.failed`. Staged rows are cleared
  when the job settles.

Evidence files are not part of the CSV import; migrate them through the normal
upload path so they are quarantined and malware-scanned.
