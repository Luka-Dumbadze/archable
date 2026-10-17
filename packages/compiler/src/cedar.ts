// Policies: Cedar text → one entry per policy with Cedar's JSON form (policyToJson). References are read
// from the JSON, never from the text (plan §4.3).
import { policySetTextToParts, policyToJson } from '@cedar-policy/cedar-wasm/nodejs';
import type { Errors } from './errors';
import type { Files } from './parse';

export interface ParsedPolicy {
  id: string;                                                // @id
  file: string;
  text: string;
  json: Record<string, unknown>;
  action: string | null;                                     // `action == Action::"…"`, else null
  contextPaths: string[];                                    // 'context.customer.age_verified', sorted
}

type Node = Record<string, unknown>;

const attrPath = (e: unknown): string | null => {
  if (!e || typeof e !== 'object') return null;
  const n = e as Node;
  if (typeof n.Var === 'string') return n.Var;
  const dot = n['.'] as { left: unknown; attr: string } | undefined;
  if (dot) {
    const left = attrPath(dot.left);
    return left ? `${left}.${dot.attr}` : null;
  }
  return null;
};

function collectContextPaths(e: unknown, out: Set<string>): void {
  if (!e || typeof e !== 'object') return;
  const n = e as Node;
  for (const op of ['.', 'has'] as const) {
    const access = n[op] as { left: unknown; attr: string } | undefined;
    if (access) {
      const path = attrPath({ '.': access });
      if (path?.startsWith('context.')) {
        out.add(path);
        return;
      }
    }
  }
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) v.forEach((x) => collectContextPaths(x, out));
    else collectContextPaths(v, out);
  }
}

export function parsePolicies(files: Files, list: string[], errors: Errors): ParsedPolicy[] {
  const out: ParsedPolicy[] = [];
  const seen = new Set<string>();
  list.forEach((file, i) => {
    const where = `policies.files.${i}`;
    const text = files.get(file);
    if (text === undefined) return errors.add(where, `file not found: ${file}`);
    const parts = policySetTextToParts(text);
    if (parts.type === 'failure') {
      for (const e of parts.errors) errors.add(file, e.message);
      return;
    }
    for (const part of parts.policies) {
      const r = policyToJson(part);
      if (r.type === 'failure') {
        for (const e of r.errors) errors.add(file, e.message);
        continue;
      }
      const json = r.json as unknown as Record<string, unknown>;
      const id = r.json.annotations?.id;
      if (!id) {
        errors.add(file, 'policy without @id');
        continue;
      }
      if (seen.has(id)) errors.add(file, `duplicate policy id "${id}"`);
      seen.add(id);
      const action = r.json.action.op === '==' && 'entity' in r.json.action ? r.json.action.entity : null;
      const paths = new Set<string>();
      collectContextPaths(r.json.conditions, paths);
      out.push({
        id,
        file,
        text: part.trim(),
        json,
        action: action && !('__entity' in action) && action.type === 'Action' ? action.id : null,
        contextPaths: [...paths].sort(),
      });
    }
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
