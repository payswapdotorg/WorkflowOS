/**
 * S3-compatible ObjectStore adapter (PRODUCTION READINESS).
 *
 * Works with Cloudflare R2, AWS S3, MinIO, Backblaze B2, and any other
 * S3-compatible storage provider. Implements the existing {@link ObjectStore}
 * interface — no new architecture, no domain code changes.
 *
 * Configuration is through environment variables:
 *   OBJECT_STORAGE_PROVIDER   = "s3" (enables this adapter)
 *   OBJECT_STORAGE_BUCKET     = bucket name
 *   OBJECT_STORAGE_ENDPOINT   = S3 endpoint URL
 *   OBJECT_STORAGE_REGION     = region (e.g. "auto" for R2)
 *   OBJECT_STORAGE_ACCESS_KEY_ID     = access key
 *   OBJECT_STORAGE_SECRET_ACCESS_KEY = secret key
 *
 * For Cloudflare R2:
 *   OBJECT_STORAGE_ENDPOINT = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 *   OBJECT_STORAGE_REGION = auto
 */
import type {
  ObjectStore,
  PutObjectInput,
  PutObjectResult,
  StoredObject,
} from './object-store.js';
import { createHash, createHmac } from 'node:crypto';

export interface S3ObjectStoreConfig {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3ObjectStore implements ObjectStore {
  readonly provider = 's3';
  private readonly config: S3ObjectStoreConfig;

  constructor(config: S3ObjectStoreConfig) {
    this.config = config;
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const key = this.generateKey();
    const digest = createHash('sha256').update(input.body).digest('hex');
    await this.s3Request('PUT', key, input.body, input.contentType, input.metadata);
    return {
      key,
      provider: this.provider,
      contentLength: input.body.length,
      digestSha256: digest,
    };
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.s3Request('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 GET failed: ${res.status} ${res.statusText}`);
      const body = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') ?? undefined;
      return { key, body, contentType };
    } catch (err) {
      if ((err as Error).message.includes('404')) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.s3Request('DELETE', key);
    } catch {
      // Idempotent — deleting a non-existent key is OK.
    }
  }

  private generateKey(): string {
    const ts = Date.now()!;
    const rand = Math.random()!.toString(36)!.slice(2, 10)!;
    return `${ts}-${rand}`;
  }

  /**
   * Make an S3-compatible request using AWS Signature V4.
   * This is a minimal implementation — enough for R2/S3 put/get/delete
   * without pulling in the entire AWS SDK.
   */
  private async s3Request(
    method: string,
    key: string,
    body?: Buffer,
    contentType?: string,
    _metadata?: Record<string, string>,
  ): Promise<Response> {
    const url = `${this.config.endpoint}/${this.config.bucket}/${key}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body
      ? createHash('sha256').update(body).digest('hex')
      : 'UNSIGNED-PAYLOAD';

    const headers: Record<string, string> = {
      'Host': new URL(url).host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    if (contentType) headers['Content-Type'] = contentType;
    if (body) headers['Content-Length'] = String(body.length);

    // Build the canonical request + signature (AWS Signature V4)
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h.toLowerCase()}:${(headers[h] ?? '').trim()}\n`)
      .join('');
    const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort().join(';');
    const canonicalRequest = [
      method,
      `/${this.config.bucket}/${key}`,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const signingKey = this.getSigningKey(dateStamp);
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authHeader = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    headers['Authorization'] = authHeader;

    return fetch(url, {
      method,
      headers,
      body: body ? new Uint8Array(body) as BodyInit : undefined,
    });
  }

  private getSigningKey(dateStamp: string): Buffer {
    const kSecret = Buffer.from(`AWS4${this.config.secretAccessKey}`, 'utf8');
    const kDate = createHmac('sha256', kSecret).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(this.config.region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    return createHmac('sha256', kService).update('aws4_request').digest();
  }
}

/**
 * Create an S3-compatible ObjectStore from environment variables.
 * Returns undefined when OBJECT_STORAGE_PROVIDER != "s3".
 */
export function createS3ObjectStoreFromEnv(): S3ObjectStore | undefined {
  if (process.env.OBJECT_STORAGE_PROVIDER !== 's3') return undefined;
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const region = process.env.OBJECT_STORAGE_REGION ?? 'auto';
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    return undefined;
  }
  return new S3ObjectStore({ bucket, endpoint, region, accessKeyId, secretAccessKey });
}
