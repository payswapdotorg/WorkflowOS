/**
 * repository-intelligence module — public interface.
 *
 * Canonical name: WORK-039 (Repository and Context Intelligence).
 * Responsibility (spec/work-items.md): build persistent repository, dependency,
 * architecture, symbol, API, test, runtime, and historical context used to
 * assemble better implementation and maintenance contexts.
 *
 * This directory is NOT a frozen module (it is not under src/modules/). It is
 * an APPLICATION/CONTEXT-INTELLIGENCE CAPABILITY (analogous to src/onboarding/,
 * src/execution-policy/, src/benchmark/). It consumes the EXISTING domain
 * authorities (/projects, /github, /architecture, /requirements, /work-items,
 * /agents) to produce ranked, explainable, provenance-preserving context
 * selections stored THROUGH the existing /projects authority (the context
 * index is a PROJECT artifact, like ProjectBaseline).
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this capability; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * The barrel is TYPES-ONLY — no concrete implementations are exported (the
 * composition root in src/app.ts wires the concrete DefaultRepositoryIntelligenceService
 * + DeterministicContextRanker + BaselineContextSource + NoOpHostInspector by
 * importing from internal/, the sanctioned wiring boundary). This mirrors the
 * WORK-038 onboarding barrel convention + the frozen-module barrel rule.
 */
export type {
  ContextIndexQuery,
  ContextQueryTerms,
  ContextSourceItem,
  ContextSource,
  RankedContextItem,
  ContextRanker,
  HostInspectionObservation,
  HostInspectionResult,
  GovernedHostInspector,
  ContextResolutionContext,
  ContextSelection,
  StaleReport,
  BuildIndexResult,
  RepositoryIntelligenceService,
  RepositoryIntelligenceServiceDeps,
  // Re-exported storage-layer types (so capability consumers import from this
  // barrel only — the route, the future execution layer).
  ProjectContextIndex,
  ContextItem,
  ContextItemKind,
  ContextItemSource,
  ContextItemProvenance,
  ContextIndexQueryKind,
  RepositoryIntelligenceError,
  RepositoryIntelligenceErrorCode,
  ProjectContextIndexRepository,
  ProjectBaselineRepository,
  GitHubAdapter,
  ProjectGitHubRepositoryRepository,
  ArchitectureVersionRepository,
  ArchitectureRepository,
  RequirementRepository,
  AcceptanceCriterionRepository,
  WorkItemRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
} from './repository-intelligence.types.js';
