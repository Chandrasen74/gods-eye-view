#!/usr/bin/env node
'use strict';
/**
 * God's Eye View desktop launcher.
 *
 * This script is bundled into GodsEyeView.exe via Node's Single Executable
 * Application (SEA) support (see scripts/build-win-exe.mjs). Double-clicking
 * the .exe — or running `node scripts/gev-launcher.cjs` — starts the local
 * Vite dev server (the one that brokers every live data proxy) and opens the
 * app in the default browser.
 *
 * The server binds to 127.0.0.1 only, so nothing else on the network can reach
 * it. The .exe expects to live in (or be launched from) the project root —
 * i.e. next to vite.config.js — and relies on `npm install` having populated
 * node_modules (it offers to run that once, if npm is available).
 */

const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PREFERRED_PORT = 4173;
const HOST = '127.0.0.1';

/** A directory counts as the repo root when it has the Vite config AND deps. */
function isRepoRoot(dir) {
  return (
    fs.existsSync(path.join(dir, 'vite.config.js'))
    && fs.existsSync(path.join(dir, 'node_modules', 'vite'))
  );
}

/**
 * Locate the repo root. Searches upward from both the current working
 * directory and the executable's own location, so the .exe works whether it is
 * double-clicked inside the project or the user's shell is elsewhere.
 */
function findRepoRoot() {
  const starts = [process.cwd(), path.dirname(process.execPath)];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 10; depth += 1) {
      if (isRepoRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Open the app in the platform's default browser (best-effort). */
function openBrowser(url) {
  if (process.env.GEV_NO_BROWSER) return;
  let command = null;
  let args = [];
  if (process.platform === 'win32') {
    // The empty title argument stops `start` from swallowing a URL that
    // contains `&`.
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // A missing browser helper must never take the server down with it.
  }
}

/** Offer a one-time `npm install` when node_modules is missing. */
function ensureDependencies(repoRoot) {
  if (isRepoRoot(repoRoot)) return Promise.resolve(true);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('[GEV] Dependencies are missing — running `npm install` once (this can take a few minutes)…');
  return new Promise((resolve) => {
    const child = spawn(npmCommand, ['install'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' },
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function main() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error("[GEV] Couldn't find the God's Eye View project folder.");
    console.error('[GEV] Put GodsEyeView.exe in the project root (next to vite.config.js) and double-click it there.');
    process.exitCode = 1;
    return;
  }
  process.chdir(repoRoot);
  console.log(`[GEV] Project root: ${repoRoot}`);

  if (!(await ensureDependencies(repoRoot))) {
    console.error('[GEV] `npm install` failed. Install dependencies manually, then run again.');
    process.exitCode = 1;
    return;
  }

  let vite;
  try {
    // Resolve Vite from the repo's own node_modules regardless of where the
    // bundled executable lives — createRequire anchors resolution at the repo.
    const repoRequire = createRequire(path.join(repoRoot, 'package.json'));
    vite = repoRequire('vite');
  } catch (error) {
    console.error('[GEV] Could not load Vite from node_modules:', error?.message || error);
    console.error('[GEV] Run `npm install` in the project folder and try again.');
    process.exitCode = 1;
    return;
  }

  const server = await vite.createServer({
    root: repoRoot,
    server: { host: HOST, port: PREFERRED_PORT, strictPort: false },
  });
  await server.listen();

  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : PREFERRED_PORT;
  const url = `http://localhost:${port}/`;
  console.log(`[GEV] God's Eye View is running at ${url}`);
  console.log('[GEV] Press Ctrl+C here (or close this window) to stop.');
  openBrowser(url);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await server.close().catch(() => {});
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error('[GEV] Launch failed:', error?.message || error);
  process.exitCode = 1;
});
