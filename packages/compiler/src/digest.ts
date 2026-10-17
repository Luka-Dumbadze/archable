// packages/compiler/src/digest.ts: the bundle's identity. RFC 8785 canonical JSON, then SHA-256.
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';

export type Digest = `sha256:${string}`;

export function digestOf(value: unknown): Digest {
  const json = canonicalize(value);
  if (json === undefined) throw new Error('value is not JSON-serializable');
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}
