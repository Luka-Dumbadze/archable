// parse: repository tree → validated spec. Line endings are normalized so a Windows checkout (CRLF)
// and a Linux checkout (LF) of the same commit compile to the same digest (I2).
import { Spec } from '@archable/schema';
import YAML from 'yaml';
import type { Errors } from './errors';
import type { RepoTree } from './types';

export const SPEC_FILE = 'enterprise.spec.yaml';

export type Files = ReadonlyMap<string, string>;

export function normalizeTree(tree: RepoTree): Files {
  const files = new Map<string, string>();
  for (const [path, content] of Object.entries(tree.files)) {
    files.set(path.replace(/\\/g, '/').replace(/^\.\//, ''), content.replace(/\r\n?/g, '\n'));
  }
  return files;
}

export function parseSpec(files: Files, errors: Errors): Spec | null {
  const text = files.get(SPEC_FILE);
  if (text === undefined) {
    errors.add(SPEC_FILE, 'file not found');
    return null;
  }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) {
    for (const e of doc.errors) errors.add(SPEC_FILE, e.message);
    return null;
  }
  const r = Spec.safeParse(doc.toJS());
  if (!r.success) {
    for (const issue of r.error.issues) errors.add(issue.path.map(String).join('.') || SPEC_FILE, issue.message);
    return null;
  }
  return r.data;
}
