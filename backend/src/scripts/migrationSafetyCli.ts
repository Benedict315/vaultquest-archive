/**
 * Migration safety CLI (#790).
 *
 *   tsx src/scripts/migrationSafety.ts --preview <migration-id>
 *   tsx src/scripts/migrationSafety.ts --check <migration-id> --post-checks
 *   tsx src/scripts/migrationSafety.ts --list
 *
 * `--preview` issues only SELECTs: it reports what a migration would create,
 * which statements are destructive, and how many records the data-changing
 * statements would touch — before anything is written.
 *
 * Exit codes:
 *   0  – preview produced, or all post-checks passed
 *   1  – a post-check failed, or the migration could not be read
 */

import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { getPrisma, disconnectPrisma } from "../db.js";
import {
  parseMigrationSql,
  previewMigration,
  runPostChecks,
  formatPreview,
  formatPostChecks,
  listMigrationIds,
  type MigrationDatabase,
} from "./migrationSafety.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, "../../prisma/migrations");

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    for (const id of listMigrationIds(MIGRATIONS_DIR)) console.log(id);
    return;
  }

  const migrationId = argValue("--preview") ?? argValue("--check");
  if (!migrationId) {
    console.error(
      "Usage: tsx src/scripts/migrationSafety.ts --preview <migration-id>\n" +
        "       tsx src/scripts/migrationSafety.ts --check <migration-id> --post-checks\n" +
        "       tsx src/scripts/migrationSafety.ts --list",
    );
    process.exit(1);
  }

  const file = path.join(MIGRATIONS_DIR, migrationId, "migration.sql");
  if (!fs.existsSync(file)) {
    console.error(`❌ No migration.sql at ${path.relative(process.cwd(), file)}`);
    process.exit(1);
  }

  const plan = parseMigrationSql(migrationId, fs.readFileSync(file, "utf-8"));
  const prisma = getPrisma();
  const db = prisma as unknown as MigrationDatabase;

  try {
    const preview = await previewMigration(plan, db);
    console.log(formatPreview(preview));
    console.log("");

    if (preview.noop) {
      console.log("ℹ️  Nothing to do — the schema already has everything this migration adds.\n");
    }

    if (process.argv.includes("--post-checks")) {
      const report = await runPostChecks(db, plan);
      console.log(formatPostChecks(report));
      console.log("");
      if (!report.ok) process.exit(1);
    }
  } finally {
    await disconnectPrisma();
  }
}

main().catch((error) => {
  console.error("Migration safety check failed:", error);
  process.exit(1);
});
