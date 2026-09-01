/**
 * WORK-069 — the composition defaults (the in-memory adapters exported
 * through the public barrel for direct tests, the WORK-064/066/067
 * precedent).
 */
export { InMemoryProgressiveReleaseDecisionRepository } from './in-memory-decision-repository.js';
export { RuntimeModuleDeploymentObservationReader } from './runtime-observation-reader.js';
export { DefaultProgressiveReleaseService } from './progressive-release-service.js';
export { derivePriorRolloutState } from './progressive-release-service.js';
