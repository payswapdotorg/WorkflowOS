import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import { getExecutionContext } from './execution-context.js';

/**
 * Structured logger used by every WorkflowOS runtime path.
 *
 * The logger is execution-aware: every log line automatically includes the
 * active {@link ExecutionContext.executionId} and `correlationId` when a
 * context is active (OBS-AC-02). When no context is active (e.g. startup), the
 * fields are omitted.
 *
 * The underlying implementation is `pino`. The {@link createLogger} factory
 * accepts a custom destination stream so tests can capture structured log
 * output.
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  level?: string;
  service?: string;
  destination?: DestinationStream;
}

/**
 * Create a structured, execution-aware logger.
 *
 * @param opts.destination Optional writable stream for log output. Defaults to
 *   `process.stdout`. Tests pass a capturing destination to assert that log
 *   lines include the execution id (OBS-AC-02).
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const base = pino({
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.service ?? 'workflowos' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Force newline-delimited JSON for deterministic test capture.
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  }, opts.destination ?? process.stdout);
  return wrapPino(base);
}

function wrapPino(p: PinoLogger): Logger {
  const contextual = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (msg: string, meta?: Record<string, unknown>): void => {
      const ctx = getExecutionContext();
      const merged: Record<string, unknown> = { ...(meta ?? {}) };
      if (ctx) {
        merged.executionId = ctx.executionId;
        if (ctx.correlationId && ctx.correlationId !== ctx.executionId) {
          merged.correlationId = ctx.correlationId;
        }
        if (ctx.actor) merged.actor = ctx.actor;
        if (ctx.requestId) merged.requestId = ctx.requestId;
      }
      p[level](merged, msg);
    };
  return {
    debug: contextual('debug'),
    info: contextual('info'),
    warn: contextual('warn'),
    error: contextual('error'),
    child(bindings) {
      return wrapPino(p.child(bindings));
    },
  };
}
