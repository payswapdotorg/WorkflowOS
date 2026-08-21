import { describe, it, expect, beforeEach } from 'vitest';
import { createLogger } from '@platform/logger.js';
import { runWithExecutionContext } from '@platform/execution-context.js';
import { CaptureStream } from '../helpers/capture-stream.js';

describe('logger', () => {
  let capture: CaptureStream;

  beforeEach(() => {
    capture = new CaptureStream();
  });

  it('emits newline-delimited JSON with level, msg, and timestamp', () => {
    const logger = createLogger({ level: 'info', destination: capture });
    logger.info('hello.world', { foo: 'bar' });
    const records = capture.json() as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe('hello.world');
    expect(records[0]?.level).toBe('info');
    expect(records[0]?.foo).toBe('bar');
    expect(records[0]?.time).toBeTruthy();
    expect(records[0]?.service).toBe('workflowos');
  });

  it('includes executionId when a context is active (OBS-AC-02)', async () => {
    const logger = createLogger({ level: 'info', destination: capture });
    await runWithExecutionContext({ executionId: 'wf_logger1' }, async () => {
      logger.info('within.context', { kind: 'unit' });
    });
    const records = capture.json() as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.executionId).toBe('wf_logger1');
    expect(records[0]?.kind).toBe('unit');
  });

  it('omits executionId when no context is active', () => {
    const logger = createLogger({ level: 'info', destination: capture });
    logger.info('no.context');
    const records = capture.json() as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect('executionId' in (records[0] ?? {})).toBe(false);
  });

  it('includes correlationId only when it differs from executionId', async () => {
    const logger = createLogger({ level: 'info', destination: capture });
    await runWithExecutionContext(
      { executionId: 'wf_exec_1', correlationId: 'wf_root_1' },
      async () => {
        logger.info('with.correlation');
      },
    );
    const records = capture.json() as Array<Record<string, unknown>>;
    expect(records[0]?.executionId).toBe('wf_exec_1');
    expect(records[0]?.correlationId).toBe('wf_root_1');
  });

  it('child loggers inherit the active execution context', async () => {
    const logger = createLogger({ level: 'info', destination: capture });
    await runWithExecutionContext({ executionId: 'wf_child1' }, async () => {
      logger.child({ component: 'worker' }).info('child.log');
    });
    const records = capture.json() as Array<Record<string, unknown>>;
    expect(records[0]?.executionId).toBe('wf_child1');
    expect(records[0]?.component).toBe('worker');
  });

  it('respects log level', () => {
    const logger = createLogger({ level: 'warn', destination: capture });
    logger.info('should.be.silent');
    logger.warn('should.be.emitted');
    const records = capture.json() as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe('should.be.emitted');
  });
});
