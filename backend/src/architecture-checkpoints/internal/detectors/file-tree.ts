/**
 * WORK-051 — shared deterministic file-tree utilities for the static
 * detectors. Read-only filesystem access; no caching (each evaluation reads
 * the tree as it is — the same tree ⇒ the same result); no credentials; no
 * domain truth is created here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ScannedFile {
  /** Absolute path. */
  absolute: string;
  /** Path relative to the walked root, with '/' separators. */
  relativePath: string;
  source: string;
}

/** Recursively collect files under `root` matching `extension` (e.g. '.ts'). */
export function walkFiles(root: string, extension: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory ⇒ nothing to scan (caller sees no files)
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(extension)) {
        let source = '';
        try {
          source = readFileSync(full, 'utf8');
        } catch {
          source = ''; // unreadable file ⇒ empty source (no violations from it)
        }
        out.push({
          absolute: full,
          relativePath: relative(root, full).split('\\').join('/'),
          source,
        });
      }
    }
  };
  walk(root);
  return out;
}

/** Deterministic ordering helper: sort by relative path. */
export function byRelativePath(a: ScannedFile, b: ScannedFile): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

/**
 * Strip line + block comments from TypeScript source. Detectors evaluate
 * CODE, not prose — the static-architecture precedent. Deterministic.
 */
export function stripCodeComments(src: string): string {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extract every import specifier from a TypeScript source (static imports +
 * export-from). Deterministic order of appearance.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specifiers.push(m[1]!);
  }
  const sideEffect = /import\s*['"]([^'"]+)['"]/g;
  while ((m = sideEffect.exec(source)) !== null) {
    specifiers.push(m[1]!);
  }
  return specifiers;
}

/** Read a required string from an opaque detector config (fail-closed). */
export function requireString(config: Record<string, unknown>, key: string): string | null {
  const v = config[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
