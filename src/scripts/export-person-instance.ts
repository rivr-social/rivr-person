import {
  exportPersonInstanceManifest,
  savePersonInstanceManifest,
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
  const personAgentId = required("PERSON_AGENT_ID");
  const outputPath =
    readEnvFallback("OUTPUT_PATH") || `tmp/person-instance-${personAgentId}.manifest.json`;

  const manifest = await withDatabase(databaseUrl, (db) =>
    exportPersonInstanceManifest(db, personAgentId),
  );
  const savedPath = await savePersonInstanceManifest(manifest, outputPath);

  console.log(
    JSON.stringify(
      {
        success: true,
        outputPath: savedPath,
        summary: manifest.summary,
        personAgentId: manifest.personAgentId,
        sourceNodeId: manifest.sourceNode?.id ?? null,
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
