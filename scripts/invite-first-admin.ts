/* eslint-disable no-restricted-properties -- operator CLI reads its own arguments. */
import 'dotenv/config';
import { sqlClient } from '@/db/client';
import { inviteFirstAdministrator } from '@/domains/memberships/first-admin';
import { firstAdminInviteSummary } from '@/domains/memberships/first-admin-message';

/**
 * Email the first organisation administrator.
 *
 * Run after migrations and the permission/role seed. Prints the organisation
 * and invitation ids only. The join link stays in the email.
 *
 *   pnpm admin:invite -- --email person@council.example --legal-name "Council" --slug council
 *
 * Kubernetes passes FIRST_ADMIN_EMAIL, ORGANISATION_LEGAL_NAME, and
 * ORGANISATION_SLUG instead of flags.
 */

function option(flag: string, envName: string): string {
  const index = process.argv.indexOf(flag);
  const fromArg = index >= 0 ? process.argv[index + 1] : undefined;
  return (fromArg ?? process.env[envName] ?? '').trim();
}

async function main(): Promise<void> {
  const email = option('--email', 'FIRST_ADMIN_EMAIL');
  const legalName = option('--legal-name', 'ORGANISATION_LEGAL_NAME');
  const slug = option('--slug', 'ORGANISATION_SLUG');
  if (!email || !legalName || !slug) {
    throw new Error(
      'Usage: pnpm admin:invite -- --email <address> --legal-name <name> --slug <slug>',
    );
  }

  const result = await inviteFirstAdministrator({ email, legalName, slug });
  console.info(firstAdminInviteSummary(result));
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'invite failed';
    console.error(`[invite-first-admin] failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void sqlClient.end({ timeout: 5 });
  });
