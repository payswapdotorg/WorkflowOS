/**
 * V2-008 — the REAL filesystem desktop environment (the dogfooding host).
 *
 * Real `node:fs/promises` I/O rooted at a sandbox directory: listDirectory,
 * readFile and writeFile perform REAL filesystem operations with REAL
 * operating-system semantics (ENOENT for missing parents, real content,
 * real races). This is the "real host" of the V2-008 dogfooding experiment:
 * a useful computer task automated end-to-end with real side effects.
 *
 * Determinism note: this environment is for the DOGFOODING RUNNER only
 * (never in the vitest batteries — those use the scripted environments).
 * The runner prepares a fixed starting state and the run's outcome is
 * asserted for real (files exist with the exact expected bytes).
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopDirectoryEntry, DesktopEnvironment, DesktopScreenElement } from './environments.js';

export interface RealFilesystemDesktopEnvironmentDeps {
  /** The sandbox root: every path is rooted here (path traversal closed). */
  readonly root: string;
  /**
   * A real screen state provider (the real host's window list). The runner
   * injects a deterministic snapshot; screen.observe reads it for real.
   */
  readonly screenProvider?: () => readonly DesktopScreenElement[];
  /** Applications opened through application.open (recorded for real audit). */
  readonly onOpenApplication?: (application: string) => void;
  /** Screen interactions (ui.click/ui.type/application.interact audit). */
  readonly onInteract?: (elementId: string, action: string, text?: string) => void;
}

/**
 * The real desktop environment: real filesystem + real screen-projection
 * callbacks. Writes are STRICT: a missing parent directory fails (real
 * ENOENT semantics surfaced as a typed environment error) — the runtime's
 * failure classification and recovery handle it honestly.
 */
export class RealFilesystemDesktopEnvironment implements DesktopEnvironment {
  private readonly root: string;
  private readonly screenProvider: () => readonly DesktopScreenElement[];
  private readonly onOpenApplication: (application: string) => void;
  private readonly onInteract: (elementId: string, action: string, text?: string) => void;

  constructor(deps: RealFilesystemDesktopEnvironmentDeps) {
    this.root = deps.root;
    this.screenProvider = deps.screenProvider ?? (() => []);
    this.onOpenApplication = deps.onOpenApplication ?? (() => undefined);
    this.onInteract = deps.onInteract ?? (() => undefined);
  }

  private resolve(path: string): string {
    if (path.startsWith('/') || path.includes('..')) {
      throw new Error(`real desktop environment: illegal path "${path}"`);
    }
    return join(this.root, path);
  }

  async listDirectory(path: string): Promise<DesktopDirectoryEntry[]> {
    try {
      const entries = await readdir(this.resolve(path === '/' ? '.' : path), { withFileTypes: true });
      return entries
        .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? ('directory' as const) : ('file' as const) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(`real desktop environment: listDirectory "${path}" failed: ${String(error)}`);
    }
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(this.resolve(path), 'utf8');
    } catch {
      // real fs semantics: a missing file is an ABSENT target (not an error)
      return null;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    try {
      await readdir(this.resolve(parent === '' || parent === '/' ? '.' : parent));
    } catch (error) {
      throw new Error(`real desktop environment: parent directory missing for "${path}": ${String(error)}`);
    }
    await writeFile(this.resolve(path), content, 'utf8');
  }

  screenState(): readonly DesktopScreenElement[] {
    return [...this.screenProvider()].sort((a, b) => a.elementId.localeCompare(b.elementId));
  }

  openApplication(application: string): void {
    this.onOpenApplication(application);
  }

  interact(elementId: string, action: string, text?: string): void {
    this.onInteract(elementId, action, text);
  }
}

