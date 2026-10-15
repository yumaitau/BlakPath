# Monthly audit review

A person who holds `audit:view` works through this checklist once each calendar
month, and again after any break-glass activation. The same steps are shown at
`/audit/review`. The sentences below are the source text in
`AUDIT_MONTHLY_REVIEW_CHECKS` (`src/domains/audit/log.ts`).

The software does not determine Aboriginality. This review checks that human
acts were recorded. It does not score, rank, approve or reject anyone.

## Checklist

### Permission denials

Filter the month to denials. Each row is a recorded refusal. Follow up anything
unexplained with the person involved. The log does not decide whether someone is
Aboriginal.

### Break-glass

Filter break-glass events. Every activation needs a human review once the access
window ends. This screen does not approve or close break-glass by itself.

### Exports

Filter the actions export.downloaded and audit.exported. Confirm each bulk take
of records was expected.

### Case sample

Pick cases the organisation worked on and filter by case id. Check that views
and changes match the file. Outcomes stay human acts.

### Administrators

Filter by each organisation administrator. Confirm the actions match their role.

### Chain integrity

Look for audit.chain_verified or audit.divergence_detected in the month. A
divergence is an incident. Do not edit audit rows.

### Record the review

Record who completed this month’s checklist, whether it raised findings, and
how many. Follow-up detail stays outside the audit log, which holds no free
text. That acknowledgement is itself an audit event.

### Operator access is separate

AWS, database and cluster access is not in this tenant log. Operators review
that access quarterly under the privileged-access process. This checklist does
not replace it.

## How to record it

On `/audit/review`, choose the month, the outcome (`no_findings` or
`findings_raised`) and the number of findings, then record the review. That
appends `audit.monthly_review_recorded` to the tenant chain (`resourceId` is
the `YYYY-MM` period; the reviewer is the signed-in actor; the reason is the
code `audit.monthly_review`). The event stores
only `period`, `outcome` and `findingsCount`. There is no notes field: the
chain is immutable, so free text that might carry personal data never enters it
(#80). Track follow-up detail in the case or task it concerns. Do not edit
older audit rows.

## What this checklist is not

Privileged operator access (AWS, database, cluster) sits outside the tenant
audit log. Quarterly review of that access, just-in-time production access, and
removing ad-hoc SQL from runbooks are the privileged-access process (issue #47).
This checklist does not grant access and does not store that evidence.

## Export

CSV export from `/audit` prefixes a cell that starts with `=`, `+`, `-`, `@`, a
tab or a carriage return with an apostrophe, so a spreadsheet does not run it as
a formula. An export keeps the newest 5000 matching rows. Narrow the dates to
take an older slice. Each export is an `audit.exported` event. Each time someone
opens the log or this checklist is an `audit.viewed` event.
