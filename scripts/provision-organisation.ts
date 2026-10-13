import { ZodError } from 'zod';

import { ActivationRefusedError, OnboardingError } from '@/domains/onboarding/policy';
import {
  activateOrganisation,
  provisionOrganisation,
  recordOperatorReadiness,
  recordSignedAgreement,
  resendOrganisationInvite,
} from '@/domains/onboarding/service';
import { sqlClient } from '@/db/client';

/**
 * Operator command for a new organisation.
 *
 * Prints a JSON result and never a password or invitation token. The token is
 * emailed to the first administrator. Re-running `provision` for an existing
 * slug does nothing.
 *
 *   pnpm org:provision -- provision --legal-name "..." --slug ... \
 *     --admin-email ... --operator-email ... [--type council|community] [--abn] [--trading-name]
 *   pnpm org:provision -- readiness --slug ... --item consent_wording --complete true --operator-email ...
 *   pnpm org:provision -- agreement --slug ... --reference MSA-2026-014 --signed-at 2026-10-01 --operator-email ...
 *   pnpm org:provision -- activate --slug ... --operator-email ...
 *   pnpm org:provision -- resend-invite --slug ... --operator-email ...
 */

function flagValue(flags: Map<string, string>, name: string): string | undefined {
  return flags.get(name);
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new OnboardingError('INVALID_INPUT', `Missing --${name}`);
  }
  return value;
}

function parseFlags(argv: readonly string[]): {
  command: string;
  flags: Map<string, string>;
} {
  const [command, ...rest] = argv;
  if (!command || command.startsWith('--')) {
    throw new OnboardingError(
      'INVALID_INPUT',
      'Usage: provision | readiness | agreement | activate | resend-invite',
    );
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith('--')) {
      throw new OnboardingError('INVALID_INPUT', 'Unexpected argument.');
    }
    const name = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new OnboardingError('INVALID_INPUT', `Missing value for --${name}`);
    }
    flags.set(name, value);
    index += 1;
  }
  return { command, flags };
}

function completeFlag(flags: Map<string, string>): boolean {
  const value = requireFlag(flags, 'complete');
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new OnboardingError('INVALID_INPUT', '--complete must be true or false.');
}

async function run(argv: readonly string[]): Promise<unknown> {
  const { command, flags } = parseFlags(argv);
  switch (command) {
    case 'provision': {
      const tradingName = flagValue(flags, 'trading-name');
      const organisationType = flagValue(flags, 'type');
      const abn = flagValue(flags, 'abn');
      return provisionOrganisation({
        legalName: requireFlag(flags, 'legal-name'),
        slug: requireFlag(flags, 'slug'),
        adminEmail: requireFlag(flags, 'admin-email'),
        operatorEmail: requireFlag(flags, 'operator-email'),
        ...(tradingName !== undefined ? { tradingName } : {}),
        ...(organisationType !== undefined ? { organisationType } : {}),
        ...(abn !== undefined ? { abn } : {}),
      });
    }
    case 'readiness':
      return recordOperatorReadiness({
        slug: requireFlag(flags, 'slug'),
        item: requireFlag(flags, 'item'),
        complete: completeFlag(flags),
        operatorEmail: requireFlag(flags, 'operator-email'),
      });
    case 'agreement':
      return recordSignedAgreement({
        slug: requireFlag(flags, 'slug'),
        reference: requireFlag(flags, 'reference'),
        signedAt: requireFlag(flags, 'signed-at'),
        operatorEmail: requireFlag(flags, 'operator-email'),
      });
    case 'activate':
      return activateOrganisation({
        slug: requireFlag(flags, 'slug'),
        operatorEmail: requireFlag(flags, 'operator-email'),
      });
    case 'resend-invite':
      return resendOrganisationInvite({
        slug: requireFlag(flags, 'slug'),
        operatorEmail: requireFlag(flags, 'operator-email'),
      });
    default:
      throw new OnboardingError('INVALID_INPUT', `Unknown command ${command}`);
  }
}

async function main(): Promise<void> {
  try {
    const result = await run(process.argv.slice(2));
    console.info(JSON.stringify(result));
  } catch (error) {
    if (error instanceof ActivationRefusedError) {
      console.error(JSON.stringify({ error: error.code, reasons: error.reasons }));
      process.exitCode = 2;
      return;
    }
    if (error instanceof OnboardingError) {
      console.error(JSON.stringify({ error: error.code, message: error.message }));
      process.exitCode = 1;
      return;
    }
    if (error instanceof ZodError) {
      console.error(
        JSON.stringify({
          error: 'INVALID_INPUT',
          fields: error.issues.map((issue) => issue.path.join('.')),
        }),
      );
      process.exitCode = 1;
      return;
    }
    console.error(JSON.stringify({ error: 'COMMAND_FAILED' }));
    process.exitCode = 1;
  } finally {
    await sqlClient.end({ timeout: 5 });
  }
}

void main();
