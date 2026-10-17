// apps/api/src/channels/web/session.ts: anonymous web chat sessions.
// The iframe keeps a 256-bit secret in its own (partitioned) localStorage; the database keeps its hash.
// Messages carry a 1 h HS256 token minted from the secret, so the secret travels once per page load.
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '@archable/contracts';

export interface ChatClaims { tid: string; sid: string; cid: string; env: Env }

const AUD = 'archable-chat';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const newSecret = () => randomBytes(32).toString('base64url');          // 43 chars
export const isSecret = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
export const hashSecret = (s: string) => createHash('sha256').update(s).digest();

export function mintChatToken(c: ChatClaims, key: Uint8Array) {
  return new SignJWT({ tid: c.tid, sid: c.sid, cid: c.cid, env: c.env })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

export async function verifyChatToken(token: string, key: Uint8Array): Promise<ChatClaims | null> {
  try {
    const { payload: p } = await jwtVerify(token, key, { audience: AUD, algorithms: ['HS256'] });
    const ok = typeof p.tid === 'string' && UUID.test(p.tid) && typeof p.sid === 'string' && UUID.test(p.sid)
      && typeof p.cid === 'string' && UUID.test(p.cid) && typeof p.env === 'string' && /^(prod|pr-[0-9]+)$/.test(p.env);
    return ok ? { tid: p.tid as string, sid: p.sid as string, cid: p.cid as string, env: p.env as Env } : null;
  } catch {
    return null;                                              // expired, bad signature, wrong audience
  }
}
