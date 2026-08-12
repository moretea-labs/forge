import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dir, '..');
const configFile = resolve(root, 'src/cli/local-bridge/frontend/vite.config.ts');
const committedOutdir = resolve(root, 'src/cli/local-bridge/ui-dist');
const checkOnly = process.argv.includes('--check');
const outdir = checkOnly ? await mkdtemp(join(tmpdir(), 'forge-controller-ui-')) : committedOutdir;

try {
  await build({ configFile, build: { outDir: outdir, emptyOutDir: true } });
  if (checkOnly) {
    for (const asset of ['app.js', 'app.css']) {
      const [generated, committed] = await Promise.all([
        readFile(resolve(outdir, asset), 'utf8'),
        readFile(resolve(committedOutdir, asset), 'utf8'),
      ]);
      if (generated !== committed) throw new Error(`CONTROLLER_UI_BUNDLE_STALE: ${asset}; run bun run build:controller-ui`);
    }
    console.log('Controller UI bundle is current.');
  } else {
    console.log(`Controller UI built: ${resolve(outdir, 'app.js')}, ${resolve(outdir, 'app.css')}`);
  }
} finally {
  if (checkOnly) await rm(outdir, { recursive: true, force: true });
}
