/**
 * Lambda / YC Function entry point for share-video.
 *
 * Two modes, dispatched on event shape:
 *
 *   1. HTTP mode (default): event came from API Gateway. Fast path.
 *      - Validate the request.
 *      - HEAD `public/share/video/<videoId>.mp4`; if it already exists,
 *        return 200 + the URL immediately.
 *      - Otherwise dispatch the actual render asynchronously.
 *        On AWS (RENDER_DISPATCH=self-invoke) the handler invokes itself
 *        via `lambda:InvokeFunction` with InvocationType=Event and
 *        returns 202 with the predicted URL. The client polls S3 until
 *        the file appears.
 *        On YC (RENDER_DISPATCH unset) the handler runs the render
 *        inline and returns 200 — YC's API Gateway accommodates the
 *        full 600 s function timeout, so blocking is fine there.
 *
 *   2. Worker mode (`event.__share_video_worker__ === true`): event came
 *      from the async self-invoke above. Run the actual render. The
 *      response shape is irrelevant — async-invoked Lambdas don't return
 *      anything to a caller.
 *
 * Cleanup of the per-invocation /tmp directory is mandatory and runs in
 * a `finally` block so warm-container disk doesn't accumulate junk.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseRequest, requestMethod, RenderRequest } from './eventAdapter';
import { getS3, objectExists, buildPublicUrl } from './storage';

// Heavy imports below are loaded lazily inside the request paths that need them.
// Cache-hit fast path (HEAD on S3 → return 200) only touches eventAdapter +
// storage above, so it stays sub-100ms cold without paying for the AWS Lambda
// SDK, the render pipeline, OpenAI/SpeechKit clients, canvas, or fluent-ffmpeg.
type LambdaClientType = import('@aws-sdk/client-lambda').LambdaClient;
type LambdaModule = typeof import('@aws-sdk/client-lambda');

const BUCKET = mustEnv('BUCKET');
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX || 'public/share/video';
const BACKGROUNDS_PREFIX = process.env.BACKGROUNDS_PREFIX || 'private/share/video/backgrounds';
const TEMP_ROOT = process.env.TEMP_ROOT || '/tmp';
const RENDER_DISPATCH = process.env.RENDER_DISPATCH || 'inline';

// Bundled logo, present inside the deployment package. Compiled handler.js
// lives at <pkg>/dist/handler.js, so the package root is one level up.
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const LOGO_PATH = path.join(PACKAGE_ROOT, 'assets', 'logo.mp4');

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

interface WorkerPayload {
  __share_video_worker__: true;
  videoId: string;
  payload: RenderRequest;
}

let lambdaClient: LambdaClientType | undefined;
let lambdaModule: LambdaModule | undefined;
async function getLambda(): Promise<{ client: LambdaClientType; mod: LambdaModule }> {
  if (!lambdaModule) {
    lambdaModule = await import('@aws-sdk/client-lambda');
  }
  if (!lambdaClient) {
    lambdaClient = new lambdaModule.LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return { client: lambdaClient, mod: lambdaModule };
}

export async function handler(event: any): Promise<any> {
  // --- Worker mode -------------------------------------------------------
  if (event && event.__share_video_worker__ === true) {
    const w = event as WorkerPayload;
    return doRender(w.payload, w.videoId);
  }

  // --- HTTP mode ---------------------------------------------------------
  if (requestMethod(event) === 'OPTIONS') {
    return response(204, null);
  }

  let req: RenderRequest;
  let videoId: string;
  try {
    req = parseRequest(event);
    videoId = req.videoId || crypto.randomBytes(16).toString('hex');
  } catch (e: any) {
    const status = typeof e?.http === 'number' ? e.http : 400;
    return response(status, { error: String(e?.message || 'bad request') });
  }

  const outputKey = `${OUTPUT_PREFIX.replace(/\/$/, '')}/${videoId}.mp4`;
  const url = buildPublicUrl(BUCKET, outputKey);

  try {
    const s3 = getS3();
    if (await objectExists(s3, BUCKET, outputKey)) {
      return response(200, { video_id: videoId, url, ready: true });
    }
  } catch (e: any) {
    console.warn(`HEAD pre-check failed for ${outputKey}: ${e?.message}`);
    // Fall through — the render will overwrite or the upload will surface the real error.
  }

  if (RENDER_DISPATCH === 'self-invoke') {
    // Fire-and-forget: dispatch the render to ourselves async, return 202
    // with the predicted URL. Client polls S3 with HEAD until the file
    // appears.
    const fnName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    if (!fnName) {
      return response(500, { error: 'AWS_LAMBDA_FUNCTION_NAME unset; self-invoke unavailable' });
    }
    const workerEvent: WorkerPayload = {
      __share_video_worker__: true,
      videoId,
      payload: { ...req, videoId },
    };
    try {
      const { client, mod } = await getLambda();
      await client.send(
        new mod.InvokeCommand({
          FunctionName: fnName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify(workerEvent)),
        }),
      );
    } catch (e: any) {
      console.error(`self-invoke dispatch failed: ${e?.message}`);
      return response(502, { error: 'failed to dispatch render' });
    }
    return response(202, { video_id: videoId, url, ready: false });
  }

  // Inline mode (YC and local dev): run the render synchronously.
  return doRender({ ...req, videoId }, videoId);
}

async function doRender(req: RenderRequest, videoId: string): Promise<any> {
  const tempDir = path.join(TEMP_ROOT, `share-video-${videoId}`);
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    // Lazy: pull the heavy render path only when we're about to use it.
    const { renderReel } = await import('./pipeline');
    const result = await renderReel({
      req,
      videoId,
      bucket: BUCKET,
      backgroundsPrefix: BACKGROUNDS_PREFIX,
      outputPrefix: OUTPUT_PREFIX,
      logoPath: LOGO_PATH,
      s3: getS3(),
      tempDir,
    });
    return response(200, { video_id: result.videoId, url: result.url, ready: true });
  } catch (e: any) {
    const status =
      e?.code === 'UNKNOWN_THEME' ? 400 : typeof e?.http === 'number' ? e.http : 500;
    console.error(
      JSON.stringify({
        phase: 'render-error',
        video_id: videoId,
        status,
        message: String(e?.message || e),
      }),
    );
    return response(status, { error: String(e?.message || 'render failed') });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e: any) {
      console.warn(`tempDir cleanup failed: ${e?.message}`);
    }
  }
}

function response(status: number, body: any): any {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: body == null ? '' : JSON.stringify(body),
  };
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} is required`);
  return v;
}
