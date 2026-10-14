/**
 * Client-safe retry for a 401 `STEP_UP_REQUIRED` response.
 *
 * The first response is returned when the caller cancels. A successful
 * re-authentication runs the action once more. This module does not sign out.
 */

export async function responseNeedsStepUp(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const data: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return (
    typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    (data as { code?: unknown }).code === 'STEP_UP_REQUIRED'
  );
}

export async function withStepUp(
  action: () => Promise<Response>,
  reauthenticate: () => Promise<boolean>,
): Promise<Response> {
  const first = await action();
  if (!(await responseNeedsStepUp(first))) return first;
  const ok = await reauthenticate();
  if (!ok) return first;
  return action();
}
