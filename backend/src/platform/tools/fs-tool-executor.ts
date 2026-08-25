/**
 * WORK-036: FsToolExecutor — the governed filesystem family.
 *
 * Every operation resolves its path through path-confinement.ts against
 * the WORK-035 workspace worktree root: traversal, absolute paths, and
 * symlink escapes are FAILED OUTCOMES (observable), never host access.
 * Output is bounded (content ≤ limits.maxFileBytes with a truncated flag;
 * list ≤ limits.maxListEntries).
 *
 * NOT an authority: a filesystem read is evidence, nothing more.
 */
import { readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '@platform/logger.js';
import type {
  FilesystemToolRequest,
  ToolFamilyRequest,
  ToolExecutionOutcome,
  ToolExecutor,
  ToolExecutorContext,
} from './tool-contracts.js';
import { toolOutcomeError } from './tool-contracts.js';
import { resolveWithinWorkspace, WorkspaceBoundaryError } from './path-confinement.js';

export interface FsToolExecutorDeps {
  readonly logger: Logger;
}

export class FsToolExecutor implements ToolExecutor {
  readonly family = 'filesystem' as const;

  constructor(private readonly deps: FsToolExecutorDeps) {}

  async execute(request: ToolFamilyRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    const req = request as FilesystemToolRequest;
    if (!req || typeof req.operation !== 'string') {
      return toolOutcomeError('tool-invalid-input', 'filesystem request requires an operation');
    }
    try {
      switch (req.operation) {
        case 'read':
          return await this.read(req, ctx);
        case 'write':
          return await this.write(req, ctx);
        case 'list':
          return await this.list(req, ctx);
        case 'stat':
          return await this.stat(req, ctx);
        case 'mkdir':
          return await this.mkdir(req, ctx);
        case 'delete':
          return await this.remove(req, ctx);
        default:
          return toolOutcomeError('tool-invalid-input', `unknown filesystem operation ${JSON.stringify(req.operation)}`);
      }
    } catch (err) {
      if (err instanceof WorkspaceBoundaryError) {
        return toolOutcomeError(err.code, err.message);
      }
      const e = err as NodeJS.ErrnoException;
      return toolOutcomeError(
        'filesystem-error',
        `filesystem ${req.operation} failed for ${JSON.stringify(req.path)}: ${e.code ?? ''} ${e.message ?? String(err)}`.trim(),
      );
    }
  }

  private async read(req: FilesystemToolRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    const target = await resolveWithinWorkspace(ctx.workspaceRoot, req.path);
    const buf = await readFile(target);
    const truncated = buf.byteLength > ctx.limits.maxFileBytes;
    const content = truncated ? buf.subarray(0, ctx.limits.maxFileBytes).toString('utf8') : buf.toString('utf8');
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      output: { path: req.path, bytes: buf.byteLength, content, truncated },
      error: null,
      cancelled: false,
      truncated,
    };
  }

  private async write(req: FilesystemToolRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    if (typeof req.content !== 'string') {
      return toolOutcomeError('tool-invalid-input', 'filesystem write requires content');
    }
    const target = await resolveWithinWorkspace(ctx.workspaceRoot, req.path);
    // The CONFINED parent directories are created when absent (the target
    // resolved within the workspace — the boundary is already enforced).
    await mkdir(dirname(target), { recursive: true });
    const bytes = Buffer.byteLength(req.content, 'utf8');
    await writeFile(target, req.content, 'utf8');
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      output: { path: req.path, bytes },
      error: null,
      cancelled: false,
      truncated: false,
    };
  }

  private async list(req: FilesystemToolRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    const target = await resolveWithinWorkspace(ctx.workspaceRoot, req.path);
    const entries = await readdir(target, { withFileTypes: true });
    const limited = entries.slice(0, ctx.limits.maxListEntries);
    const detailed = await Promise.all(
      limited.map(async (e) => {
        let size: number | null = null;
        try {
          const s = await stat(`${target}/${e.name}`);
          size = s.size;
        } catch {
          size = null;
        }
        return { name: e.name, kind: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file', size };
      }),
    );
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      output: { path: req.path, entries: detailed, truncated: entries.length > limited.length },
      error: null,
      cancelled: false,
      truncated: entries.length > limited.length,
    };
  }

  private async stat(req: FilesystemToolRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    const target = await resolveWithinWorkspace(ctx.workspaceRoot, req.path);
    try {
      const s = await stat(target);
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        output: {
          path: req.path,
          exists: true,
          kind: s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'file',
          size: s.size,
          modifiedAt: s.mtime.toISOString(),
        },
        error: null,
        cancelled: false,
        truncated: false,
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          output: { path: req.path, exists: false, kind: null, size: null, modifiedAt: null },
          error: null,
          cancelled: false,
          truncated: false,
        };
      }
      throw err;
    }
  }

  private async mkdir(req: FilesystemToolRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    const target = await resolveWithinWorkspace(ctx.workspaceRoot, req.path);
    await mkdir(target, { recursive: true });
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      output: { path: req.path },
      error: null,
      cancelled: false,
      truncated: false,
    };
  }

  private async remove(req: FilesystemToolRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    const target = await resolveWithinWorkspace(ctx.workspaceRoot, req.path);
    const s = await stat(target).catch(() => null);
    if (!s) {
      // Absent → success (idempotent deletion).
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        output: { path: req.path, removed: false, existed: false },
        error: null,
        cancelled: false,
        truncated: false,
      };
    }
    if (s.isDirectory()) {
      // A directory must be EMPTY (or a dangling symlink) — no recursive
      // host-side deletion through the tool boundary.
      const entries = await readdir(target);
      if (entries.length > 0) {
        return toolOutcomeError(
          'filesystem-directory-not-empty',
          `refusing to delete the non-empty directory ${JSON.stringify(req.path)} (delete its contents first)`,
        );
      }
    }
    await rm(target);
    this.deps.logger.info('tool.filesystem.deleted', { path: req.path });
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      output: { path: req.path, removed: true, existed: true },
      error: null,
      cancelled: false,
      truncated: false,
    };
  }
}
