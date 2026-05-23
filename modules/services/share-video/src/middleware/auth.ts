/**
 * Express middleware: verify Authorization: Bearer <jwt>.
 * Same JWT shape as auth/chat — RS256, public.pem mounted from the auth
 * service's keypair.
 */

import * as fs from 'fs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

const PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_PATH || '/secrets/public.pem';

let publicKey: string | undefined;

function getPublicKey(): string {
  if (publicKey) return publicKey;
  if (!fs.existsSync(PUBLIC_KEY_PATH)) {
    throw new Error(`JWT public key not found at ${PUBLIC_KEY_PATH}`);
  }
  publicKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf-8');
  return publicKey;
}

export interface CurrentUser {
  id: string;
  anonymous: boolean;
}

// Augment Express Request with `user`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: CurrentUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const h = req.header('authorization');
  if (!h || !h.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  const token = h.slice(7);
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, getPublicKey(), {
      algorithms: ['RS256'],
    });
    if (typeof decoded === 'string') {
      res.status(401).json({ error: 'invalid token payload' });
      return;
    }
    claims = decoded;
  } catch (e: any) {
    res.status(401).json({ error: `invalid token: ${e?.message ?? 'unknown'}` });
    return;
  }
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) {
    res.status(401).json({ error: 'missing sub claim' });
    return;
  }
  req.user = { id: sub, anonymous: Boolean(claims.anonymous ?? true) };
  next();
}
