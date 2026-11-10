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
