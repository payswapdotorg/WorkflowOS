/**
 * WorkflowOS Companion extension build.
 *
 * esbuild multi-entry bundle + static asset copy → dist/ (loadable unpacked).
 *
 * Entries:
 *   background              — MV3 service worker (module)
 *   content/workflowos-bridge — runs on the WorkflowOS origin (handoff page)
 *   content/provider-detect  — runs on provider origins (detection only)
 *   ui/popup/popup           — extension popup
 *   ui/fake-provider/page    — deterministic fake provider page (test mode)
 */
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
};

const entries = [
  { in: join(root, 'src/background/index.ts'), out: 'background' },
  { in: join(root, 'src/content/workflowos-bridge.ts'), out: 'content/workflowos-bridge' },
  { in: join(root, 'src/content/provider-detect.ts'), out: 'content/provider-detect' },
  // WORK-029: the Z.ai page bridge (thin; Z.ai logic lives in providers/zai).
  { in: join(root, 'src/content/zai-bridge.ts'), out: 'content/zai-bridge' },
  // WORK-030: the ChatGPT page bridge (thin; logic in providers/chatgpt).
  { in: join(root, 'src/content/chatgpt-bridge.ts'), out: 'content/chatgpt-bridge' },
  { in: join(root, 'src/ui/popup/popup.ts'), out: 'ui/popup/popup' },
  { in: join(root, 'src/ui/fake-provider/page.ts'), out: 'ui/fake-provider/page' },
];

function copyStatic() {
  mkdirSync(dist, { recursive: true });
  // manifest
  cpSync(join(root, 'public'), join(dist), { recursive: true });
  // extension pages (HTML/CSS colocated with their TS sources)
  cpSync(join(root, 'src/ui/popup/index.html'), join(dist, 'ui/popup/index.html'));
  cpSync(join(root, 'src/ui/popup/popup.css'), join(dist, 'ui/popup/popup.css'));
  cpSync(join(root, 'src/ui/fake-provider/index.html'), join(dist, 'ui/fake-provider/index.html'));
  cpSync(join(root, 'src/ui/fake-provider/page.css'), join(dist, 'ui/fake-provider/page.css'));
}

async function run() {
  rmSync(dist, { recursive: true, force: true });
  copyStatic();
  if (watch) {
    const ctx = await context({ ...common, entryPoints: entries, outdir: dist });
    await ctx.watch();
    console.log('[companion] watching for changes…');
  } else {
    await build({ ...common, entryPoints: entries, outdir: dist });
    console.log('[companion] built dist/');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
