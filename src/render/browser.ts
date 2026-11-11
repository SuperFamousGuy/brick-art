import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
  'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];
const LINUX_BINS = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable',
  'brave-browser',
];
const WINDOWS_APPS = [
  'Google/Chrome/Application/chrome.exe',
  'Microsoft/Edge/Application/msedge.exe',
  'Chromium/Application/chrome.exe',
  'BraveSoftware/Brave-Browser/Application/brave.exe',
];

/** Candidate paths for a Chromium-based browser on this platform, most preferred first. */
export function browserCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  if (env.BRICK_ART_BROWSER) out.push(env.BRICK_ART_BROWSER);
  if (platform === 'darwin') {
    for (const root of ['/Applications', join(env.HOME ?? '', 'Applications')]) {
      for (const app of MAC_APPS) out.push(join(root, app));
    }
  } else if (platform === 'win32') {
    for (const root of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (root) for (const app of WINDOWS_APPS) out.push(join(root, app));
    }
  } else {
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      for (const bin of LINUX_BINS) out.push(join(dir, bin));
    }
  }
  return out;
}

/** The first installed Chromium-based browser, or null. BRICK_ART_BROWSER overrides the search. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  return browserCandidates(env).find((p) => existsSync(p)) ?? null;
}

/** Headless flags: WebGL on the GPU when there is one, SwiftShader otherwise; no state left behind. */
export function headlessArgs(profileDir: string, width: number, height: number, url: string): string[] {
  return [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
    `--user-data-dir=${profileDir}`,
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    `--window-size=${width},${height}`,
    url,
  ];
}
