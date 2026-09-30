/**
 * Migration safety framework for the Prisma migration folders (#790).
 *
 * `prisma migrate deploy` applies SQL and reports success, but the folders here
 * are hand-maintained and several of them are destructive (a dropped column, a
 * dropped table) or rewrite rows. Nothing in the current toolchain tells an
 * operator, before the write, how many records a statement will touch, or
 * afterwards whether the database actually converged.
 *
 * This module adds the three missing pieces, all operating on the SQL in
 * `prisma/migrations/<id>/migration.sql`:
 *
 *  1. **Preview / dry-run** — {@link parseMigrationSql} builds a plan and
 *     {@link previewMigration} intersects it with the live database, so affected
 *     records are reported *before* any write.
 *  2. **Post-checks** — {@link runPostChecks} verifies the objects a migration
 *     claims to provide actually exist, and that backfills completed.
 *  3. **Rollback / forward-fix** — {@link rollbackNotes} describes how to reverse
 *     each risky statement or what the forward fix is.
 *
 * The database is reached through {@link MigrationDatabase} so the whole
 * framework is testable without Postgres.
 *
 * 4. **Release readiness** — {@link evaluateReleaseReadiness} turns a plan and
 *    its preview into a pass/fail checklist covering tests, migration, config,
 *    rollback, and docs, so high-risk changes can be gated in CI.
 */

import * as fs from "fs";
import * as path from "path";

export type MigrationActionKind =
  | "create-table"
  | "drop-table"
  | "create-index"
  | "drop-index"
  | "add-column"
  | "drop-column"
  | "alter-column"
  | "data-update"
  | "other";

export interface PlannedAction {
  kind: MigrationActionKind;
  name: string;
  table?: string;
  column?: string;
  /** Removes an object or column. */
  destructive: boolean;
  /** Rewrites rows. */
  touchesData: boolean;
  /** Rewrites every row in the table (backfill with no WHERE). */
  rewritesAllRows: boolean;
  sql: string;
}

export interface MigrationPlan {
  migrationId: string;
  actions: PlannedAction[];
  creates: PlannedAction[];
  destructive: PlannedAction[];
  dataChanges: PlannedAction[];
  /** Nothing in the plan would create or alter anything. */
  isEmpty: boolean;
}

export interface AffectedRecords {
  table: string;
  /** null when the live count could not be determined (missing table, no grants). */
  rowCount: number | null;
  /** Rows the statement's WHERE clause would match, when determinable. */
  matchingRows: number | null;
  columns: string[];
}

export interface MigrationPreview {
  plan: MigrationPlan;
  alreadyPresent: string[];
  wouldCreate: string[];
  wouldRunDestructive: PlannedAction[];
  affectedRecords: AffectedRecords[];
  rollbackNotes: string[];
  /** True when applying would be a no-op (schema already converged). */
  noop: boolean;
}

export interface MigrationDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PostCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PostCheckReport {
  ok: boolean;
  checks: PostCheck[];
  failures: PostCheck[];
}

export type ReadinessCategory =
  | "tests"
  | "migration"
  | "config"
  | "rollback"
  | "docs";

export interface ReadinessItem {
  category: ReadinessCategory;
  name: string;
  ok: boolean;
  /** True when the item cannot be auto-verified and needs maintainer sign-off. */
  manual: boolean;
  detail: string;
}

export interface ReadinessInput {
  plan: MigrationPlan;
  preview?: MigrationPreview;
  postChecks?: PostCheckReport;
  /** Paths changed in the PR, used to detect docs/config/test updates. */
  changedPaths?: string[];
  /** Whether the change is being fast-tracked as an urgent fix. */
  urgent?: boolean;
  /** Reason recorded when an urgent fix bypasses manual items. */
  exceptionReason?: string;
}

export interface ReadinessReport {
  ok: boolean;
  items: ReadinessItem[];
  blockers: ReadinessItem[];
  manualSignOff: ReadinessItem[];
  exceptionApplied: boolean;
}

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

const identifier = (after: string): string => {
  const match = after.match(/"([^"]+)"|([A-Za-z_][\w$]*)/);
  return match ? (match[1] ?? match[2]) : "";
};

/**
 * Parses a migration file into a classified plan. Recognises the DDL forms used
 * across `prisma/migrations`; anything unrecognised becomes `other` rather than
 * being guessed at, and still shows up in the plan.
 */
export function parseMigrationSql(migrationId: string, sql: string): MigrationPlan {
  const actions: PlannedAction[] = [];
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  for (const raw of withoutComments.split(";")) {
    const statement = normalize(raw);
    if (!statement) continue;
    const upper = statement.toUpperCase();
    let match: RegExpExecArray | null;

    if ((match = /^CREATE TABLE (IF NOT EXISTS )?"?([^"\s(]+)"?/.exec(upper))) {
      const name = identifier(statement.replace(/^CREATE TABLE (IF NOT EXISTS )?/i, ""));
      actions.push({
        kind: "create-table",
        name,
        table: name,
        destructive: false,
        touchesData: false,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^DROP TABLE (IF EXISTS )?"?([^"\s;]+)"?/.exec(upper))) {
      const name = identifier(statement.replace(/^DROP TABLE (IF EXISTS )?/i, ""));
      actions.push({
        kind: "drop-table",
        name,
        table: name,
        destructive: true,
        touchesData: true,
        rewritesAllRows: true,
        sql: statement,
      });
      continue;
    }

    if ((match = /^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?"?([^"\s(]+)"?/.exec(upper))) {
      const name = identifier(statement.replace(/^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?/i, ""));
      const onTable = / ON "?([A-Za-z_][\w$]*)"?/i.exec(statement);
      actions.push({
        kind: "create-index",
        name,
        table: onTable ? identifier(onTable[1]) : undefined,
        destructive: false,
        touchesData: false,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^DROP INDEX (IF EXISTS )?"?([^"\s;]+)"?/.exec(upper))) {
      const name = identifier(statement.replace(/^DROP INDEX (IF EXISTS )?/i, ""));
      actions.push({
        kind: "drop-index",
        name,
        destructive: true,
        touchesData: false,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^ALTER TABLE "?([^"\s]+)"? ADD COLUMN (IF NOT EXISTS )?"?([^"\s]+)"?/.exec(upper))) {
      const table = identifier(match[1]);
      const column = identifier(match[3]);
      actions.push({
        kind: "add-column",
        name: `${table}.${column}`,
        table,
        column,
        destructive: false,
        touchesData: false,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^ALTER TABLE "?([^"\s]+)"? DROP COLUMN (IF EXISTS )?"?([^"\s]+)"?/.exec(upper))) {
      const table = identifier(match[1]);
      const column = identifier(match[3]);
      actions.push({
        kind: "drop-column",
        name: `${table}.${column}`,
        table,
        column,
        destructive: true,
        touchesData: true,
        rewritesAllRows: true,
        sql: statement,
      });
      continue;
    }

    if ((match = /^ALTER TABLE "?([^"\s]+)"? ALTER COLUMN "?([^"\s]+)"? (.+)/.exec(upper))) {
      const table = identifier(match[1]);
      const column = identifier(match[2]);
      const alteration = match[3] ?? "";
      const isNotNull = /SET NOT NULL/.test(alteration);
      actions.push({
        kind: "alter-column",
        name: `${table}.${column}`,
        table,
        column,
        destructive: false,
        // SET NOT NULL can fail (or rewrite) when nulls remain.
        touchesData: isNotNull,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^UPDATE "?([^"\s]+)"?/.exec(upper))) {
      const table = identifier(match[1]);
      const hasWhere = /\bWHERE\b/i.test(statement);
      actions.push({
        kind: "data-update",
        name: table,
        table,
        destructive: false,
        touchesData: true,
        rewritesAllRows: !hasWhere,
        sql: statement,
      });
      continue;
    }

    actions.push({
      kind: "other",
      name: statement.slice(0, 60),
      destructive: false,
      touchesData: false,
      rewritesAllRows: false,
      sql: statement,
    });
  }

  const creates = actions.filter((a) => ["create-table", "create-index", "add-column"].includes(a.kind));
  const destructive = actions.filter((a) => a.destructive);
  const dataChanges = actions.filter((a) => a.touchesData);

  return {
    migrationId,
    actions,
    creates,
    destructive,
    dataChanges,
    isEmpty: actions.length === 0,
  };
}

export function readMigrationPlan(
  migrationsDir: string,
  migrationId: string,
): MigrationPlan {
  const file = path.join(migrationsDir, migrationId, "migration.sql");
  return parseMigrationSql(migrationId, fs.readFileSync(file, "utf-8"));
}

export function listMigrationIds(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8,}/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function relationExists(db: MigrationDatabase, name: string, kind: "table" | "index"): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND c.relkind = ANY($2::char[]) AND n.nspname = current_schema() LIMIT 1`,
    [name, kind === "table" ? ["r", "p"] : ["i"]],
  );
  return res.rows.length > 0;
}

async function columnExists(db: MigrationDatabase, table: string, column: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return res.rows.length > 0;
}

async function countRows(db: MigrationDatabase, table: string): Promise<number | null> {
  try {
    const res = await db.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    const value = res.rows[0]?.count;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reports what a migration would do, issuing only SELECTs. Safe to run against
 * production.
 */
export async function previewMigration(
  plan: MigrationPlan,
  db: MigrationDatabase,
): Promise<MigrationPreview> {
  const alreadyPresent: string[] = [];
  const wouldCreate: string[] = [];
  const affectedRecords: AffectedRecords[] = [];

  for (const action of plan.actions) {
    if (action.kind === "create-table" && action.table) {
      (await relationExists(db, action.table, "table"))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
    } else if (action.kind === "create-index" && action.name) {
      (await relationExists(db, action.name, "index"))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
    } else if (action.kind === "add-column" && action.table && action.column) {
      (await columnExists(db, action.table, action.column))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
    }
  }

  // One row count per table touched by a data-changing statement.
  const seen = new Set<string>();
  for (const action of plan.dataChanges) {
    if (!action.table || seen.has(action.table)) continue;
    seen.add(action.table);
    affectedRecords.push({
      table: action.table,
      rowCount: await countRows(db, action.table),
      matchingRows: action.rewritesAllRows ? await countRows(db, action.table) : null,
      columns: action.column ? [action.column] : [],
    });
  }

  return {
    plan,
    alreadyPresent,
    wouldCreate,
    wouldRunDestructive: await resolveDestructive(plan.destructive, db),
    affectedRecords,
    rollbackNotes: rollbackNotes(plan),
    noop: wouldCreate.length === 0 && plan.dataChanges.length === 0 && plan.destructive.length === 0,
  };
}

async function resolveDestructive(
  actions: PlannedAction[],
  db: MigrationDatabase,
): Promise<PlannedAction[]> {
  const present: PlannedAction[] = [];
  for (const action of actions) {
    if (action.kind === "drop-table" && action.table) {
      if (await relationExists(db, action.table, "table")) present.push(action);
      continue;
    }
    if (action.kind === "drop-column" && action.table && action.column) {
      if (await columnExists(db, action.table, action.column)) present.push(action);
      continue;
    }
    present.push(action);
  }
  return present;
}

/** Operator-facing rollback or forward-fix guidance per risky statement. */
export function rollbackNotes(plan: MigrationPlan): string[] {
  const notes: string[] = [];

  for (const action of plan.destructive) {
    if (action.kind === "drop-column") {
      notes.push(
        `${action.name}: column values are unrecoverable without a dump. Re-add with ` +
          `ALTER TABLE "${action.table}" ADD COLUMN "${action.column}" <original type>; ` +
          `restore values from a pre-migration pg_dump.`,
      );
    }
    if (action.kind === "drop-table") {
      notes.push(
        `${action.name}: the table and its data are removed. Restore with a pre-migration ` +
          `pg_dump, or re-create the table and repopulate before re-running.`,
      );
    }
    if (action.kind === "drop-index") {
      notes.push(
        `${action.name}: only the index is lost. Recreate it from this migration's ` +
          `CREATE INDEX statement; no data is affected.`,
      );
    }
  }

  for (const action of plan.dataChanges) {
    if (action.kind === "data-update") {
      notes.push(
        `${action.name}: ${action.rewritesAllRows ? "every row is rewritten" : "matching rows are rewritten"} ` +
          `in place. Reverse by restoring the affected columns from a pre-migration dump.`,
      );
    }
    if (action.kind === "alter-column" && action.touchesData) {
      notes.push(
        `${action.name}: SET NOT NULL fails if any NULL remains. Backfill first, then re-run; ` +
          `the migration is written to be re-runnable.`,
      );
    }
  }

  if (notes.length === 0) {
    notes.push("No destructive or data-rewriting statements — safe to apply and safe to re-run.");
  }
  return notes;
}

/**
 * Verifies convergence after a migration ran. Each object the plan creates is
 * checked independently so a partial failure names the specific object.
 */
export async function runPostChecks(db: MigrationDatabase, plan: MigrationPlan): Promise<PostCheckReport> {
  const checks: PostCheck[] = [];

  for (const action of plan.creates) {
    if (action.kind === "create-table" && action.table) {
      const exists = await relationExists(db, action.table, "table");
      checks.push({
        name: `table ${action.table} exists`,
        ok: exists,
        detail: exists ? "present" : "missing after migration",
      });
    } else if (action.kind === "create-index" && action.name) {
      const exists = await relationExists(db, action.name, "index");
      checks.push({
        name: `index ${action.name} exists`,
        ok: exists,
        detail: exists ? "present" : "missing after migration",
      });
    } else if (action.kind === "add-column" && action.table && action.column) {
      const exists = await columnExists(db, action.table, action.column);
      checks.push({
        name: `column ${action.table}.${action.column} exists`,
        ok: exists,
        detail: exists ? "present" : "missing after migration",
      });
    }
  }

  // A SET NOT NULL that "succeeded" while NULLs remain means a partial rollout.
  for (const action of plan.actions) {
    if (action.kind !== "alter-column" || !action.touchesData) continue;
    if (!action.table || !action.column) continue;
    try {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count FROM "${action.table}" WHERE "${action.column}" IS NULL`,
      );
      const remaining = res.rows[0]?.count ?? 0;
      checks.push({
        name: `${action.table}.${action.column} has no NULL rows`,
        ok: remaining === 0,
        detail: remaining === 0 ? "constraint satisfied" : `${remaining} NULL row(s) remain`,
      });
    } catch {
      checks.push({
        name: `${action.table}.${action.column} verified`,
        ok: false,
        detail: "could not verify (table or column missing)",
      });
    }
  }

  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

const hasPath = (paths: string[], pattern: RegExp): boolean =>
  paths.some((p) => pattern.test(p));

/**
 * Builds the release readiness checklist for a high-risk change. Items that can
 * be derived from the plan, preview, post-checks, or changed file paths are
 * verified automatically; the rest are surfaced as manual sign-off items so a
 * maintainer can confirm them before release.
 *
 * Urgent fixes may set `urgent: true` with an `exceptionReason`; that downgrades
 * manual items to non-blocking but still records them for post-hoc review.
 */
export function evaluateReleaseReadiness(input: ReadinessInput): ReadinessReport {
  const { plan, preview, postChecks, changedPaths = [], urgent = false, exceptionReason } = input;
  const items: ReadinessItem[] = [];

  const risky = plan.destructive.length > 0 || plan.dataChanges.length > 0;

  // Tests
  const testsUpdated = hasPath(changedPaths, /(^|\/)(__tests__|tests?|spec)\//i) ||
    hasPath(changedPaths, /\.(test|spec)\.[tj]sx?$/i);
  items.push({
    category: "tests",
    name: "Automated tests cover the change",
    ok: testsUpdated || !risky,
    manual: !testsUpdated && risky,
    detail: testsUpdated
      ? "test files included in the change"
      : risky
        ? "no test changes detected for a risky migration"
        : "no risky statements; tests optional",
  });

  // Migration
  const postOk = postChecks ? postChecks.ok : false;
  items.push({
    category: "migration",
    name: "Migration plan parsed and post-checks pass",
    ok: !plan.isEmpty && (postChecks ? postOk : true),
    manual: !postChecks,
    detail: plan.isEmpty
      ? "migration contains no recognised statements"
      : postChecks
        ? postOk
          ? "all post-checks passed"
          : `${postChecks.failures.length} post-check(s) failed`
        : "post-checks not run yet",
  });

  // Config
  const configUpdated = hasPath(changedPaths, /(^|\/)(\.env|config|settings)/i) ||
    hasPath(changedPaths, /\.(env|ya?ml|json|toml)$/i);
  const needsConfig = plan.actions.some((a) => a.kind === "add-column" || a.kind === "alter-column");
  items.push({
    category: "config",
    name: "Configuration and env changes documented",
    ok: !needsConfig || configUpdated,
    manual: needsConfig && !configUpdated,
    detail: needsConfig
      ? configUpdated
        ? "config files updated alongside schema change"
        : "schema change may require config/env updates"
      : "no config-affecting statements",
  });

  // Rollback
  const rollbackReady = preview ? preview.rollbackNotes.length > 0 : plan.destructive.length === 0;
  items.push({
    category: "rollback",
    name: "Rollback or forward-fix plan documented",
    ok: rollbackReady,
    manual: plan.destructive.length > 0 && !preview,
    detail: rollbackReady
      ? "rollback notes available"
      : "destructive statements without rollback notes",
  });

  // Docs
  const docsUpdated = hasPath(changedPaths, /(^|\/)(docs?|README|CHANGELOG)/i) ||
    hasPath(changedPaths, /\.mdx?$/i);
  items.push({
    category: "docs",
    name: "Contributor and operator docs updated",
    ok: docsUpdated || !risky,
    manual: risky && !docsUpdated,
    detail: docsUpdated
      ? "documentation updated"
      : risky
        ? "high-risk change without doc updates"
        : "no doc updates required",
  });

  const exceptionApplied = urgent && Boolean(exceptionReason);
  const blockers = items.filter((i) => !i.ok && !i.manual);
  const manualSignOff = items.filter((i) => i.manual);
  const ok = exceptionApplied ? blockers.length === 0 : blockers.length === 0 && manualSignOff.length === 0;

  return { ok, items, blockers, manualSignOff, exceptionApplied };
}

export function formatReadiness(report: ReadinessReport): string {
  const lines: string[] = [];
  lines.push("Release readiness checklist");
  lines.push("===========================");
  for (const item of report.items) {
    const status = item.ok ? "PASS" : item.manual ? "SIGN-OFF" : "FAIL";
    lines.push(`  [${status}] (${item.category}) ${item.name} — ${item.detail}`);
  }
  lines.push("");
  if (report.exceptionApplied) {
    lines.push("Urgent-fix exception applied; manual sign-off deferred to post-release review.");
  }
  lines.push(report.ok ? "Release readiness: OK" : "Release readiness: BLOCKED");
  return lines.join("\n");
}

export function formatPreview(preview: MigrationPreview): string {
  const lines: string[] = [];
  lines.push(`Migration preview: ${preview.plan.migrationId}`);
  lines.push("=========================================");
  lines.push(`Statements parsed: ${preview.plan.actions.length}`);
  lines.push(`Would create:      ${preview.wouldCreate.length}`);
  lines.push(`Already present:   ${preview.alreadyPresent.length}`);
  lines.push(`Destructive:       ${preview.wouldRunDestructive.length}`);
  lines.push("");

  if (preview.wouldCreate.length > 0) {
    lines.push("Would create:");
    for (const name of preview.wouldCreate) lines.push(`  + ${name}`);
    lines.push("");
  }

  if (preview.wouldRunDestructive.length > 0) {
    lines.push("Destructive statements (review before applying):");
    for (const action of preview.wouldRunDestructive) lines.push(`  - ${action.name}`);
    lines.push("");
  }

  if (preview.affectedRecords.length > 0) {
    lines.push("Affected records:");
    for (const record of preview.affectedRecords) {
      const total = record.rowCount === null ? "unknown" : String(record.rowCount);
      const matching =
        record.matchingRows === null ? "subset (WHERE clause)" : String(record.matchingRows);
      lines.push(`  ~ ${record.table}: ${total} row(s) total, ${matching} affected`);
    }
    lines.push("");
  }

  lines.push("Rollback / forward-fix notes:");
  for (const note of preview.rollbackNotes) lines.push(`  - ${note}`);
  return lines.join("\n");
}

export function formatPostChecks(report: PostCheckReport): string {
  const lines: string[] = [];
  lines.push("Post-migration checks");
  lines.push("======================");
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
  }
  lines.push("");
  lines.push(report.ok ? "All post-checks passed." : `${report.failures.length} post-check(s) failed.`);
  return lines.join("\n");
}
