/**
 * WORK-038: Existing Project Onboarding — the application-layer orchestrator
 * barrel.
 *
 * This directory is NOT a frozen module (it is not under src/modules/) and is
 * NOT an authority. It is an ONBOARDING/APPLICATION CAPABILITY that composes
 * the EXISTING domain authorities (/github, /projects, /agents) to produce
 * evidence-backed Project Baseline proposals. It owns NO tables; the baseline
 * is stored THROUGH /projects (the single project authority).
 *
 * The barrel exposes only the orchestrator's PUBLIC contracts (the service +
 * ports + DTOs). Concrete implementations (the default service + the governed
 * analyzer) stay in internal/ and are wired by the composition root (app.ts).
 */
export type {
  ProjectScopedPolicyGate,
  RepositoryContentPort,
  RepositoryAnalyzer,
  AnalysisContext,
  AnalysisResult,
  ResolvedRepositoryLink,
  OnboardRepositoryInput,
  OnboardResult,
  OnboardingService,
  GovernedReadRequest,
  GovernedReadOutcome,
} from './onboarding.types.js';
export type { ToolPolicyRequest } from './onboarding.types.js';

export type { DefaultOnboardingService } from './internal/default-onboarding-service.js';
export type { DefaultOnboardingServiceDeps } from './internal/default-onboarding-service.js';
export type { GovernedFilesystemAnalyzer } from './internal/governed-filesystem-analyzer.js';
export type { GovernedFilesystemAnalyzerDeps } from './internal/governed-filesystem-analyzer.js';
// WORK-038 PR #42 fix: the PRODUCTION RepositoryContentPort wiring (delegates
// to the /github GitHubAdapter — the only SDK caller). Type-only re-export
// (the composition root in app.ts instantiates it).
export type { GitHubRepositoryContentPort } from './internal/github-content-port.js';
