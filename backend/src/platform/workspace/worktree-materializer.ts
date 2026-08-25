/**
 * WORK-035: the worktree-materializer PORT — the platform's
 * provider-independent contract for materializing isolated git worktrees.
 *
 * The port lives in PLATFORM (not /agents) because the concrete
 * implementations are execution infrastructure (git + filesystem), like
 * platform/storage's ObjectStore: the dependency direction is
 * domain (agents) → platform (this port), never platform → domain.
 *
 * All operations are IDEMPOTENT by contract (the deterministic worktree
 * path makes re-materialization after a crash safe):
 *   * materialize: create the worktree at the deterministic path if
 *     absent; re-use it when consistent with the request.
 *   * remove: delete the worktree (absent = success — cleanup idempotency).
 */
import type { WorktreeMaterializerInput, WorktreeRemoveInput } from './worktree-materializer.types.js';
export type { WorktreeMaterializer } from './worktree-materializer.types.js';
export { WorktreeMaterializerError } from './worktree-materializer.types.js';
export type { WorktreeMaterializerInput, WorktreeRemoveInput };
void (null as unknown as WorktreeMaterializerInput | WorktreeRemoveInput);
