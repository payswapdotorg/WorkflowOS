/**
 * WORK-035: the worktree-materializer contract types (platform-owned).
 */
export interface WorktreeMaterializerInput {
  readonly worktreePathToken: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly branch: string;
  readonly baseRevision: string;
}

export interface WorktreeRemoveInput {
  readonly worktreePathToken: string;
}

export interface WorktreeMaterializer {
  /**
   * Materialize the worktree at the deterministic path. Returns the
   * resolved absolute host path. Throws WorktreeMaterializerError on
   * failure (the workspace records the failure stage).
   */
  materialize(input: WorktreeMaterializerInput): Promise<string>;

  /** Remove the worktree (idempotent: absent → success). */
  remove(input: WorktreeRemoveInput): Promise<void>;
}

/** The typed worktree-materialization failure (from the port). */
export class WorktreeMaterializerError extends Error {
  readonly stage: string;

  constructor(stage: string, message: string) {
    super(message);
    this.name = 'WorktreeMaterializerError';
    this.stage = stage;
  }
}
