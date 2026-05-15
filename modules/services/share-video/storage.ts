import * as fs from 'fs';
import { Readable } from 'stream';
import {
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

let cached: S3Client | undefined;

/**
 * S3 client with sane defaults. On AWS Lambda picks up the function's IAM
 * role; on Yandex Cloud Functions picks up the AWS_RUNTIME_* env vars set
 * by serverless-yc.yml (a dedicated AWS IAM user — YC SAs cannot sign AWS
 * S3 requests directly).
 */
export function getS3(): S3Client {
  if (cached) return cached;
  cached = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT_URL,
    maxAttempts: 3,
  });
  return cached;
}

export async function objectExists(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err: any) {
    const code = err?.$metadata?.httpStatusCode;
    if (code === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
      return false;
    }
    throw err;
  }
}

export async function downloadToFile(
  s3: S3Client,
  bucket: string,
  key: string,
  dst: string,
): Promise<void> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = resp.Body;
  if (!body || typeof (body as any).pipe !== 'function') {
    throw new Error(`unsupported S3 body for ${key}`);
  }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dst);
    (body as Readable).pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    (body as Readable).on('error', reject);
  });
}

export async function uploadFile(
  s3: S3Client,
  bucket: string,
  key: string,
  localPath: string,
  contentType: string,
  cacheControl?: string,
): Promise<void> {
  const body = fs.readFileSync(localPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
    }),
  );
}

/**
 * Stable public URL for a key. Mirrors share-audio's build_excerpt_url.
 */
export function buildPublicUrl(bucket: string, key: string): string {
  const base = process.env.OUTPUT_PUBLIC_BASE;
  if (base) {
    return `${base.replace(/\/$/, '')}/${key}`;
  }
  const region = process.env.AWS_REGION || 'us-east-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}
