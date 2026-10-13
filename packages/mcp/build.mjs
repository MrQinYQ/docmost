import { build } from 'esbuild';
import { copyFile, access, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.mjs'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});
await chmod(`${root}dist/index.mjs`, 0o755);
const license = new URL('../../LICENSE', import.meta.url);
try { await access(license); await copyFile(license, `${root}LICENSE`); }
catch { await access(`${root}LICENSE`); }
