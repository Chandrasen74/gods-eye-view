# Windows .exe launcher

God's Eye View ships a tiny double-click launcher: **GodsEyeView.exe**. It
starts the local dev server (the one that brokers every live data proxy) and
opens the app in your default browser. No terminal, no `npm run dev`.

The `.exe` is a **launcher**, not a full app bundle: it embeds a Node.js
runtime plus the launcher script, while Vite, Cesium, and every layer stay in
the repo's `node_modules`. So it lives in the project folder — next to
`vite.config.js` — the same way the Pinokio start path does.

## Getting the .exe

Two ways:

1. **GitHub Actions (recommended).** The
   [Build Windows EXE](../.github/workflows/build-windows-exe.yml) workflow
   runs on `windows-latest` and uploads `GodsEyeView.exe` as an artifact.
   Open it from the repo's **Actions** tab, or trigger it manually with
   `workflow_dispatch`.
2. **Build it yourself on Windows** (Node 22+ installed):
   ```bat
   npm ci
   npm run build:exe
   ```
   The result is `dist\GodsEyeView.exe`.

## Using it

1. Make sure dependencies are installed once (`npm ci` or `npm install`).
   If they're missing, the launcher offers to run `npm install` itself.
2. Put `GodsEyeView.exe` in the project root, next to `vite.config.js`.
3. Double-click it. A console window appears, prints the URL, and your browser
   opens `http://localhost:4173/` (or the next free port).
4. Stop it with **Ctrl+C** in that window, or just close the window.

## How it's built

The launcher (`scripts/gev-launcher.cjs`) is compiled into a single-file
executable using Node's [Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
support:

1. `node --experimental-sea-config scripts/sea-config.json` serializes the
   launcher into a blob.
2. The running `node.exe` is copied to `dist\GodsEyeView.exe`.
3. `postject` injects the blob, producing a self-contained binary.

`npm run build:exe` runs those three steps (`scripts/build-win-exe.mjs`).
`npm run build:exe:local` builds a binary for the current OS instead, which is
useful for smoke-testing the pipeline on macOS/Linux.

## Notes

- The server binds to **127.0.0.1 only**, so nothing else on the network can
  reach it. See [SECURITY.md](SECURITY.md) for the full threat model.
- The `.exe` itself is platform-specific: a Windows binary must be assembled
  from a Windows Node runtime, which is why it's built on Windows (or CI),
  not cross-compiled.
- `dist/` is gitignored; the binary is distributed as a CI artifact or built
  locally, never committed to the repository.
