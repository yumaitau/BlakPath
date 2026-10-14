## Summary

<!-- What changed, and why. -->

## Identity

- [ ] does this change let software determine identity? → no

BlakPath never determines Aboriginality. Nothing may score, rank, predict,
infer, auto-approve or auto-reject identity. All outcomes stay recorded human
acts. If the honest answer above is yes, do not open this pull request.

## Security and tenancy

- [ ] No secrets, tokens, evidence, genealogy or personal information are in
      the diff or the discussion
- [ ] Tenant scope still comes from the authenticated membership on the
      server, not from a client-supplied organisation id
- [ ] Permission checks still run before sensitive reads and writes
- [ ] Migrations, if any, do not weaken tenant isolation or the audit trail
- [ ] Changes under a path listed in `.github/CODEOWNERS` were reviewed
      against `docs/threat-model.md` and `docs/tenant-isolation.md`
- [ ] This pull request does not describe a vulnerability. Vulnerability
      reports follow `SECURITY.md`

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm format:check`
- [ ] `pnpm test`

<!-- Note integration or end-to-end runs when this change needs them. -->
