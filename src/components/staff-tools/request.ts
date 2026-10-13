/** Browser call to an existing staff API. Messages stay generic on failure. */
export async function staffJson<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    response = await fetch(url, init);
  } catch {
    throw new Error('That could not be saved. Check your connection and try again.');
  }
  if (!response.ok) {
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
