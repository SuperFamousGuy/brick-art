const ALLOWED = [/CC BY/i, /CC0/i, /Redistributable.*CCAL version 2\.0/i, /public domain/i];
const DENIED = /Not redistributable/i;

/** True when a `!LICENSE` line (or, for a null line, the source default) is on the allow list. */
export function licenseAllowed(line: string | null, sourceDefault: string | null = null): boolean {
  const text = line ?? sourceDefault;
  if (text === null) return false;
  if (DENIED.test(text)) return false;
  return ALLOWED.some((re) => re.test(text));
}
