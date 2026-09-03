/**
 * V2-012 — the deterministic in-memory TEST payment adapter.
 *
 * The reference implementation of the MarketplacePaymentAdapter port (the
 * frozen V2-012 rule: NO real payment provider is ever called; payment
 * processors are external adapters behind this boundary). This adapter is
 * 100% deterministic: charges either succeed with a sequential receipt
 * reference or fail with a fixed typed code when pre-configured to fail
 * (a simulated processor outage — the "payment processor failure cannot
 * create a false entitlement" regression). It holds NO provider semantics:
 * no webhooks, no cards, no bank data, no processor state — only the
 * normalized marketplace facts it is handed.
 */
import type {
  MarketplacePaymentAdapter,
  PaymentChargeRequest,
  PaymentChargeResult,
  PaymentRefundResult,
} from '../types.js';

/** Fixed failure codes (stable, typed — never provider strings). */
export const IN_MEMORY_PAYMENT_FAILURE_CODES = {
  charge: 'test-adapter-configured-failure',
  refund: 'test-adapter-refund-failure',
} as const;

export interface InMemoryPaymentAdapterOptions {
  /**
   * Charge failures: transaction ids whose charge must fail (or `'*'` for
   * every charge — a simulated processor outage).
   */
  readonly failingChargeReferences?: readonly string[];
  /** Refund failures: adapter references whose refund must fail (or `'*'`). */
  readonly failingRefundReferences?: readonly string[];
}

/** One observed charge (the adapter's own log — test observability only). */
export interface ObservedCharge {
  readonly request: PaymentChargeRequest;
  readonly outcome: PaymentChargeResult;
}

/**
 * The deterministic in-memory test payment adapter. NO network, NO clocks,
 * NO randomness: the receipt counter is sequential and every outcome is a
 * pure function of the configured failure sets.
 */
export class InMemoryPaymentAdapter implements MarketplacePaymentAdapter {
  private readonly failingCharges: ReadonlySet<string>;
  private readonly failingRefunds: ReadonlySet<string>;
  private readonly charges: ObservedCharge[] = [];
  private readonly refundedReferences: string[] = [];
  private receiptCounter = 0;

  constructor(options: InMemoryPaymentAdapterOptions = {}) {
    this.failingCharges = new Set(options.failingChargeReferences ?? []);
    this.failingRefunds = new Set(options.failingRefundReferences ?? []);
  }

  async charge(request: PaymentChargeRequest): Promise<PaymentChargeResult> {
    const mustFail =
      this.failingCharges.has('*') || this.failingCharges.has(request.transactionId);
    const outcome: PaymentChargeResult = mustFail
      ? { ok: false, failureCode: IN_MEMORY_PAYMENT_FAILURE_CODES.charge }
      : { ok: true, adapterReference: `pay_${(this.receiptCounter += 1)}` };
    this.charges.push({ request, outcome });
    return outcome;
  }

  async refund(adapterReference: string): Promise<PaymentRefundResult> {
    if (this.failingRefunds.has('*') || this.failingRefunds.has(adapterReference)) {
      return { ok: false, failureCode: IN_MEMORY_PAYMENT_FAILURE_CODES.refund };
    }
    this.refundedReferences.push(adapterReference);
    return { ok: true, failureCode: null };
  }

  /** The observed charges, in order (test observability only). */
  chargeLog(): readonly ObservedCharge[] {
    return [...this.charges];
  }

  /** The refunded adapter references, in order (test observability only). */
  refundLog(): readonly string[] {
    return [...this.refundedReferences];
  }
}
