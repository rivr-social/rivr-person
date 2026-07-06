/**
 * Starter templates for new builder apps. Templates are platform-owned: the
 * session picks a runtime, never supplies build tooling. Files here define the
 * whole initial workspace, including the typed `rivr-app.json` manifest.
 */

import {
  APP_MANIFEST_FILE_NAME,
  APP_MANIFEST_VERSION,
  type AppRuntime,
  type RivrAppManifest,
} from "@/lib/builder/app-manifest";

export const NODE_TEMPLATE_DEFAULT_PORT = 3000;

export interface AppTemplateFile {
  path: string;
  content: string;
}

function manifestFile(manifest: RivrAppManifest): AppTemplateFile {
  return {
    path: APP_MANIFEST_FILE_NAME,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function staticTemplate(appId: string, name: string): AppTemplateFile[] {
  return [
    manifestFile({
      version: APP_MANIFEST_VERSION,
      appId,
      name,
      runtime: "static",
      resourceClass: "tiny",
      database: "none",
      secretNames: [],
      healthPath: "/",
    }),
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <h1>${name}</h1>
      <p>Deployed from the Rivr builder.</p>
    </main>
  </body>
</html>
`,
    },
    {
      path: "styles.css",
      content: `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; display: grid; place-items: center; min-height: 100vh; }
main { text-align: center; padding: 2rem; }
`,
    },
  ];
}

function nodeTemplate(appId: string, name: string): AppTemplateFile[] {
  return [
    manifestFile({
      version: APP_MANIFEST_VERSION,
      appId,
      name,
      runtime: "node-22",
      internalPort: NODE_TEMPLATE_DEFAULT_PORT,
      resourceClass: "small",
      database: "none",
      secretNames: [],
      healthPath: "/healthz",
    }),
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: appId,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: { start: "node server.mjs" },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "server.mjs",
      content: `import { createServer } from "node:http";

const port = Number(process.env.PORT ?? ${NODE_TEMPLATE_DEFAULT_PORT});

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<h1>${name}</h1><p>Deployed from the Rivr builder.</p>");
});

server.listen(port, () => {
  console.log(\`listening on \${port}\`);
});
`,
    },
  ];
}

export function appTemplateFiles(
  runtime: AppRuntime,
  appId: string,
  name: string,
): AppTemplateFile[] {
  return runtime === "static" ? staticTemplate(appId, name) : nodeTemplate(appId, name);
}
