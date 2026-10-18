// apps/api/src/shell-store.ts: what the shell boots from (v3 §2.4), on the runtime plane. The manifest by slug or custom
// domain (definer functions: no tenant context before sign-in), and a digest's UI projection for a member of its tenant.
import type { BundleUi, Env, Manifest, UiProjection } from '@archable/contracts';
import type postgres from 'postgres';
import { withTenant } from './db';
import type { ManifestDeps } from './routes/manifest';

type Row = { tenant_id: string; slug: string; os_name: string; digest: string; epoch: string; theme: { brand?: string; font?: string; radius?: string } | null;
             extension_digest: string | null };

// Extensions are served by content address (v3 §2.4 step 4); their hosting isn't defined yet, so a bundle that names
// one gets no URL rather than a guessed one. Marani has none.
const extensionUrl = (_digest: string | null): string | null => null;

const manifestOf = (r: Row, env: Env): Manifest => ({
  tenant_id: r.tenant_id, slug: r.slug, env, digest: r.digest, epoch: Number(r.epoch), os_name: r.os_name,
  branding: { brand: r.theme?.brand ?? '#111111', font: r.theme?.font ?? 'system-ui', radius: r.theme?.radius ?? 'md' },
  extension_url: extensionUrl(r.extension_digest), topic: `tenant:${r.tenant_id}`,
});

export function createShellStore(runtime: postgres.Sql) {
  const manifest: ManifestDeps = {
    async bySlug(slug, env) {
      const pr = env === 'prod' ? null : Number(env.slice(3));
      const [r] = await runtime<Row[]>`select * from private.manifest_for(${slug}, ${pr})`;
      return r?.digest ? manifestOf(r, env) : null;
    },
    async byCustomDomain(host) {
      const [r] = await runtime<Row[]>`select * from private.manifest_for_domain(${host})`;
      return r?.digest ? manifestOf(r, 'prod') : null;
    },
  };

  /** The UI projection of a digest of the member's own tenant; null for any other digest. */
  async function uiProjection(tenantId: string, digest: string): Promise<UiProjection | null> {
    return withTenant(runtime, tenantId, async (tx) => {
      const [s] = await tx<{ ui: BundleUi; labels: { nodes?: UiProjection['labels']['nodes']; values?: UiProjection['labels']['values'] } | null }[]>`
        select bundle -> 'ui' as ui, bundle -> 'labels' as labels from public.specs where tenant_id = ${tenantId} and digest = ${digest}`;
      if (!s) return null;
      const apps = await tx<UiProjection['apps']>`select app_id, title, template, agent_id, nav_order from public.apps
        where tenant_id = ${tenantId} and spec_digest = ${digest} order by nav_order, app_id`;
      const schemas = await tx<{ entity_type: string; json_schema: UiProjection['objects'][string]['schema']; key_field: string | null; title_field: string;
        edit_roles: string[]; field_acl: Record<string, string[]> }[]>`
        select entity_type, json_schema, key_field, title_field, edit_roles, field_acl from public.entity_schemas
         where tenant_id = ${tenantId} and spec_digest = ${digest} order by entity_type`;
      return {
        ...s.ui, digest, apps,
        objects: Object.fromEntries(schemas.map((e) => [e.entity_type, { schema: e.json_schema, key: e.key_field, title: e.title_field,
                                                                          edit_roles: e.edit_roles, field_acl: e.field_acl }])),
        labels: { nodes: s.labels?.nodes ?? {}, values: s.labels?.values ?? {} },     // bundles before Q7 have none
      };
    });
  }
  return { manifest, uiProjection };
}
