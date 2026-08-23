/**
 * WORK-026: Fake deployment provider — deterministic for CI/tests.
 *
 * Implements the same {@link DeploymentProvider} interface as
 * {@link VercelDeploymentProvider} but produces deterministic, network-free
 * outputs. The composition root wires this adapter in when no real Vercel
 * credentials are present (CI, dev, tests). It MUST NOT be used in
 * production roles (static-architecture test enforces).
 *
 * Determinism contract:
 *   - `createProject(projectId=X)` → `fake-project-<X[0:8]>`
 *   - `linkRepository(...)`        → same external id + `linkedRepo` echoed in metadata
 *   - `getDeployment({ commitSha })` → Deployment with previewUrl
 *     `https://fake-preview-<sha[0:8]>.example.com`
 *   - `getPreviewUrl`              → same URL (null when commitSha absent)
 *   - `getDeploymentStatus`        → `'ready'` (always)
 *
 * This file is private to /runtime (PLAT-AC-02).
 */
import type {
  Deployment,
  DeploymentProvider,
  DeploymentStatus,
  GetDeploymentInput,
  LinkRepositoryInput,
} from './runtime.types.js';

const EPOCH = new Date(0);

export class FakeDeploymentProvider implements DeploymentProvider {
  readonly name = 'fake';

  async health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'> {
    return 'test-mode';
  }

  async createProject(input: {
    projectId: string;
    name: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ projectExternalId: string; metadata: Record<string, unknown> }> {
    return {
      projectExternalId: `fake-project-${input.projectId.slice(0, 8)}`,
      metadata: { fake: true },
    };
  }

  async linkRepository(
    input: LinkRepositoryInput,
  ): Promise<{ projectExternalId: string; metadata: Record<string, unknown> }> {
    return {
      projectExternalId: `fake-project-${input.projectId.slice(0, 8)}`,
      metadata: {
        fake: true,
        linkedRepo: input.repositoryRef,
      },
    };
  }

  async getDeployment(input: GetDeploymentInput): Promise<Deployment | null> {
    if (!input.commitSha) return null;
    const sha8 = input.commitSha.slice(0, 8);
    const previewUrl = `https://fake-preview-${sha8}.example.com`;
    return {
      id: `fake-deployment-${sha8}`,
      // The provider layer does not know the DB integration id; this is a
      // transient lookup view used by getPreviewUrl/getDeploymentStatus.
      integrationId: '',
      externalId: `fake-deployment-${sha8}`,
      status: 'ready',
      previewUrl,
      commitSha: input.commitSha,
      branch: input.branch ?? null,
      metadata: { fake: true },
      createdAt: EPOCH,
      updatedAt: EPOCH,
    };
  }

  async getPreviewUrl(input: {
    projectId: string;
    commitSha?: string;
    branch?: string;
  }): Promise<string | null> {
    if (!input.commitSha) return null;
    return `https://fake-preview-${input.commitSha.slice(0, 8)}.example.com`;
  }

  async getDeploymentStatus(_input: GetDeploymentInput): Promise<DeploymentStatus | null> {
    return 'ready';
  }
}
