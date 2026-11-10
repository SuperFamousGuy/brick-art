const CAB_LICENSE = '0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt';

export const MPD_10001_MINI = [
  '0 FILE 10001 - Main.ldr',
  '0 Name: 10001 - Main.ldr',
  '0 Author: Test Builder',
  CAB_LICENSE,
  '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '0 STEP',
  '1 4 0 -24 0 0 0 1 0 1 0 -1 0 0 10001 - CAB.LDR',
  '0 STEP',
  '0 NOFILE',
  '0 FILE 10001 - Cab.ldr',
  '0 Name: 10001 - Cab.ldr',
  '0 Author: Cab Builder',
  CAB_LICENSE,
  '1 16 10 0 0 1 0 0 0 1 0 0 0 1 3023.dat',
  '1 0 0 0 0 1 0 0 0 1 0 0 0 1 9999x.dat',
  '1 0 0 0 0 1 0 0 0 1 0 0 0 1 missing.ldr',
  '0 STEP',
  '0 NOFILE',
  '',
].join('\n');

export const MPD_CLEAN = MPD_10001_MINI
  .split('\n')
  .filter((l) => !l.endsWith(' 9999x.dat') && !l.endsWith(' missing.ldr'))
  .join('\n');

export const MPD_BMODEL = [
  '0 FILE 10001-1_B-Model.mpd',
  '0 Name: 10001-1_B-Model.mpd',
  '0 Author: B Builder',
  '1 72 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '0 STEP',
  '',
].join('\n');

export type FakeReply = string | Buffer | number;

/**
 * Generic static HTTP server for tests.
 *
 * `pages` maps a request path to a reply. A key is matched against the full request target
 * (path plus query string) first, then against the path alone, so `/a.mpd` serves `/a.mpd?v=1`
 * unless `/a.mpd?v=1` is itself a key. A reply is a string (served as text), a Buffer (binary)
 * or a number (an empty response with that HTTP status). An array of replies is a sequence:
 * each request takes the next one and the last one repeats. The content type is inferred from the
 * path's extension (.json, .zip, .gz, .png; text/html for strings otherwise; octet-stream for Buffers).
 * Unknown paths answer 404. `hits` counts requests per path (query string excluded).
 * `maxInFlight()` is the highest number of requests open at once; `delayMs` holds each response
 * open so that overlap is observable.
 */
export async function startFakeOmr(
  pages: Map<string, FakeReply | FakeReply[]>,
  opts: { delayMs?: number } = {},
): Promise<{ url: string; hits: Map<string, number>; maxInFlight(): number; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const hits = new Map<string, number>();
  const used = new Map<string, number>();
  let inFlight = 0;
  let maxSeen = 0;
  const types: Record<string, string> = {
    json: 'application/json', zip: 'application/zip', gz: 'application/gzip', png: 'image/png',
  };
  const server = createServer((req, res) => {
    const target = req.url ?? '/';
    const path = target.split('?')[0];
    inFlight++;
    maxSeen = Math.max(maxSeen, inFlight);
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const done = () => {
      const key = pages.has(target) ? target : path;
      const entry = pages.get(key);
      if (entry === undefined) {
        res.statusCode = 404;
        res.end('not found');
      } else {
        let reply: FakeReply;
        if (Array.isArray(entry)) {
          const n = used.get(key) ?? 0;
          used.set(key, n + 1);
          reply = entry[Math.min(n, entry.length - 1)];
        } else reply = entry;
        if (typeof reply === 'number') {
          res.statusCode = reply;
          res.end();
        } else {
          const ext = path.split('.').pop() ?? '';
          const fallback = Buffer.isBuffer(reply) ? 'application/octet-stream' : 'text/html; charset=utf-8';
          res.setHeader('Content-Type', types[ext] ?? fallback);
          res.end(reply);
        }
      }
      inFlight--;
    };
    if (opts.delayMs) setTimeout(done, opts.delayMs);
    else done();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    maxInFlight: () => maxSeen,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
