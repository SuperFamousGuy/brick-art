import { cp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import type { Variant } from '../../src/projects/types.ts';
import { runSeed } from '../../src/seed/seed.ts';
import { fixtureFetched, writeFixtureSources } from './fixtures.ts';
import { MPD_10001_MINI, MPD_BMODEL, startFakeOmr } from './models.ts';
import type { FakeReply } from './models.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CC = '0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt';
export const FAN_SHA = 'f00dfacef00dface';
export const FAN_TOWN = ['0 Author: Mayor', CC, '1 4 0 0 0 1 0 0 0 1 0 0 0 1 house.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', ''].join('\n');
export const FAN_HOUSE = ['0 Author: Builder', CC, '1 16 0 0 0 1 0 0 0 1 0 0 0 1 3023.dat', ''].join('\n');

/** The fixture fan source served by `seedFixture` for the `full` variant. */
export const FAN_SOURCES_YAML = [
  '- id: fixture_fan',
  '  name: Fixture Fan Town',
  '  homepage: https://example.test/fan',
  '  fetch:',
  '    kind: github',
  '    repo: fan/town',
  '    paths: ["models/*.ldr"]',
  '  designer: Fixture designers',
  '',
].join('\n');

/** Default fake OMR site: set S1-1 with its main model and one B-model. */
export function omrPages(): Map<string, FakeReply> {
  const link = (name: string) => `<a href="https://library.ldraw.org/media/omr_models/1/${name}?v=1">f</a>`;
  return new Map<string, FakeReply>([
    ['/omr/sets?page=1', '<a href="/omr/sets/1">S1-1</a>'],
    ['/omr/sets/1', `<html>${link('S1-1.mpd')}${link('S1-1_B-Model.mpd')}</html>`],
    ['/media/omr_models/1/S1-1.mpd', MPD_10001_MINI],
    ['/media/omr_models/1/S1-1_B-Model.mpd', MPD_BMODEL],
  ]);
}

function fanPages(): Map<string, FakeReply> {
  const zip = zipSync({
    [`town-${FAN_SHA}/models/town.ldr`]: new TextEncoder().encode(FAN_TOWN),
    [`town-${FAN_SHA}/models/house.ldr`]: new TextEncoder().encode(FAN_HOUSE),
  });
  return new Map<string, FakeReply>([
    ['/repos/fan/town/commits/HEAD', JSON.stringify({ sha: FAN_SHA })],
    [`/fan/town/zip/${FAN_SHA}`, Buffer.from(zip)],
  ]);
}

/**
 * Seeds a database from fixture sources in `dir` for `variant`. A fake server provides OMR
 * (`omrPages()` unless `omr` replaces those pages) and, for `full`, a fixture fan source that
 * replaces the repo's curated fan sources. Call `close()` to stop the server; `dir` is the caller's.
 */
export async function seedFixture(
  dir: string, variant: Variant, omr?: Map<string, FakeReply>,
): Promise<{ dataDir: string; dbFile: string; close(): Promise<void> }> {
  const fx = await writeFixtureSources(join(dir, 'fx'));
  const pages = new Map<string, FakeReply>([...(omr ?? omrPages()), ...fanPages()]);
  const server = await startFakeOmr(pages);
  try {
    let repoRoot = REPO_ROOT;
    if (variant === 'full') {
      repoRoot = join(dir, 'repo');
      await cp(join(REPO_ROOT, 'curated'), join(repoRoot, 'curated'), { recursive: true });
      await writeFile(join(repoRoot, 'curated', 'fan-sources.yaml'), FAN_SOURCES_YAML);
    }
    const dataDir = join(dir, 'data');
    const result = await runSeed({
      dataDir, repoRoot, refresh: false, sources: fixtureFetched(fx), variant,
      omr: { baseUrl: server.url, backoffMs: 1 },
      fanFetch: { githubApi: server.url, codeload: server.url },
    });
    return { dataDir, dbFile: result.dbFile, close: () => server.close() };
  } catch (err) {
    await server.close();
    throw err;
  }
}
