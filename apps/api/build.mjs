// Bundles src/app.ts and the workspace packages (TypeScript sources, extensionless imports) into one ESM file
// for the Vercel function. npm dependencies stay external and are traced from node_modules as usual, which pnpm links
// only for apps/api's own dependencies: so every npm package the bundle imports must be listed in this package.json,
// or the function crashes at runtime with ERR_MODULE_NOT_FOUND. The build checks that and fails instead.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const deps = new Set(Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {}));
const external = new Set();
const packageOf = (p) => (p.startsWith("@") ? p.split("/").slice(0, 2).join("/") : p.split("/")[0]);

await build({
  entryPoints: ["src/app.ts"],
  outfile: "dist/app.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [
    {
      name: "external-npm",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@archable/")) return undefined;
          if (!args.path.startsWith("node:")) external.add(packageOf(args.path));
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

const missing = [...external].filter((p) => !deps.has(p)).sort();
if (missing.length) {
  console.error(`apps/api imports npm packages it doesn't list in dependencies (they'd be missing on Vercel): ${missing.join(", ")}`);
  process.exit(1);
}

// Vercel runs this script as a static build and requires a non-empty output directory. The API serves only robots.txt.
mkdirSync("public", { recursive: true });
writeFileSync("public/robots.txt", "User-agent: *\nDisallow: /\n");
