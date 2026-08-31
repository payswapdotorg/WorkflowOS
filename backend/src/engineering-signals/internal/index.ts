/**
 * WORK-067 — the internal composition surface: the default service + the
 * in-memory repository adapter (re-exported through the public barrel).
 */
export { DefaultEngineeringSignalService } from './engineering-signal-service.js';
export type { EngineeringSignalServiceDeps } from './engineering-signal-service.js';
export { InMemoryEngineeringSignalRepository } from './in-memory-signal-repository.js';
