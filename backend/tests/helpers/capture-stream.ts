import { Writable, type WritableOptions } from 'node:stream';

/**
 * In-memory writable stream used to capture pino's newline-delimited JSON
 * output in tests. Each `write` buffers the line; tests call `lines()` or
 * `json()` to read structured records.
 */
export class CaptureStream extends Writable {
  private readonly chunks: string[] = [];
  constructor(opts?: WritableOptions) {
    super({ ...opts, decodeStrings: true });
  }
  override _write(chunk: Buffer | string, _enc: string, done: () => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    done();
  }
  /** Raw concatenated output. */
  raw(): string {
    return this.chunks.join('');
  }
  /** Individual newline-delimited records (raw strings). */
  lines(): string[] {
    return this.raw().split('\n').filter((l) => l.length > 0);
  }
  /** Parsed JSON records. */
  json(): unknown[] {
    return this.lines().map((line) => JSON.parse(line));
  }
  /** Reset captured output. */
  reset(): void {
    this.chunks.length = 0;
  }
}
