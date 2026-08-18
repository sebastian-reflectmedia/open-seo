#!/usr/bin/env node
// Write Reflect's Cloudflare resource ids into wrangler.jsonc at deploy time.
//
// The fork is public, so the ids never live in git. They arrive as env vars
// (repo secrets in CI, a sourced file locally) and this script injects them
// into the working copy immediately before `pnpm run deploy`.
//
// It must run BEFORE that script, because `pnpm run deploy` is
// `db:migrate:prod && build && wrangler deploy`, and the migrate step reads
// `database_id` and `migrations_dir` out of this same config. A deploy that
// skips this step silently targets upstream's D1, KV and R2.
//
// The design rationale — including every rejected alternative for keeping ids
// out of the file — is in the private reflect-openseo repo, docs/upstream-sync.md.
//
// Usage:  node .reflect/apply-resources.mjs [--check]
//   --check  verify only; exit non-zero if the file is not already correct.
//            Does not write. Used by the deploy workflow's post-check.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATH = resolve(process.cwd(), "wrangler.jsonc");
const checkOnly = process.argv.includes("--check");

// Every value we override, and where it lives. `binding` identifies the object
// inside the named array; `key` is the field to rewrite. Upstream renaming a
// binding must break the build loudly rather than deploy against its own
// resources, which is why every entry is required and verified twice.
const RESOURCES = [
  { env: "REFLECT_KV_ID", array: "kv_namespaces", binding: "KV", key: "id" },
  { env: "REFLECT_OAUTH_KV_ID", array: "kv_namespaces", binding: "OAUTH_KV", key: "id" },
  { env: "REFLECT_D1_NAME", array: "d1_databases", binding: "DB", key: "database_name" },
  { env: "REFLECT_D1_ID", array: "d1_databases", binding: "DB", key: "database_id" },
  { env: "REFLECT_R2_BUCKET", array: "r2_buckets", binding: "R2", key: "bucket_name" },
];

// Not a secret, and not negotiable. Our Cloudflare Access applications match the
// production hostname exactly, with no wildcard, so a version preview URL is an
// unprotected hostname running the full app against production data. One was
// found live on 2026-07-29. The account-level `previews_enabled: false` is what
// protects us today; this line stops a deploy from re-enabling previews here.
// Do not flip this without first extending Access to the preview hostnames.
const PREVIEW_URLS = false;

const problems = [];
const fail = (msg) => problems.push(msg);

/** Read every required id from the environment before touching the file. */
function readEnv() {
  const values = {};
  for (const r of RESOURCES) {
    const v = process.env[r.env];
    if (!v || !v.trim()) {
      fail(`env ${r.env} is unset or empty (needed for ${r.array}.${r.binding}.${r.key})`);
      continue;
    }
    if (v.includes('"')) {
      fail(`env ${r.env} contains a double quote, which cannot be a JSON string value here`);
      continue;
    }
    values[r.env] = v.trim();
  }
  return values;
}

/**
 * Isolate the single binding object inside `array` whose "binding" is `binding`.
 * Binding objects contain no nested objects, so a brace-free span is an exact
 * and much safer match than trying to parse JSONC with a regex.
 */
function findBindingBlock(source, array, binding) {
  const arrayRe = new RegExp(`"${array}"\\s*:\\s*\\[`, "g");
  const arrayMatches = [...source.matchAll(arrayRe)];
  if (arrayMatches.length !== 1) {
    fail(`expected exactly 1 "${array}" array in wrangler.jsonc, found ${arrayMatches.length}`);
    return null;
  }

  // Walk to the matching close bracket so we never match a binding in a
  // different (or commented-out) array.
  const start = arrayMatches[0].index + arrayMatches[0][0].length;
  let depth = 1;
  let i = start;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  if (depth !== 0) {
    fail(`unbalanced brackets in "${array}"`);
    return null;
  }
  const arrayBody = source.slice(start, i - 1);

  const blockRe = new RegExp(`\\{[^{}]*"binding"\\s*:\\s*"${binding}"[^{}]*\\}`, "g");
  const blocks = arrayBody.match(blockRe) ?? [];
  if (blocks.length !== 1) {
    fail(
      `expected exactly 1 binding "${binding}" in "${array}", found ${blocks.length}` +
        ` — upstream may have renamed or duplicated it`,
    );
    return null;
  }
  return { block: blocks[0], arrayStart: start };
}

/** Replace one key inside one binding object. Exactly-once or it fails. */
function applyOne(source, { array, binding, key }, value) {
  const found = findBindingBlock(source, array, binding);
  if (!found) return source;

  const keyRe = new RegExp(`("${key}"\\s*:\\s*")([^"]*)(")`, "g");
  const hits = found.block.match(keyRe) ?? [];
  if (hits.length !== 1) {
    fail(`expected exactly 1 "${key}" in binding "${binding}", found ${hits.length}`);
    return source;
  }

  const updated = found.block.replace(keyRe, `$1${value}$3`);
  // Replace the block at its own offset rather than by value, so an identical
  // block elsewhere in the file cannot be hit instead.
  const at = source.indexOf(found.block, found.arrayStart);
  return source.slice(0, at) + updated + source.slice(at + found.block.length);
}

/** Set top-level preview_urls, inserting the key if upstream has not got one. */
function applyPreviewUrls(source) {
  const re = /^(\s*)"preview_urls"\s*:\s*(true|false)\s*,?/m;
  if (re.test(source)) {
    return source.replace(re, `$1"preview_urls": ${PREVIEW_URLS},`);
  }
  // Insert after the top-level "main" entry, which upstream has always had and
  // which is unambiguously at depth 1.
  const mainRe = /^(\s*)"main"\s*:\s*"[^"]*"\s*,?\s*$/m;
  const m = source.match(mainRe);
  if (!m) {
    fail(`could not find a top-level "main" key to anchor "preview_urls" insertion`);
    return source;
  }
  const indent = m[1];
  const comment =
    `${indent}// Reflect: Access matches the production hostname exactly, so preview URLs\n` +
    `${indent}// are unauthenticated. Do not enable without an Access policy covering them.\n`;
  return source.replace(mainRe, `${m[0]}\n${comment}${indent}"preview_urls": ${PREVIEW_URLS},`);
}

/** Strip // and /* *\/ comments without mangling string contents. */
function stripComments(src) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse JSONC: strip comments, then trailing commas. */
function parseJsonc(src) {
  const noComments = stripComments(src);
  const noTrailing = noComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailing);
}

/**
 * Phase 2. Re-read the written file as data and assert every value landed.
 * Phase 1 proves a replacement happened; only this proves it happened in the
 * right place and produced valid config.
 */
function verify(source, values) {
  let parsed;
  try {
    parsed = parseJsonc(source);
  } catch (e) {
    fail(`result is not parseable as JSONC: ${e.message}`);
    return;
  }

  for (const r of RESOURCES) {
    const arr = parsed[r.array];
    if (!Array.isArray(arr)) {
      fail(`verify: "${r.array}" missing or not an array`);
      continue;
    }
    const entry = arr.find((x) => x && x.binding === r.binding);
    if (!entry) {
      fail(`verify: no binding "${r.binding}" in "${r.array}"`);
      continue;
    }
    const want = values[r.env];
    if (entry[r.key] !== want) {
      fail(`verify: ${r.array}.${r.binding}.${r.key} is "${entry[r.key]}", expected "${want}"`);
    }
  }

  if (parsed.preview_urls !== PREVIEW_URLS) {
    fail(`verify: preview_urls is ${JSON.stringify(parsed.preview_urls)}, expected ${PREVIEW_URLS}`);
  }

  // Guard the one setting whose loss is invisible: the cron that drives
  // scheduled rank checks.
  if (!parsed.triggers?.crons?.length) {
    fail(`verify: triggers.crons is empty — scheduled rank checks would never run`);
  }
}

function main() {
  const values = readEnv();
  if (problems.length) return report();

  let source;
  try {
    source = readFileSync(CONFIG_PATH, "utf8");
  } catch (e) {
    fail(`cannot read ${CONFIG_PATH}: ${e.message}`);
    return report();
  }

  // --check inspects the file exactly as it stands. It must never apply the
  // rewrite first: verifying the would-be result would pass against an
  // untouched upstream config and report success for a deploy that never
  // targeted our resources at all.
  if (checkOnly) {
    verify(source, values);
    if (problems.length) return report();
    console.log("[apply-resources] check passed — config already targets Reflect resources");
    return;
  }

  const original = source;
  for (const r of RESOURCES) {
    source = applyOne(source, r, values[r.env]);
  }
  source = applyPreviewUrls(source);

  if (problems.length) return report();

  verify(source, values);
  if (problems.length) return report();

  if (source !== original) {
    writeFileSync(CONFIG_PATH, source);
  }
  console.log(
    `[apply-resources] wrangler.jsonc now targets Reflect resources ` +
      `(D1 ${values.REFLECT_D1_NAME}, R2 ${values.REFLECT_R2_BUCKET}, preview_urls ${PREVIEW_URLS})`,
  );
}

function report() {
  console.error("[apply-resources] FAILED — refusing to deploy:\n");
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    "\nThis is a hard failure by design. Deploying with an unverified config would " +
      "target upstream's D1/KV/R2 instead of Reflect's.\n" +
      "If upstream renamed a binding, update .reflect/apply-resources.mjs and " +
      "config/wrangler.reflect.jsonc in reflect-openseo together.",
  );
  process.exit(1);
}

main();
