/**
 * WORK-032: Benchmark routes — the HTTP surface for the benchmark domain.
 *
 * All routes are backend-authorized. The frontend is a consumer, never an
 * authority (§34: "frontend has no direct provider API access").
 *
 * Routes:
 *   POST /benchmarks/snapshots/preview       — preview a snapshot (§44)
 *   POST /benchmarks/snapshots               — freeze a snapshot (§4)
 *   GET  /benchmarks/snapshots               — list snapshots for a project
 *   GET  /benchmarks/snapshots/:id           — get a snapshot
 *   POST /benchmarks                         — create an experiment (§5)
 *   GET  /benchmarks                         — list experiments for a project (§49)
 *   GET  /benchmarks/:id                     — get an experiment
 *   POST /benchmarks/:id/start               — start (§45)
 *   POST /benchmarks/:id/pause               — pause (§45)
 *   POST /benchmarks/:id/cancel              — cancel (§45)
 *   GET  /benchmarks/:id/trials              — list trials (§49)
 *   GET  /benchmarks/trials/:trialId         — get a trial (§25)
 *   GET  /benchmarks/trials/:trialId/metrics — get trial metrics (§25)
 *   GET  /benchmarks/trials/:trialId/findings — list trial review findings (§13)
 *   POST /benchmarks/compare                 — side-by-side comparison (§26)
 *   GET  /benchmarks/:id/integrity           — integrity record (§32)
 *   GET  /benchmarks/:id/export              — export JSON/CSV (§40)
 *   GET  /benchmarks/:id/recommend           — recommendation (§42)
 *
 * Authorization: every route resolves the resource → project → runs
 * requireProjectAuthorization BEFORE returning any data (no cross-tenant
 * existence oracle, same pattern as execution.route.ts) AND BEFORE any
 * mutation — including the post-authorization `recoverExperimentIfStale`
 * recovery hook on GET /benchmarks/:id. The resource-UUID → projectId
 * resolution read is PURE (never mutates); the experiment UUID is NOT an
 * authorization credential.
 *
 * SECURITY: no route ever returns credentials, callback tokens, handoff
 * tokens, or cookies. The external_session_ref is an opaque provider-side
 * reference only.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { BenchmarkService, BenchmarkTrial } from '../../benchmark/index.js';
import type { BenchmarkExportFormat } from '../../benchmark/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface BenchmarkRouteDeps {
  authorizationService: AuthorizationService;
  benchmarkService: BenchmarkService;
}

export async function benchmarkRoutes(app: FastifyInstance, deps: BenchmarkRouteDeps): Promise<void> {
  const { benchmarkService } = deps;

  // --- Snapshots (§4, §44) ---

  app.post('/benchmarks/snapshots/preview', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: (req.body as { projectId?: string } | null)?.projectId ?? '',
      });
      if (!user) return;
      const body = req.body as { projectId: string; workItemId: string };
      const preview = await benchmarkService.previewSnapshot({
        projectId: body.projectId,
        workItemId: body.workItemId,
      });
      return reply.code(200).send({ preview });
    });
  });

  app.post('/benchmarks/snapshots', async (req, reply) => {
    return runAuthed(req, async () => {
      const body = req.body as { projectId: string; workItemId: string; name: string; description?: string; targetBranchPrefix?: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: body.projectId,
      });
      if (!user) return;
      // PR #35 review fix #5: `actor` comes from the authenticated identity,
      // NEVER from the request body. The request body cast above omits
      // `createdBy`/`actor` — they are server-derived only.
      const snapshot = await benchmarkService.createSnapshot({
        projectId: body.projectId,
        workItemId: body.workItemId,
        name: body.name,
        description: body.description,
        targetBranchPrefix: body.targetBranchPrefix,
        actor: user.id,
      });
      return reply.code(201).send({ snapshot });
    });
  });

  app.get('/benchmarks/snapshots', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.query as { projectId: string }).projectId;
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;
      const query = req.query as { limit?: string; offset?: string };
      const result = await benchmarkService.listSnapshots(projectId, {
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });
      return reply.code(200).send(result);
    });
  });

  app.get('/benchmarks/snapshots/:id', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      const snapshot = await benchmarkService.getSnapshot(id);
      if (!snapshot) return reply.code(404).send({ error: 'benchmark-snapshot-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: snapshot.projectId,
      });
      if (!user) return;
      return reply.code(200).send({ snapshot });
    });
  });

  // --- Experiments (§5, §45) ---

  app.post('/benchmarks', async (req, reply) => {
    return runAuthed(req, async () => {
      // PR #35 review fix #5: `createdBy` is NOT accepted from the request
      // body. The authenticated user identity (`user.id`) is the only
      // source of the experiment's `createdBy` + audit `actor`.
      const body = req.body as {
        projectId: string;
        benchmarkTaskSnapshotId: string;
        name: string;
        description?: string;
        trials: { provider: string; model?: string; mode: 'native' | 'external'; repetitions?: number }[];
        randomizeOrder?: boolean;
        randomizationSeed?: string;
        repetitions?: number;
      };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: body.projectId,
      });
      if (!user) return;
      try {
        const experiment = await benchmarkService.createExperiment({
          projectId: body.projectId,
          benchmarkTaskSnapshotId: body.benchmarkTaskSnapshotId,
          name: body.name,
          description: body.description,
          trials: body.trials.map((t) => ({
            ...t,
            model: t.model ?? null,
            repetitions: t.repetitions ?? 1,
          })),
          randomizeOrder: body.randomizeOrder,
          randomizationSeed: body.randomizationSeed,
          repetitions: body.repetitions,
          createdBy: user.id,
        });
        return reply.code(201).send({ experiment });
      } catch (err) {
        return reply.code(400).send({ error: 'benchmark-create-failed', message: (err as Error).message });
      }
    });
  });

  app.get('/benchmarks', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.query as { projectId: string }).projectId;
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;
      const query = req.query as { limit?: string; offset?: string };
      const result = await benchmarkService.listExperiments(projectId, {
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });
      return reply.code(200).send(result);
    });
  });

  app.get('/benchmarks/:id', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      // PURE read — resolves the experiment's projectId for authorization.
      // PR #35 review fix (control-plane boundary): this read MUST NOT
      // mutate. The previous lazy-recovery hook in the service-level
      // getExperiment ran the recovery CAS + finalization + audits BEFORE
      // requireProjectAuthorization below, so an unauthorized caller
      // could mutate another project's experiment by knowing its UUID.
      // The experiment UUID is NOT an authorization credential.
      const experiment = await benchmarkService.getExperiment(id);
      if (!experiment) return reply.code(404).send({ error: 'benchmark-experiment-not-found' });
      // AUTHORIZE FIRST — before ANY mutation, including recovery.
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: experiment.projectId,
      });
      if (!user) return;
      // POST-AUTHORIZATION recovery (authorized control-plane path). Called
      // UNCONDITIONALLY — recoverExperimentIfStale internally decides what
      // (if anything) needs recovering + no-ops otherwise:
      //   * WORK-032 start-delivery durability: an incomplete start
      //     delivery (a start that crashed between the claim and full
      //     delivery) is replayed — exactly one BENCHMARK_STARTED audit +
      //     the missing benchmark.trial jobs.
      //   * PR #36 crash-safe completion: a stuck `finalizing`
      //     reservation with an expired lease is recovered to exactly one
      //     terminal state.
      // An unauthorized caller never reaches this line (403 above), so an
      // unauthorized read CANNOT mutate another project's experiment. NO
      // polling sweep, NO second execution engine (§34 invariant intact).
      const recovered = await benchmarkService.recoverExperimentIfStale(id);
      return reply.code(200).send({ experiment: recovered ?? experiment });
    });
  });

  app.post('/benchmarks/:id/start', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      const experiment = await benchmarkService.getExperiment(id);
      if (!experiment) return reply.code(404).send({ error: 'benchmark-experiment-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: experiment.projectId,
      });
      if (!user) return;
      try {
        const updated = await benchmarkService.startExperiment(id);
        return reply.code(200).send({ experiment: updated });
      } catch (err) {
        return reply.code(400).send({ error: 'benchmark-start-failed', message: (err as Error).message });
      }
    });
  });

  app.post('/benchmarks/:id/pause', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      const experiment = await benchmarkService.getExperiment(id);
      if (!experiment) return reply.code(404).send({ error: 'benchmark-experiment-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: experiment.projectId,
      });
      if (!user) return;
      const updated = await benchmarkService.pauseExperiment(id);
      return reply.code(200).send({ experiment: updated });
    });
  });

  app.post('/benchmarks/:id/cancel', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      const experiment = await benchmarkService.getExperiment(id);
      if (!experiment) return reply.code(404).send({ error: 'benchmark-experiment-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: experiment.projectId,
      });
      if (!user) return;
      const updated = await benchmarkService.cancelExperiment(id);
      return reply.code(200).send({ experiment: updated });
    });
  });

  // --- Trials (§25) ---

  app.get('/benchmarks/:id/trials', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      const experiment = await benchmarkService.getExperiment(id);
      if (!experiment) return reply.code(404).send({ error: 'benchmark-experiment-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: experiment.projectId,
      });
      if (!user) return;
      const query = req.query as { limit?: string; offset?: string };
      const result = await benchmarkService.listTrials(id, {
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });
      return reply.code(200).send(result);
    });
  });

  app.get('/benchmarks/trials/:trialId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { trialId } = req.params as { trialId: string };
      const trial = await benchmarkService.getTrial(trialId);
      if (!trial) return reply.code(404).send({ error: 'benchmark-trial-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: trial.projectId,
      });
      if (!user) return;
      return reply.code(200).send({ trial });
    });
  });

  app.get('/benchmarks/trials/:trialId/metrics', async (req, reply) => {
    return runAuthed(req, async () => {
      const { trialId } = req.params as { trialId: string };
      const trial = await benchmarkService.getTrial(trialId);
      if (!trial) return reply.code(404).send({ error: 'benchmark-trial-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: trial.projectId,
      });
      if (!user) return;
      const metrics = await benchmarkService.getTrialMetrics(trialId);
      return reply.code(200).send({ metrics });
    });
  });

  app.get('/benchmarks/trials/:trialId/findings', async (req, reply) => {
    return runAuthed(req, async () => {
      const { trialId } = req.params as { trialId: string };
      const trial = await benchmarkService.getTrial(trialId);
      if (!trial) return reply.code(404).send({ error: 'benchmark-trial-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: trial.projectId,
      });
      if (!user) return;
      const findings = await benchmarkService.listTrialFindings(trialId);
      return reply.code(200).send({ findings });
    });
  });

  // --- Comparison (§26) ---

  app.post('/benchmarks/compare', async (req, reply) => {
    return runAuthed(req, async () => {
      const body = req.body as { trialIds: string[] };
      if (!body.trialIds || body.trialIds.length < 2) {
        return reply.code(400).send({ error: 'benchmark-comparison-requires-at-least-two-trials' });
      }
      // PR #35 review fix #2: authorize ALL trials, not just trialIds[0].
      // The previous implementation authorized only the first trial's
      // project and then returned comparison data for every trial id —
      // leaking cross-tenant trial metadata when the caller mixed trials
      // from different projects.
      //
      // Flow:
      //   1. Load EVERY requested trial (reject missing → 404).
      //   2. Verify all trials share the same projectId + snapshotId
      //      (§27/§28/§29 equality invariants). If they span projects or
      //      snapshots → 403, NO project metadata returned.
      //   3. requireProjectAuthorization on the shared project.
      //   4. Perform the comparison.
      const trials: BenchmarkTrial[] = [];
      for (const id of body.trialIds) {
        const trial = await benchmarkService.getTrial(id);
        if (!trial) {
          return reply.code(404).send({ error: `benchmark-trial-not-found: ${id}` });
        }
        trials.push(trial);
      }
      const projectIds = new Set(trials.map((t) => t.projectId));
      const snapshotIds = new Set(trials.map((t) => t.benchmarkTaskSnapshotId));
      if (projectIds.size !== 1 || snapshotIds.size !== 1) {
        // Cross-tenant or cross-snapshot comparison — forbidden. No project
        // id or snapshot id is echoed back (no metadata leak).
        return reply.code(403).send({
          error: 'forbidden',
          reason: 'benchmark-comparison-trials-must-share-snapshot',
        });
      }
      const projectId = trials[0]!.projectId;
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;
      try {
        const comparison = await benchmarkService.compareTrials(body.trialIds);
        return reply.code(200).send({ comparison });
      } catch (err) {
        return reply.code(400).send({ error: 'benchmark-comparison-failed', message: (err as Error).message });
      }
    });
  });

  // --- Integrity (§32) ---

  app.get('/benchmarks/:id/integrity', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      const experiment = await benchmarkService.getExperiment(id);
      if (!experiment) return reply.code(404).send({ error: 'benchmark-experiment-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: experiment.projectId,
      });
      if (!user) return;
      const integrity = await benchmarkService.getIntegrity(id);
      return reply.code(200).send({ integrity });
    });
  });

  // --- Export (§40) ---

  app.get('/benchmarks/:id/export', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      const experiment = await benchmarkService.getExperiment(id);
      if (!experiment) return reply.code(404).send({ error: 'benchmark-experiment-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: experiment.projectId,
      });
      if (!user) return;
      const format = ((req.query as { format?: string }).format ?? 'json') as BenchmarkExportFormat;
      try {
        const result = await benchmarkService.exportExperiment(id, format);
        return reply
          .code(200)
          .header('Content-Type', result.contentType)
          .header('Content-Disposition', `attachment; filename="${result.filename}"`)
          .send(result.body);
      } catch (err) {
        return reply.code(400).send({ error: 'benchmark-export-failed', message: (err as Error).message });
      }
    });
  });

  // --- Recommendation (§42) ---

  app.get('/benchmarks/:id/recommend', async (req, reply) => {
    return runAuthed(req, async () => {
      const { id } = req.params as { id: string };
      const experiment = await benchmarkService.getExperiment(id);
      if (!experiment) return reply.code(404).send({ error: 'benchmark-experiment-not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: experiment.projectId,
      });
      if (!user) return;
      const recommendation = await benchmarkService.recommend(id);
      return reply.code(200).send({ recommendation });
    });
  });
}
