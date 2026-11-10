/**
 * Parse RFC 4180-style CSV text one record at a time, keyed by the header row.
 * Streaming keeps memory flat for large tables (inventory_parts has ~1.5M rows).
 */
export function* iterateCsv(text: string): Generator<Record<string, string>> {
  let header: string[] | null = null;
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const finishRow = (): Record<string, string> | null => {
    endField();
    const done = row;
    row = [];
    if (header === null) {
      header = done.map((h, i) => (i === 0 ? h.replace(/^\uFEFF/, '') : h));
      return null;
    }
    if (done.length === 1 && done[0] === '') return null;
    const rec: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = done[i] ?? '';
    return rec;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let rec: Record<string, string> | null = null;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      rec = finishRow();
    } else if (ch === '\n') {
      rec = finishRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
    if (rec) yield rec;
  }
  // Final row without a trailing newline.
  if (fieldStarted || field !== '' || row.length > 0) {
    const rec = finishRow();
    if (rec) yield rec;
  }
}

/** Parse RFC 4180-style CSV text into records keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  return [...iterateCsv(text)];
}
