const MIN = [22, 18, 0];

export function isSupportedNode(found = process.versions.node) {
  const parts = found.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    if (a > MIN[i]) return true;
    if (a < MIN[i]) return false;
  }
  return true;
}

export function assertNodeVersion() {
  if (!isSupportedNode()) {
    console.error(`brick-art requires Node.js 22.18.0 or later (found ${process.versions.node})`);
    process.exit(1);
  }
}
