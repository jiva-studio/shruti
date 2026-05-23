/**
 * Structured JSON logger via pino.
 *
 * Output shape lines up with the chat/auth/share-audio loggers so a
 * Datadog log search can span all four services on the same facets:
 *
 *   {
 *     "timestamp": "2026-…",
 *     "level":     "info" | "warn" | "error" | "debug",
 *     "message":   "<event-name or string>",
 *     "service":   "lectorium-share-video",
 *     "env":       "dev" | "staging" | "prod",
 *     "version":   "<image-tag>",
 *     "pid":       1,
 *     ...arbitrary fields the call site bound
 *   }
 *
 * Per-request fields (request_id, user_id) are attached by the express
 * middleware `httpLogger` in this file, which uses pino-http to make a
 * child logger and stash it on `req.log`. Handlers that want to add
 * fields call `req.log.info(...)` instead of the top-level logger.
 */

import pino, { type LoggerOptions } from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';

const SERVICE = 'lectorium-share-video';
const ENV = process.env.ENV || 'dev';
const VERSION = process.env.SERVICE_VERSION || 'dev';
const LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const baseOptions: LoggerOptions = {
  level: LEVEL,
  // Datadog reserved attribute names: rename pino defaults onto them.
  messageKey: 'message',
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    // Drop pino's "level: 30" numeric and use the string label everywhere.
    level: (label: string) => ({ level: label }),
  },
  base: {
    service: SERVICE,
    env: ENV,
    version: VERSION,
    pid: process.pid,
  },
};

export const log = pino(baseOptions);

/**
 * Express middleware: attaches a per-request child logger to `req.log`.
 *
 *   - X-Request-Id inbound header (Caddy or upstream proxy may set it)
 *     wins; otherwise we mint a UUID.
 *   - Echoes the id back via the X-Request-Id response header for
 *     client-side correlation.
 *   - Emits one `http_request` line per response with method, path,
 *     status, dur_ms, remote_ip.
 *
 * Handlers that have run requireAuth get `req.user.id` — pino-http's
 * customAttributeKeys lets us thread it onto the per-request child.
 */
export const httpLogger = pinoHttp({
  logger: log,
  genReqId: (req, res) => {
    const inbound = req.headers['x-request-id'];
    const id = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  // Default pino-http message includes method+url; we want a stable
  // event name for Datadog so this becomes one filterable line.
  customSuccessMessage: () => 'http_request',
  customErrorMessage: () => 'http_request',
  // What ends up on the auto-emitted request line.
  customProps: (req) => {
    const user = (req as any).user;
    if (user?.id) {
      return { user_id: user.id, anonymous: user.anonymous };
    }
    return {};
  },
  // Trim pino-http's request/response bloat — we only want the fields
  // we explicitly want (method, url, status are added by pino-http
  // already; we don't want full headers).
  serializers: {
    req: (r) => ({ method: r.method, path: r.url, remote_ip: r.remoteAddress }),
    res: (r) => ({ status: r.statusCode }),
  },
});
