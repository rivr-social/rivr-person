import {
  importPersonInstanceManifest,
  loadPersonInstanceManifest,
  withDatabase,
} from "@/lib/federation/person-instance-migration";
import { readEnvFallback } from "./mapbox-env";

function required(name: string): string {
  const value = readEnvFallback(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const databaseUrl = required("DATABASE_URL");
  const manifestPath = required("MANIFEST_PATH");

  const manifest = await loadPersonInstanceManifest(manifestPath);
  const summary = await withDatabase(databaseUrl, (db) =>
    importPersonInstanceManifest(db, manifest),
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        importedFrom: manifestPath,
        personAgentId: manifest.personAgentId,
        summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
