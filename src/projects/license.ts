/** Never allowed, checked first: non-commercial, no-derivatives, or not redistributable. */
const DENIED = /\bNC\b|\bND\b|non-?commercial|no ?deriv|Not redistributable/i;
// Fan files spell it "CC BY-SA version 4.0", so an optional "version" may precede the number.
const ALLOWED = [/\bCC BY(-SA)? (version )?\d/i, /\bCC0\b/i, /Redistributable under CCAL version 2\.0/i, /\bpublic domain\b/i];

/** True when a `!LICENSE` line (or, for a null line, the source default) is on the allow list. */
export function licenseAllowed(line: string | null, sourceDefault: string | null = null): boolean {
  const text = line ?? sourceDefault;
  if (text === null) return false;
  if (DENIED.test(text)) return false;
  return ALLOWED.some((re) => re.test(text));
}
