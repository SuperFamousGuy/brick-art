const MIN = [22, 18, 0];

export function assertNodeVersion() {
  const found = process.versions.node;
  const parts = found.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    if (a > MIN[i]) return;
    if (a < MIN[i]) {
      console.error(`brick-art requires Node.js 22.18.0 or later (found ${found})`);
      process.exit(1);
    }
  }
}
