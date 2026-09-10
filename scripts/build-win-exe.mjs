#!/usr/bin/env node
/**
 * Build the single-file God's Eye View launcher (Node SEA).
 *
 * Produces `dist/GodsEyeView.exe` on Windows. The .exe embeds a Node.js
 * runtime plus scripts/gev-launcher.cjs; Vite and every dependency stay in the
 * repo's node_modules, so this is a *launcher* — it still expects the project
 * folder (and a populated node_modules) next to it, exactly like the Pinokio
 * start path.
 *
 * Usage:
 *   npm run build:exe                 # Windows .exe (requires Windows)
 *   npm run build:exe:local           # single-file binary for the CURRENT OS
 *                                     # (smoke-test the pipeline anywhere)
 *
 * The Windows .exe must be built on Windows (or by the GitHub Actions workflow
 * `.github/workflows/build-windows-exe.yml`) because a Windows PE binary can
 * only be assembled from a Windows Node executable.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BLOB = path.join(DIST, 'sea-prep.blob');
const SEA_CONFIG = path.join(__dirname, 'sea-config.json');
// The sentinel fuse must match the Node major that produced sea-prep.blob.
// It is stable across Node 20–26, but if Node ever changes it this build will
// fail loudly at postject time — update it here.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const forceCurrent = process.argv.includes('--platform=current');
const onWindows = process.platform === 'win32';

if (!onWindows && !forceCurrent) {
  console.error('');
  console.error('[build-exe] A Windows .exe can only be built on Windows.');
  console.error('[build-exe] Two ways to get it:');
  console.error('[build-exe]   1. Run `npm run build:exe` on a Windows machine with Node installed.');
  console.error('[build-exe]   2. Use the GitHub Actions workflow `.github/workflows/build-windows-exe.yml`,');
  console.error('[build-exe]      which builds on windows-latest and uploads dist/GodsEyeView.exe.');
  console.error('[build-exe] To smoke-test this pipeline on the current OS, run `npm run build:exe:local`.');
  console.error('');
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: onWindows });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

mkdirSync(DIST, { recursive: true });
rmSync(BLOB, { force: true });

console.log('[build-exe] 1/3 Generating the SEA blob…');
run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);
if (!existsSync(BLOB)) throw new Error('SEA blob was not produced');

const outName = onWindows && !forceCurrent
  ? 'GodsEyeView.exe'
  : `gev-launcher-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const outPath = path.join(DIST, outName);
rmSync(outPath, { force: true });

console.log(`[build-exe] 2/3 Copying the Node runtime → ${outName}`);
copyFileSync(process.execPath, outPath);

console.log('[build-exe] 3/3 Injecting the blob with postject…');
const postjectBin = path.join(ROOT, 'node_modules', '.bin', onWindows ? 'postject.cmd' : 'postject');
if (!existsSync(postjectBin)) {
  throw new Error('postject is missing — run `npm install` to restore devDependencies');
}
execFileSync(postjectBin, [outPath, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', SEA_FUSE], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: onWindows,
});

rmSync(BLOB, { force: true });
const size = statSync(outPath).size;
console.log(`[build-exe] Done: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log('[build-exe] Put it in the project root (next to vite.config.js) and double-click it.');
