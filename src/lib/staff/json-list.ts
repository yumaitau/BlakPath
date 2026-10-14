/** Coerce a jsonb array into strings. Non-arrays become an empty list. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
