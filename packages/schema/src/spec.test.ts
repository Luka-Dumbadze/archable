import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { Spec } from './spec';

const marani = () => YAML.parse(readFileSync(new URL('../../../fixtures/marani/enterprise.spec.yaml', import.meta.url), 'utf8'));

describe('Spec', () => {
  it('parses fixtures/marani/enterprise.spec.yaml', () => {
    const r = Spec.safeParse(marani());
    expect(r.error?.issues ?? []).toEqual([]);
    expect(Object.keys(r.data!.channels).sort()).toEqual(['tg_business', 'tg_customers', 'web_chat']);
  });

  it('rejects an unknown top-level key', () => {
    expect(Spec.safeParse({ ...marani(), widget_settings: {} }).success).toBe(false);
  });

  it('rejects an enum field without values', () => {
    const s = marani();
    s.objects.order.fields.payment = { type: 'enum' };
    expect(Spec.safeParse(s).success).toBe(false);
  });
});
