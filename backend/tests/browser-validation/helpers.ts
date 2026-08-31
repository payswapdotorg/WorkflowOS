/**
 * WORK-065 test helpers — a deterministic FakeBrowserDriver + a minimal
 * FakeVerificationService (the only /verification method the browser agent
 * consumes through the WORK-064 evidence-mapping boundary is attachEvidence).
 *
 * These keep the agent unit tests deterministic + free of the pglite stack
 * (the real-stack integration test lives in real-browser-execution.test.ts).
 */
import type {
  BrowserDriver,
  BrowserDriverCallOptions,
  BrowserNavigationResult,
  BrowserActionResult,
  BrowserExtractionResult,
  BrowserScreenshotResult,
} from '@platform/tools/browser-tool-executor.js';
import type {
  VerificationService,
  Evidence,
  CreateEvidenceInput,
  VerificationRun,
  CriterionEvidenceMapping,
  CriterionEvaluation,
  RequirementDerivation,
  CreateVerificationRunInput,
  CreateMapInput,
} from '@modules/verification/index.js';

// ---------------------------------------------------------------------------
// FakeBrowserDriver — deterministic, scriptable, records every call
// ---------------------------------------------------------------------------

/** A scripted response for a driver call (by operation kind + selector/url). */
export interface FakeBrowserScript {
  /** navigate results keyed by url (a list so repeated navigations advance). */
  readonly navigate?: ReadonlyArray<BrowserNavigationResult | Error>;
  /** click results keyed by selector (a list so repeated clicks advance). */
  readonly click?: ReadonlyArray<BrowserActionResult | Error>;
  /** type results keyed by selector (a list so repeated types advance). */
  readonly type?: ReadonlyArray<BrowserActionResult | Error>;
  /** extract results keyed by selector (a list so repeated extracts advance). */
  readonly extract?: ReadonlyArray<BrowserExtractionResult | Error>;
  /** screenshot results (a list so repeated screenshots advance). */
  readonly screenshot?: ReadonlyArray<BrowserScreenshotResult | Error>;
}

/** The recorded driver call (for assertion in tests). */
export interface RecordedDriverCall {
  readonly operation: 'open' | 'click' | 'type' | 'extract' | 'screenshot';
  readonly selector?: string;
  readonly url?: string;
  readonly text?: string;
  readonly timeoutMs: number;
}

/**
 * A deterministic, scriptable BrowserDriver. Each operation pops the next
 * scripted response (a list per operation kind); a scripted Error is thrown
 * (so tests simulate timeouts/crashes). Calls are recorded for assertion.
 */
export class FakeBrowserDriver implements BrowserDriver {
  private readonly navigateQueue: ReadonlyArray<BrowserNavigationResult | Error>;
  private readonly clickQueue: ReadonlyArray<BrowserActionResult | Error>;
  private readonly typeQueue: ReadonlyArray<BrowserActionResult | Error>;
  private readonly extractQueue: ReadonlyArray<BrowserExtractionResult | Error>;
  private readonly screenshotQueue: ReadonlyArray<BrowserScreenshotResult | Error>;
  private readonly calls: RecordedDriverCall[] = [];

  constructor(script: FakeBrowserScript = {}) {
    this.navigateQueue = script.navigate ?? [];
    this.clickQueue = script.click ?? [];
    this.typeQueue = script.type ?? [];
    this.extractQueue = script.extract ?? [];
    this.screenshotQueue = script.screenshot ?? [];
  }

  /** The recorded driver calls (in order). */
  get recordedCalls(): readonly RecordedDriverCall[] {
    return this.calls;
  }

  async open(url: string, opts: BrowserDriverCallOptions): Promise<BrowserNavigationResult> {
    this.calls.push({ operation: 'open', url, timeoutMs: opts.timeoutMs });
    return this.pop(this.navigateQueue, 'navigate');
  }
  async click(selector: string, opts: BrowserDriverCallOptions): Promise<BrowserActionResult> {
    this.calls.push({ operation: 'click', selector, timeoutMs: opts.timeoutMs });
    return this.pop(this.clickQueue, 'click');
  }
  async type(selector: string, text: string, opts: BrowserDriverCallOptions): Promise<BrowserActionResult> {
    this.calls.push({ operation: 'type', selector, text, timeoutMs: opts.timeoutMs });
    return this.pop(this.typeQueue, 'type');
  }
  async extract(selector: string, opts: BrowserDriverCallOptions): Promise<BrowserExtractionResult> {
    this.calls.push({ operation: 'extract', selector, timeoutMs: opts.timeoutMs });
    return this.pop(this.extractQueue, 'extract');
  }
  async screenshot(opts: BrowserDriverCallOptions): Promise<BrowserScreenshotResult> {
    this.calls.push({ operation: 'screenshot', timeoutMs: opts.timeoutMs });
    return this.pop(this.screenshotQueue, 'screenshot');
  }

  private pop<T>(queue: ReadonlyArray<T | Error>, what: string): T {
    // Use the call count for THIS operation kind to advance the right queue.
    // (Simplest correct behavior: each operation consumes from its own queue
    // in order; tests script enough responses for every call.)
    const opCount = this.calls.filter((c) => c.operation === this.lastOp()).length - 1;
    const value = queue[opCount];
    if (value instanceof Error) throw value;
    if (value === undefined) {
      // Default: a successful empty result (so an unscripted call doesn't crash).
      switch (what) {
        case 'navigate':
          return { finalUrl: 'https://example.com', status: 200, title: 'Example' } as unknown as T;
        case 'click':
        case 'type':
          return { matched: true, finalUrl: 'https://example.com' } as unknown as T;
        case 'extract':
          return { matched: true, text: '', finalUrl: 'https://example.com' } as unknown as T;
        case 'screenshot':
          return { base64: '', finalUrl: 'https://example.com' } as unknown as T;
        default:
          throw new Error(`fake browser driver: unknown operation ${what}`);
      }
    }
    return value;
  }

  private lastOp(): RecordedDriverCall['operation'] {
    return this.calls[this.calls.length - 1]!.operation;
  }
}

// ---------------------------------------------------------------------------
// FakeVerificationService — minimal stub (only attachEvidence is exercised)
// ---------------------------------------------------------------------------

/** The recorded attachEvidence call (for assertion). */
export interface RecordedAttachEvidenceCall {
  readonly projectId: string;
  readonly verificationRunId: string;
  readonly evidenceType: string;
  readonly provider: string;
  readonly result: string;
  readonly contentSummary: string | null;
}

/**
 * A minimal VerificationService stub: only `attachEvidence` is implemented
 * (the sole method the WORK-064 evidence-mapping boundary calls). Every
 * other method throws — the browser agent does NOT touch them (static-
 * architecture invariant: no second verification authority). The stub records
 * every attachEvidence call so tests assert the mapping.
 */
export class FakeVerificationService implements VerificationService {
  private readonly attachCalls: RecordedAttachEvidenceCall[] = [];
  /** When set, attachEvidence throws this (the agent records a null reference). */
  public attachEvidenceShouldThrow: Error | null = null;

  /** The recorded attachEvidence calls. */
  get recordedAttachCalls(): readonly RecordedAttachEvidenceCall[] {
    return this.attachCalls;
  }

  async attachEvidence(input: CreateEvidenceInput): Promise<Evidence> {
    if (this.attachEvidenceShouldThrow) throw this.attachEvidenceShouldThrow;
    this.attachCalls.push({
      projectId: input.projectId,
      verificationRunId: input.verificationRunId,
      evidenceType: input.evidenceType,
      provider: input.provider,
      result: input.result ?? 'unknown',
      contentSummary: input.contentSummary ?? null,
    });
    return {
      id: `evidence_${this.attachCalls.length}`,
      verificationRunId: input.verificationRunId,
      evidenceType: input.evidenceType,
      provider: input.provider,
      authority: 'claim',
      result: input.result ?? 'unknown',
      contentSummary: input.contentSummary ?? null,
      storageKey: null,
      storageProvider: null,
      artifactDigest: null,
      artifactSizeBytes: null,
      artifactContentType: null,
      metadata: input.metadata ?? {},
      createdAt: new Date('2026-08-30T12:00:00.000Z'),
      updatedAt: new Date('2026-08-30T12:00:00.000Z'),
    } as Evidence;
  }

  // The browser agent never calls these (static-architecture invariant).
  async createRun(_input: CreateVerificationRunInput): Promise<VerificationRun> {
    throw new Error('FakeVerificationService.createRun: not used by the browser agent (no second verification authority)');
  }
  async findRun(_id: string): Promise<VerificationRun | null> {
    throw new Error('FakeVerificationService.findRun: not used by the browser agent');
  }
  async attachCiEvidence(_input: { verificationRunId: string; ciEvidenceId: string }): Promise<Evidence> {
    throw new Error('FakeVerificationService.attachCiEvidence: not used by the browser agent');
  }
  async mapEvidenceToCriterion(_input: CreateMapInput): Promise<CriterionEvidenceMapping> {
    throw new Error('FakeVerificationService.mapEvidenceToCriterion: not used by the browser agent (no criterion evaluation)');
  }
  async evaluateCriterion(_input: { verificationRunId: string; criterionId: string }): Promise<CriterionEvaluation> {
    throw new Error('FakeVerificationService.evaluateCriterion: not used by the browser agent');
  }
  async evaluateForRun(_verificationRunId: string): Promise<{ run: VerificationRun; criteria: CriterionEvaluation[]; requirements: RequirementDerivation[] }> {
    throw new Error('FakeVerificationService.evaluateForRun: not used by the browser agent');
  }
  async persistEvaluations(_verificationRunId: string): Promise<{ run: VerificationRun; criteria: CriterionEvaluation[]; requirements: RequirementDerivation[] }> {
    throw new Error('FakeVerificationService.persistEvaluations: not used by the browser agent');
  }
  async listRunsForWorkItem(_workItemId: string): Promise<VerificationRun[]> {
    throw new Error('FakeVerificationService.listRunsForWorkItem: not used by the browser agent');
  }
  async listRunsForProject(_projectId: string, _opts?: { limit?: number }): Promise<VerificationRun[]> {
    throw new Error('FakeVerificationService.listRunsForProject: not used by the browser agent');
  }
  async listEvidenceForRun(_verificationRunId: string): Promise<Evidence[]> {
    throw new Error('FakeVerificationService.listEvidenceForRun: not used by the browser agent');
  }
  async listMappingsForRun(_verificationRunId: string): Promise<CriterionEvidenceMapping[]> {
    throw new Error('FakeVerificationService.listMappingsForRun: not used by the browser agent');
  }
  // WORK-051 orchestration finalize (not used by the browser agent).
  async finalizeOrchestrationRun(_input: unknown): Promise<VerificationRun> {
    throw new Error('FakeVerificationService.finalizeOrchestrationRun: not used by the browser agent');
  }
  async findOrchestrationRun(_orchestrationKey: string): Promise<VerificationRun | null> {
    throw new Error('FakeVerificationService.findOrchestrationRun: not used by the browser agent');
  }
  async recordOrchestrationRun(_input: unknown): Promise<{ run: VerificationRun; created: boolean }> {
    throw new Error('FakeVerificationService.recordOrchestrationRun: not used by the browser agent');
  }
}
