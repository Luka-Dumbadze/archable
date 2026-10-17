// Bundles src/app.ts and the workspace packages (TypeScript sources, extensionless imports) into one ESM file
// for the Vercel function. npm dependencies stay external and are traced from node_modules as usual.
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

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
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith("@archable/") ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});

// Vercel runs this script as a static build and requires a non-empty output directory. The API serves only robots.txt.
mkdirSync("public", { recursive: true });
writeFileSync("public/robots.txt", "User-agent: *\nDisallow: /\n");
