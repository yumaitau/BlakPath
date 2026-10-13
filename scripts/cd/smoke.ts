/* eslint-disable no-restricted-properties -- smoke credentials come from the GitHub environment. */
import { parseArgs } from 'node:util';
import { pollReady, readyAccepted, signInAccepted } from '@/lib/cd/smoke';
import { assertPublicAppUrl } from '@/lib/cd/target';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
  },
});

const baseUrl = values['base-url'];
if (!baseUrl) throw new Error('usage: smoke.ts --base-url https://host');
const appUrl = assertPublicAppUrl(baseUrl);

const email = process.env.SMOKE_SIGN_IN_EMAIL;
const password = process.env.SMOKE_SIGN_IN_PASSWORD;
if (!email || !password) {
  throw new Error('SMOKE_SIGN_IN_EMAIL and SMOKE_SIGN_IN_PASSWORD are required');
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const ready = await pollReady(
  async () => {
    const response = await fetch(new URL('/api/ready', appUrl), {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readJson(response);
    const accepted = readyAccepted(response.status, body);
    process.stdout.write(`ready status=${response.status} accepted=${accepted}\n`);
    return accepted;
  },
  {
    attempts: 12,
    delayMs: 5_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
);
if (!ready) throw new Error('/api/ready did not report ready');

const signIn = await fetch(new URL('/api/auth/sign-in/email', appUrl), {
  method: 'POST',
  redirect: 'manual',
  signal: AbortSignal.timeout(15_000),
  headers: {
    'content-type': 'application/json',
    origin: appUrl.origin,
  },
  body: JSON.stringify({ email, password, rememberMe: false }),
});
const signInBody = await readJson(signIn);
const cookies =
  typeof signIn.headers.getSetCookie === 'function' ? signIn.headers.getSetCookie() : [];
const accepted = signInAccepted(signIn.status, signInBody, cookies);
process.stdout.write(`sign-in status=${signIn.status} accepted=${accepted}\n`);
if (!accepted) throw new Error('sign-in smoke failed');
