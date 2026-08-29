/**
 * WORK-052 — the repository-resident governance-state loader (ADR-0001).
 *
 * Loads `spec/development-state/governance-model.json` + `program-state.json`
 * from a repository checkout and validates them FAIL-CLOSED through the ONE
 * shared validation engine (ADR-0004). The loader is the ONLY place the
 * control plane touches the filesystem; a state that does not validate is
 * never served ({@link GovernanceStateValidationError}).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { validateGovernanceState } from '../../architecture-checkpoints/index.js';
import type {
  GovernanceModel,
  GovernanceValidationResult,
  ProgramState,
} from '../../architecture-checkpoints/index.js';
import {
  GovernanceStateValidationError,
} from '../types.js';

export const DEFAULT_GOVERNANCE_DIR = 'spec/development-state';
export const GOVERNANCE_MODEL_FILE = 'governance-model.json';
export const GOVERNANCE_PROGRAM_FILE = 'program-state.json';

export interface LoadedGovernanceState {
  model: GovernanceModel;
  program: ProgramState;
  validation: GovernanceValidationResult;
  /** The resolved repository root the state was loaded from. */
  repoRoot: string;
}

export interface FileSystemGovernanceStateLoaderOptions {
  /** The repository root (the checkout whose `spec/development-state/` is canonical). */
  repoRoot: string;
  /** The governance directory relative to the repository root. */
  governanceDir?: string;
}

export class FileSystemGovernanceStateLoader {
  private readonly repoRoot: string;
  private readonly governanceDir: string;

  constructor(options: FileSystemGovernanceStateLoaderOptions) {
    this.repoRoot = resolve(options.repoRoot);
    // `governanceDir` may be relative to the repository root (the canonical
    // `spec/development-state`) or ABSOLUTE (test fixtures) — resolve handles
    // both; enforcement references always resolve against `repoRoot`.
    this.governanceDir = resolve(this.repoRoot, options.governanceDir ?? DEFAULT_GOVERNANCE_DIR);
  }

  /** Loads + validates the artifacts; throws GovernanceStateValidationError on any violation. */
  async load(): Promise<LoadedGovernanceState> {
    const { model, program } = await this.readArtifacts();
    const validation = await validateGovernanceState(model, program, this.readFile(), this.listDir());
    if (!validation.ok) {
      throw new GovernanceStateValidationError(validation.violations);
    }
    return { model, program, validation, repoRoot: this.repoRoot };
  }

  /** Loads + validates WITHOUT throwing on validation failure (discrimination tests inspect violations). */
  async inspect(): Promise<LoadedGovernanceState> {
    const { model, program } = await this.readArtifacts();
    const validation = await validateGovernanceState(model, program, this.readFile(), this.listDir());
    return { model, program, validation, repoRoot: this.repoRoot };
  }

  /** The repository-bound file reader (ENOENT → null; other failures propagate). */
  private readFile() {
    return async (path: string): Promise<string | null> => {
      try {
        return await readFile(join(this.repoRoot, path), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    };
  }

  /**
   * The repository-bound directory lister for the work-order identity
   * surface (the 2026-08-29 identity resolution): entry names, `[]` when the
   * directory does not exist (ungoverned repositories); failures propagate
   * (fail closed).
   */
  private listDir() {
    return async (path: string): Promise<readonly string[]> => {
      try {
        return await readdir(join(this.repoRoot, path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    };
  }

  private async readArtifacts(): Promise<{ model: GovernanceModel; program: ProgramState }> {
    const modelPath = join(this.governanceDir, GOVERNANCE_MODEL_FILE);
    const programPath = join(this.governanceDir, GOVERNANCE_PROGRAM_FILE);
    let modelText: string;
    let programText: string;
    try {
      modelText = await readFile(modelPath, 'utf8');
      programText = await readFile(programPath, 'utf8');
    } catch (err) {
      throw new GovernanceStateValidationError([
        `the canonical development-governance artifacts could not be read from ${join(this.governanceDir)}: ` +
          String(err instanceof Error ? err.message : err),
      ]);
    }
    let model: unknown;
    let program: unknown;
    try {
      model = JSON.parse(modelText);
      program = JSON.parse(programText);
    } catch (err) {
      throw new GovernanceStateValidationError([
        `the development-governance artifacts do not parse: ${String(err instanceof Error ? err.message : err)}`,
      ]);
    }
    return { model: model as GovernanceModel, program: program as ProgramState };
  }
}
