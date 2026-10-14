import { responseNeedsStepUp, withStepUp } from '@/lib/auth/step-up-flow';

/**
 * Browser call to an existing staff API. Messages stay generic on failure.
 *
 * Every mutation is sent as JSON so the cookie-mutation guard accepts it.
 * Pass `reauthenticate` for routes that require a recent sign-in; a
 * `STEP_UP_REQUIRED` response then prompts once and retries.
 */
export async function staffJson<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
  reauthenticate?: () => Promise<boolean>,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const send = () => fetch(url, init);

  let response: Response;
  try {
    response = reauthenticate ? await withStepUp(send, reauthenticate) : await send();
  } catch {
    throw new Error('That could not be saved. Check your connection and try again.');
  }
  if (!response.ok) {
    if (await responseNeedsStepUp(response)) {
      throw new Error('Confirm it is you to continue. You stay signed in.');
    }
    throw new Error(
      response.status === 403
        ? 'Your role does not allow that action, or the record is no longer available.'
        : response.status === 400
          ? 'Check the details and try again.'
          : 'That could not be saved. Refresh the page and try again.',
    );
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Fetch a signed download URL from a step-up protected route and navigate to
 * it. Throws a display-safe message on failure.
 */
export async function staffDownload(
  url: string,
  reauthenticate: () => Promise<boolean>,
): Promise<void> {
  let response: Response;
  try {
    response = await withStepUp(
      () => fetch(url, { headers: { Accept: 'application/json' } }),
      reauthenticate,
    );
  } catch {
    throw new Error('That file could not be downloaded. Check your connection.');
  }
  if (!response.ok) {
    throw new Error(
      (await responseNeedsStepUp(response))
        ? 'Confirm it is you to download this file. You stay signed in.'
        : 'That file could not be downloaded.',
    );
  }
  const data = (await response.json().catch(() => ({}))) as { url?: string };
  if (!data.url) throw new Error('That file could not be downloaded.');
  window.location.assign(data.url);
}
