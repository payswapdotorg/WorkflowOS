import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WORK-066 — module composition: the scheduler is constructed through the
 * EXISTING application composition (buildApp) and exposed on AppDeps for the
 * future governed consumers (the runtime drive surfaces — job handlers, the
 * dogfooding experiment — are FUTURE decisions; this Work Order wires the
 * service, not a background scheduler).
 *
 * The wiring is proven by construction here + pinned statically on the
 * source (the established WORK-064/065 composition-test pattern — pglite
 * cannot call buildApp directly).
 */
import {
  buildSchedulerStack,
  syntheticMatchedJourneys,
  previewEnvironment,
  productionEnvironment,
  synthetic,
} from './helpers.js';
import type { ScheduleValidationTriggerInput } from '../../src/validation-scheduling/index.js';

const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP_TS = join(BACKEND_ROOT, 'src', 'app.ts');

describe('WORK-066 module composition — the scheduler through the existing composition', () => {
  let stack: ReturnType<typeof buildSchedulerStack>;
  let projectId: string;

  beforeAll(() => {
    stack = buildSchedulerStack();
    projectId = 'proj-composition-1';
  });

  it('RUNTIME: the stack (the WORK-064 service + the in-memory claim store + the injected clock) drives the full scheduling lifecycle', async () => {
    const input: ScheduleValidationTriggerInput = {
      trigger: 'PR',
      projectId,
      assurance: 'STANDARD',
      journeys: syntheticMatchedJourneys,
      previewEnvironment,
      productionEnvironment,
      identitySource: synthetic,
      revision: 'rev-composition-1',
    };
    const decision = await stack.scheduler.scheduleValidationTrigger(input);
    expect(decision.outcome).toBe('scheduled');
    // The admitted runs exist at the WORK-064 authority:
    for (const leg of decision.legs) {
      for (const j of leg.journeys.filter((x) => x.outcome === 'scheduled')) {
        const run = await stack.continuousValidationService.findRun(j.runId!);
        expect(run).not.toBeNull();
      }
    }
  });

  it('COMPOSITION: app.ts constructs DefaultValidationScheduler from the WORK-064 service + the in-memory claim store + an INJECTED clock and exposes it on AppDeps', () => {
    expect(existsSync(APP_TS), 'src/app.ts must exist').toBe(true);
    const appSource = readFileSync(APP_TS, 'utf8');
    // The composition constructs the scheduler:
    expect(appSource).toMatch(/validationScheduler = new DefaultValidationScheduler\(/);
    // ...from the WORK-064 service (the admission authority):
    expect(appSource).toMatch(/continuousValidationService: continuousValidationService!/);
    // ...with the in-memory claim-store adapter (the non-durable boundary):
    expect(appSource).toMatch(/claimStore: new InMemoryScheduledTriggerClaimStore\(\)/);
    // ...with an EXPLICITLY injected clock (never implicit module time):
    expect(appSource).toMatch(/now: \(\) => new Date\(\)/);
    // ...and exposes it on AppDeps:
    expect(appSource).toMatch(/validationScheduler\?: ValidationScheduler/);
    expect(appSource).toMatch(/import \{[^}]*DefaultValidationScheduler[^}]*\} from '\.\/validation-scheduling\/index\.js'/);
  });

  it('COMPOSITION: the barrel re-exports the WORK-064 trigger vocabulary (single import surface — the scheduler invents no trigger kinds)', () => {
    const barrel = readFileSync(join(BACKEND_ROOT, 'src', 'validation-scheduling', 'index.ts'), 'utf8');
    expect(barrel).toMatch(/VALIDATION_TRIGGERS/);
    expect(barrel).toMatch(/TRIGGER_MODE_BINDING/);
    // The vocabulary is imported from the WORK-064 authority, not declared here:
    expect(barrel).toMatch(/'\.\.\/continuous-validation\/types\.js'/);
    const types = readFileSync(join(BACKEND_ROOT, 'src', 'validation-scheduling', 'types.ts'), 'utf8');
    expect(types).not.toMatch(/export const VALIDATION_TRIGGERS/); // never re-declared
  });
});
