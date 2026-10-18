// packages/spec-writer/src/apply.ts: a typed ChangeSet → edits to the repository tree (v3 §4.7, §7.2).
// The spec is edited as text: the yaml Document API locates each node by its source range and only the bytes that
// change are rewritten, so comments, alignment and flow style survive and a PR's diff shows the change and nothing
// else. Every op checks its precondition first; a failed one is a conflict (data, not an exception), and then
// nothing is applied.
import { ChangeSet, type Op } from '@archable/schema';
import YAML, { isMap, isScalar, isSeq, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml';
import type { z } from 'zod';

export const SPEC_FILE = 'enterprise.spec.yaml';
export interface Tree { files: Record<string, string> }
export interface Conflict { op: number; message: string }
export type ApplyResult = { outcome: 'applied'; tree: Tree; touched: string[] } | { outcome: 'conflict'; conflicts: Conflict[] };

type ChangeSetT = z.infer<typeof ChangeSet>;
type OpT = z.infer<typeof Op>;

const LABEL_LANG = 'en';            // the language the Architect writes an add_enum label in

/**
 * Spec keys may contain dots ('order.create', 'send.grounded'), so a dotted path is matched greedily against the
 * keys that exist: 'decisions.send.grounded.pass_at' → ['decisions', 'send.grounded', 'pass_at']. Segments past
 * the existing nodes stay one key each.
 */
export function keysOf(doc: Document, path: string): string[] {
  const segs = path.split('.');
  const keys: string[] = [];
  let node: unknown = doc.contents;
  let i = 0;
  while (i < segs.length) {
    let matched = false;
    if (isMap(node)) {
      for (let j = segs.length; j > i; j--) {
        const k = segs.slice(i, j).join('.');
        if (node.has(k)) { keys.push(k); node = node.get(k, true); i = j; matched = true; break; }
      }
    }
    if (!matched) { keys.push(...segs.slice(i)); break; }
  }
  return keys;
}

// ── text edits located by source ranges ──

const flow = (v: unknown) => YAML.stringify(v, { collectionStyle: 'flow', flowCollectionPadding: true, lineWidth: 0 }).trim();
const lineEnd = (s: string, at: number) => { const i = s.indexOf('\n', at); return i < 0 ? s.length : i; };
const column = (s: string, at: number) => at - (s.lastIndexOf('\n', at - 1) + 1);
const splice = (s: string, at: number, del: number, ins: string) => s.slice(0, at) + ins + s.slice(at + del);
const rangeOf = (n: Node) => n.range!;

/** Inserts `key: value` as the map's last entry, in the map's own style. */
function addToMap(src: string, map: YAMLMap, key: string, value: unknown): string {
  const [start, end] = rangeOf(map);
  if (map.flow) {
    const last = map.items.at(-1)?.value as Node | undefined;
    return last ? splice(src, rangeOf(last)[1], 0, `, ${key}: ${flow(value)}`)
                : splice(src, src.indexOf('{', start) + 1, 0, ` ${key}: ${flow(value)} `);
  }
  const first = map.items[0]?.key as Node | undefined;
  const indent = ' '.repeat(first ? column(src, rangeOf(first)[0]) : column(src, start));
  const at = lineEnd(src, end - 1);
  return splice(src, at, 0, `\n${indent}${key}: ${flow(value)}`);
}

/** Appends an item to a sequence, in its own style. */
function addToSeq(src: string, seq: YAMLSeq, item: unknown): string {
  const [start, end] = rangeOf(seq);
  if (seq.flow) {
    const last = seq.items.at(-1) as Node | undefined;
    return last ? splice(src, rangeOf(last)[1], 0, `, ${flow(item)}`) : splice(src, src.indexOf('[', start) + 1, 0, flow(item));
  }
  const indent = ' '.repeat(column(src, start));
  return splice(src, lineEnd(src, end - 1), 0, `\n${indent}- ${flow(item)}`);
}

function replaceScalar(src: string, node: Node, value: unknown): string {
  const [start, valueEnd] = rangeOf(node);
  return splice(src, start, valueEnd - start, flow(value));
}

export function apply(tree: Tree, cs: ChangeSetT): ApplyResult {
  const parsed = ChangeSet.safeParse(cs);
  if (!parsed.success) return { outcome: 'conflict', conflicts: parsed.error.issues.map((x) => ({ op: Number(x.path[1] ?? -1), message: x.message })) };

  const files = { ...tree.files };
  const conflicts: Conflict[] = [];
  const touched = new Set<string>();
  parsed.data.ops.forEach((op, i) => {
    const doc = YAML.parseDocument(files[SPEC_FILE] ?? '');                // re-read: earlier ops moved the offsets
    if (doc.errors.length || !isMap(doc.contents)) return void conflicts.push({ op: i, message: `${SPEC_FILE} does not parse` });
    const r = applyOp(doc, files, op);
    if (typeof r === 'string') conflicts.push({ op: i, message: r });
    else for (const p of r) touched.add(p);
  });
  if (conflicts.length) return { outcome: 'conflict', conflicts };
  return { outcome: 'applied', tree: { files }, touched: [...touched].sort() };
}

/** Applies one op to `files`, or returns why it can't. */
function applyOp(doc: Document, files: Record<string, string>, op: OpT): string[] | string {
  const src = files[SPEC_FILE]!;
  const spec = (s: string) => { files[SPEC_FILE] = s; return [SPEC_FILE]; };
  switch (op.op) {
    case 'set': {
      const keys = keysOf(doc, op.path);
      const node = doc.getIn(keys, true) as Node | undefined;
      if (node !== undefined && !isScalar(node)) return `${op.path} is not a scalar`;
      const current = node === undefined ? null : node.value;
      if (current !== op.expect) return `${op.path} is ${JSON.stringify(current)}, expected ${JSON.stringify(op.expect)}`;
      if (node) return spec(replaceScalar(src, node, op.value));
      const parent = doc.getIn(keys.slice(0, -1), true);
      if (!isMap(parent)) return `${keys.slice(0, -1).join('.')} does not exist`;
      return spec(addToMap(src, parent, keys.at(-1)!, op.value));
    }
    case 'add_enum': {
      const keys = keysOf(doc, op.path.replace(/\.values$/, ''));
      const field = doc.getIn(keys, true);
      const values = isMap(field) ? field.get('values', true) : undefined;
      if (!isMap(field) || !isSeq(values)) return `${op.path} is not an enum field`;
      if (values.items.some((v) => isScalar(v) && v.value === op.value)) return `"${op.value}" is already a value of ${op.path}`;
      let s = addToSeq(src, values, op.value);
      const after = YAML.parseDocument(s).getIn(keys, true) as YAMLMap;
      const labels = after.get('value_labels', true);
      s = isMap(labels) ? addToMap(s, labels, op.value, { [LABEL_LANG]: op.label })
                        : addToMap(s, after, 'value_labels', { [op.value]: { [LABEL_LANG]: op.label } });
      return spec(s);
    }
    case 'add_field': {
      const fields = doc.getIn(['objects', op.object, 'fields'], true);
      if (!isMap(fields)) return `unknown object "${op.object}"`;
      if (fields.has(op.field)) return `${op.object}.${op.field} already exists`;
      return spec(addToMap(src, fields, op.field, op.optional ? { type: op.type, optional: true } : { type: op.type }));
    }
    case 'add_policy': {
      const path = op.file.startsWith('policies/') ? op.file : `policies/${op.file}`;
      if (!/^policies\/[a-z0-9_]+\.cedar$/.test(path)) return `"${op.file}" is not a policy file name`;
      const ids = [...op.cedar.matchAll(/@id\("([^"]+)"\)/g)].map((m) => m[1]);
      if (ids.length !== 1 || ids[0] !== op.id) return `the policy text must carry exactly @id("${op.id}")`;
      for (const [p, text] of Object.entries(files)) {
        if (p.startsWith('policies/') && text.includes(`@id("${op.id}")`)) return `policy ${op.id} already exists in ${p}`;
      }
      const list = doc.getIn(['policies', 'files'], true);
      if (!isSeq(list)) return 'spec has no policies.files list';
      const prior = files[path];
      files[path] = prior === undefined ? `${op.cedar.trim()}\n` : `${prior.replace(/\s*$/, '')}\n\n${op.cedar.trim()}\n`;
      if (!list.items.some((v) => isScalar(v) && v.value === path)) spec(addToSeq(src, list, path));
      return [path, SPEC_FILE];
    }
    case 'edit_persona': {
      const path = (doc.getIn(['agents', op.agent, 'persona'], true) as Node | undefined);
      if (!isScalar(path) || typeof path.value !== 'string') return `unknown agent "${op.agent}"`;
      const text = files[path.value];
      if (text === undefined) return `persona file not found: ${path.value}`;
      const n = op.find ? text.split(op.find).length - 1 : 0;
      if (n !== 1) return `"${op.find.slice(0, 60)}" occurs ${n} times in ${path.value}; it must occur once`;
      files[path.value] = text.replace(op.find, () => op.replace);
      return [path.value];
    }
    case 'add_eval': {
      const dir = doc.getIn(['evals', 'suites', op.suite, 'path'], true) as Node | undefined;
      if (!isScalar(dir) || typeof dir.value !== 'string') return `unknown eval suite "${op.suite}"`;
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(op.id)) return `"${op.id}" is not an eval case id`;
      const path = `${dir.value}/${op.id}.yaml`;
      if (files[path] !== undefined) return `${path} already exists`;
      const c = YAML.parseDocument(op.yaml);
      if (c.errors.length) return `eval case ${op.id} does not parse: ${c.errors[0]!.message}`;
      if ((c.toJS() as { id?: unknown } | null)?.id !== op.id) return `eval case ${op.id} must have id: ${op.id}`;
      files[path] = `${op.yaml.trim()}\n`;
      return [path];
    }
  }
}
