#!/usr/bin/env node
/**
 * Warm the per-source feed snapshots in KV from THIS machine.
 *
 * Why this exists: Substack intermittently blocks Cloudflare's egress network,
 * so a rebuild running inside a Worker can fail to fetch a publication that a
 * residential connection fetches fine. shared/feed-core.js falls back to a
 * per-source snapshot in KV when that happens — this script fills those
 * snapshots using the same parser, from a network Substack does serve.
 *
 * Run it before busting the merged cache (deploy.sh does), and any time a
 * publication has been blocked long enough for its snapshot to expire.
 *
 *   node scripts/warm-feed-cache.mjs           # write snapshots to KV
 *   node scripts/warm-feed-cache.mjs --dry-run # fetch + report only
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCES, SOURCE_CACHE_PREFIX, SOURCE_CACHE_TTL, fetchFeed } from "../shared/feed-core.js";

const NAMESPACE_ID = "1b97cac1e10d4bcaaa1bef301a86af26"; // SITE_KV
const ACCOUNT_ID = "f999794776f99de37612b4abbfbfc21a";
const dryRun = process.argv.includes("--dry-run");

// Same reason as deploy.sh: let wrangler use its OAuth session, not .env tokens.
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };
for (const k of ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_EMAIL",
                 "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_EMAIL"]) delete env[k];

let failed = 0;

for (const source of SOURCES) {
  let posts;
  try {
    posts = await fetchFeed(source);
  } catch (e) {
    console.error(`✘ ${source.id}: fetch failed — ${e.message}`);
    failed++;
    continue;
  }

  if (!posts.length) {
    console.error(`✘ ${source.id}: fetched but parsed 0 items — refusing to write an empty snapshot`);
    failed++;
    continue;
  }

  if (dryRun) {
    console.log(`• ${source.id}: ${posts.length} posts (dry run, not written)`);
    continue;
  }

  const key = SOURCE_CACHE_PREFIX + source.id;
  const tmp = join(tmpdir(), `feed-snapshot-${source.id}.json`);
  writeFileSync(tmp, JSON.stringify(posts));
  try {
    execFileSync("npx", [
      "wrangler", "kv", "key", "put", key,
      "--path", tmp,
      "--namespace-id", NAMESPACE_ID,
      "--ttl", String(SOURCE_CACHE_TTL),
      "--remote",
    ], { env, stdio: ["ignore", "ignore", "inherit"] });
    console.log(`✔ ${source.id}: wrote ${posts.length} posts to "${key}"`);
  } catch (e) {
    console.error(`✘ ${source.id}: KV write failed — ${e.message}`);
    failed++;
  } finally {
    unlinkSync(tmp);
  }
}

if (failed) {
  console.error(`\n${failed} source(s) failed — snapshots are incomplete.`);
  process.exit(1);
}
console.log("\nAll source snapshots warm.");
