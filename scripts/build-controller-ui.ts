import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const entrypoint = resolve(root, 'src/cli/local-bridge/ui/app.ts');
const committedOutdir = resolve(root, 'src/cli/local-bridge/ui-dist');
const checkOnly = process.argv.includes('--check');
const outdir = checkOnly ? await mkdtemp(join(tmpdir(), 'forge-controller-ui-')) : committedOutdir;

try {
  await mkdir(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    naming: 'app.[ext]',
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
  } else if (checkOnly) {
    for (const asset of ['app.js', 'app.css']) {
      const [generated, committed] = await Promise.all([
        readFile(resolve(outdir, asset), 'utf8'),
        readFile(resolve(committedOutdir, asset), 'utf8'),
      ]);
      if (generated !== committed) throw new Error(`CONTROLLER_UI_BUNDLE_STALE: ${asset}; run bun run build:controller-ui`);
    }
    console.log('Controller UI bundle is current.');
  } else {
    console.log(`Controller UI built: ${result.outputs.map((output) => output.path).join(', ')}`);
  }
} finally {
  if (checkOnly) await rm(outdir, { recursive: true, force: true });
}
