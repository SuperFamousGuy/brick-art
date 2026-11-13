import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipIndex } from '../../src/render/zip-index.ts';
import { browserCandidates, findBrowser } from '../../src/render/browser.ts';
import { renderModel } from '../../src/render/render.ts';
import { LDCONFIG, writeLibrary } from '../helpers/ldraw-fixture.ts';

const tmp = mkdtempSync(join(tmpdir(), 'brick-art-render-test-'));

test('ZipIndex reads stored and deflated entries by case-insensitive path', () => {
  const index = ZipIndex.open(writeLibrary(tmp), /^ldraw\//);
  try {
    assert.equal(index.size, 4);
    assert.equal(new TextDecoder().decode(index.get('LDCONFIG.LDR')!), LDCONFIG);
    assert.ok(new TextDecoder().decode(index.get('parts/box.dat')!).startsWith('0 Test box.dat'));
    assert.equal(new TextDecoder().decode(index.get('p/stored.dat')!), '0 stored primitive');
    assert.equal(index.get('parts/missing.dat'), null);
    assert.equal(index.has('ldraw/parts/box.dat'), false);
  } finally {
    index.close();
  }
});

test('ZipIndex rejects a file that is not a zip', () => {
  const file = join(tmp, 'not.zip');
  writeFileSync(file, 'hello');
  assert.throws(() => ZipIndex.open(file), /end of central directory/);
});

test('browserCandidates puts BRICK_ART_BROWSER first and covers each platform', () => {
  assert.equal(browserCandidates({ BRICK_ART_BROWSER: '/x/chrome' }, 'linux')[0], '/x/chrome');
  assert.ok(browserCandidates({}, 'darwin').some((p) => p.endsWith('Google Chrome.app/Contents/MacOS/Google Chrome')));
  assert.ok(browserCandidates({ PATH: '/usr/bin' }, 'linux').includes('/usr/bin/chromium'));
  assert.ok(browserCandidates({ PROGRAMFILES: 'C:\\Program Files' }, 'win32').some((p) => p.endsWith('chrome.exe')));
});

const browser = findBrowser();
const noBrowser = browser === null ? 'no Chromium-based browser installed' : false;
const PNG_SIGNATURE = '89504e470d0a1a0a';

test('renderModel writes one PNG per view, reading submodels from the model folder', { skip: noBrowser, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmp, 'model-'));
  writeFileSync(join(dir, 'tower.ldr'), '0 Tower\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 box.dat\n0 STEP\n1 4 0 -20 0 1 0 0 0 1 0 0 0 1 Top.ldr\n');
  writeFileSync(join(dir, 'top.ldr'), '0 Top\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 box.dat\n');
  const library = ZipIndex.open(writeLibrary(dir), /^ldraw\//);
  try {
    const result = await renderModel({
      modelPath: join(dir, 'tower.ldr'), outDir: join(dir, 'out'), browser: browser!, library,
      views: [{ name: 'side', yaw: 90, pitch: 5 }, { name: 'top', yaw: 0, pitch: 80 }], width: 320, height: 240,
    });
    assert.deepEqual(result.files.map((f) => f.view), ['side', 'top']);
    assert.deepEqual(result.parts, [{ part: 'box', color: 4, colorName: 'Red', count: 2 }]);
    assert.equal(result.totalParts, 2);
    for (const f of result.files) {
      assert.match(f.path, /tower-(side|top)\.png$/);
      const png = readFileSync(f.path);
      assert.equal(png.subarray(0, 8).toString('hex'), PNG_SIGNATURE);
      assert.equal(png.readUInt32BE(16), 320);
      assert.equal(png.readUInt32BE(20), 240);
    }
  } finally {
    library.close();
  }
});

test('renderModel rejects bad input before starting a browser', async () => {
  const library = ZipIndex.open(writeLibrary(tmp), /^ldraw\//);
  try {
    await assert.rejects(renderModel({ modelPath: join(tmp, 'x.txt'), browser: 'none', library }), /\.ldr, \.mpd, or \.dat/);
    await assert.rejects(renderModel({ modelPath: join(tmp, 'missing.ldr'), browser: 'none', library }), /not found/);
    const model = join(tmp, 'ok.ldr');
    writeFileSync(model, '0 ok\n');
    await assert.rejects(
      renderModel({ modelPath: model, browser: 'none', library, views: [{ name: 'a b', yaw: 0, pitch: 0 }] }),
      /view name/,
    );
  } finally {
    library.close();
  }
});

test('renderModel reports a part missing from the library', { skip: noBrowser, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmp, 'missing-'));
  writeFileSync(join(dir, 'm.ldr'), '0 M\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 box.dat\n1 4 0 -20 0 1 0 0 0 1 0 0 0 1 nosuchpart.dat\n');
  const library = ZipIndex.open(writeLibrary(dir), /^ldraw\//);
  try {
    await assert.rejects(
      renderModel({ modelPath: join(dir, 'm.ldr'), browser: browser!, library, width: 200, height: 200, timeoutMs: 60_000 }),
      /nosuchpart\.dat/,
    );
  } finally {
    library.close();
  }
});
