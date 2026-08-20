#!/usr/bin/env node
// Classify the migrations a release adds, so the pipeline can decide whether it
// may ship without a human.
//
// The decision rests on one asymmetry: `wrangler rollback` restores the Worker,
// but drizzle migrations are forward-only — there is no down migration. Once a
// release has migrated production D1, reverting the code leaves the schema
// ahead of it. The only way back for data is a D1 Time Travel restore, which
// rewinds the whole database and discards every write since the bookmark. That
// is a break-glass outage, not a rollback.
//
// So a release is auto-shippable exactly when a code-only rollback would be a
// complete undo:
//
//   none      no migrations at all. Rollback is exact.
//   additive  every statement creates a NEW object (CREATE TABLE / CREATE INDEX
//             / CREATE UNIQUE INDEX). Old code cannot see the new tables, so
//             rolling the Worker back and leaving them in place is consistent.
//   risky     anything that touches something already there — ALTER, DROP,
//             INSERT/UPDATE/DELETE, PRAGMA (drizzle's SQLite table-rebuild
//             pattern), or a statement this script cannot parse.
//
// Unknown means risky, always. A misread here auto-ships a migration that
// mutates production data, so every ambiguous case fails toward the human.
//
// Only `drizzle/` is classified. That is the directory `wrangler d1 migrations
// apply` actually runs against production; `drizzle-pg/` is upstream's
// self-hosted Postgres path and never executes here.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const MIGRATIONS_DIR = "drizzle";

// A statement is safe only if it creates a brand-new object. Prefix match, so
// "CREATE TABLE IF NOT EXISTS" and "CREATE UNIQUE INDEX" both land correctly.
const SAFE_PREFIXES = ["CREATE TABLE", "CREATE UNIQUE INDEX", "CREATE INDEX"];

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Strip comments before splitting on `;`. Drizzle's `--> statement-breakpoint`
// markers are line comments, so this removes them too.
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function statementsOf(sql) {
  return stripComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function leadingTokens(statement) {
  return statement.replace(/\s+/g, " ").trim().toUpperCase();
}

// → { verdict: "additive" | "risky", offenders: string[] }
export function classifySql(sql) {
  const statements = statementsOf(sql);
  if (statements.length === 0) {
    return { verdict: "risky", offenders: ["no parseable statements"] };
  }
  const offenders = [];
  for (const statement of statements) {
    const head = leadingTokens(statement);
    if (!SAFE_PREFIXES.some((prefix) => head.startsWith(prefix))) {
      offenders.push(head.split(" ").slice(0, 4).join(" "));
    }
  }
  return offenders.length > 0
    ? { verdict: "risky", offenders: [...new Set(offenders)] }
    : { verdict: "additive", offenders: [] };
}

function addedMigrations(base, head) {
  const out = git([
    "diff",
    "--name-only",
    "--diff-filter=A",
    base,
    head,
    "--",
    `${MIGRATIONS_DIR}/*.sql`,
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function classifyRange(base, head) {
  const files = addedMigrations(base, head);
  if (files.length === 0) {
    return { class: "none", files: [] };
  }
  const results = files.map((path) => {
    const sql = git(["show", `${head}:${path}`]);
    return { path, ...classifySql(sql) };
  });
  const risky = results.some((r) => r.verdict === "risky");
  return { class: risky ? "risky" : "additive", files: results };
}

// ---------------------------------------------------------------------------
// Self-test. Lives here rather than in the vitest suite on purpose: every file
// under src/ and every test config belongs to upstream, and editing one buys a
// merge conflict on some future release. The fork's rule is new paths only, so
// this script carries its own tests and the workflow runs `--self-test`.
// ---------------------------------------------------------------------------

const CASES = [
  {
    name: "pure CREATE TABLE + indexes is additive",
    sql: "CREATE TABLE `a` (\n`id` text PRIMARY KEY NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `a_idx` ON `a` (`id`);",
    want: "additive",
  },
  {
    name: "DROP TABLE is risky",
    sql: "CREATE TABLE `a` (`id` text);--> statement-breakpoint\nDROP TABLE `old`;",
    want: "risky",
  },
  {
    name: "ALTER TABLE is risky",
    sql: "ALTER TABLE `a` ADD `b` text;",
    want: "risky",
  },
  {
    name: "DROP COLUMN is risky",
    sql: "ALTER TABLE `a` DROP COLUMN `b`;",
    want: "risky",
  },
  {
    name: "data statements are risky",
    sql: "INSERT INTO `a` VALUES (1);",
    want: "risky",
  },
  { name: "UPDATE is risky", sql: "UPDATE `a` SET `b` = 1;", want: "risky" },
  { name: "DELETE is risky", sql: "DELETE FROM `a`;", want: "risky" },
  {
    name: "PRAGMA table-rebuild is risky",
    sql: "PRAGMA foreign_keys=OFF;",
    want: "risky",
  },
  { name: "DROP INDEX is risky", sql: "DROP INDEX `a_idx`;", want: "risky" },
  { name: "empty file is risky, not additive", sql: "\n\n", want: "risky" },
  {
    name: "comment-only file is risky",
    sql: "-- nothing here\n",
    want: "risky",
  },
  {
    name: "IF NOT EXISTS still reads as CREATE TABLE",
    sql: "CREATE TABLE IF NOT EXISTS `a` (`id` text);",
    want: "additive",
  },
  {
    name: "final statement without a trailing semicolon still counts",
    sql: "CREATE TABLE `a` (`id` text);\nDROP TABLE `b`",
    want: "risky",
  },
  {
    name: "a DROP hidden in a comment does not make it risky",
    sql: "CREATE TABLE `a` (`id` text); -- DROP TABLE `b`",
    want: "additive",
  },
  {
    name: "lowercase drop is still risky",
    sql: "create table `a` (`id` text);\ndrop table `b`;",
    want: "risky",
  },
];

function selfTest() {
  let failed = 0;
  for (const c of CASES) {
    const got = classifySql(c.sql).verdict;
    if (got !== c.want) {
      console.error(`FAIL ${c.name}: want ${c.want}, got ${got}`);
      failed++;
    }
  }
  console.log(
    `${CASES.length - failed}/${CASES.length} classifier cases passed`,
  );
  if (failed > 0) process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const base = arg("base");
  const head = arg("head") ?? "HEAD";
  if (!base) {
    console.error(
      "usage: reflect-classify-migrations.mjs --base <ref> [--head <ref>]\n" +
        "       reflect-classify-migrations.mjs --self-test",
    );
    process.exit(2);
  }

  let result;
  try {
    result = classifyRange(base, head);
  } catch (err) {
    // Cannot resolve the range (shallow clone, force push, missing ref). Refuse
    // to guess — an unresolvable range must not read as "no migrations".
    console.error(`could not classify ${base}..${head}: ${err.message}`);
    result = { class: "risky", files: [], error: String(err.message) };
  }

  // This script reports risk and nothing else. Whether a given class is allowed
  // to skip review is a policy question the workflow answers, because it also
  // has to consult the REFLECT_AUTO_SHIP switch.
  console.log(JSON.stringify(result, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `class=${result.class}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### Migration risk: \`${result.class}\``, ""];
    if (result.files.length === 0)
      lines.push("No migrations added by this change.");
    for (const f of result.files) {
      lines.push(
        f.verdict === "additive"
          ? `- \`${f.path}\` — additive`
          : `- \`${f.path}\` — **risky**: ${f.offenders.join(", ")}`,
      );
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
}

main();
