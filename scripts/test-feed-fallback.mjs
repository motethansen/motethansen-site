#!/usr/bin/env node
/**
 * Proves the per-source fallback + cache-write guard in shared/feed-core.js.
 *
 * Simulates the failure modes Substack actually produces for one publication
 * while the other keeps working: a network-level block, a 200 challenge page
 * that parses to 0 items, and a failure with no snapshot to fall back on.
 *
 * Hits the real Substack feeds for the baseline, so it needs network access.
 *
 *   node scripts/test-feed-fallback.mjs
 */
import { buildFeed, cacheFeed, CACHE_KEY, SOURCE_CACHE_PREFIX }
  from "../shared/feed-core.js";

const store = new Map();
const env = { SITE_KV: {
  async get(k) { return store.has(k) ? store.get(k) : null; },
  async put(k, v) { store.set(k, v); },
}};

const realFetch = globalThis.fetch;
let mode = "ok";
globalThis.fetch = async (url, opts) => {
  if (url.includes("urbanlifeworks")) {
    if (mode === "fail") throw new Error("simulated network block");
    if (mode === "challenge") return new Response("<html>Just a moment...</html>", { status: 200 });
  }
  return realFetch(url, opts);
};

const show = (label, b) =>
  console.log(`${label}\n  complete=${b.complete} degraded=${b.degraded} total=${b.posts.length}\n` +
    b.sources.map(s => `  ${s.id}: ${s.status} (${s.count})${s.error ? " — " + s.error : ""}`).join("\n"));

let pass = true;
const check = (name, cond) => { console.log(`  ${cond ? "✔" : "✘"} ${name}`); if (!cond) pass = false; };

// 1. Everything live → snapshots written, cache written.
const a = await buildFeed(env);
show("\n[1] all sources live", a);
console.log("  wrote merged cache:", await cacheFeed(env, a));
check("complete", a.complete);
check("not degraded", !a.degraded);
check("snapshot stored for ulw", store.has(SOURCE_CACHE_PREFIX + "ulw-substack"));
check("merged cache stored", store.has(CACHE_KEY));
const fullTotal = a.posts.length;

// 2. ULW hard-fails, snapshot exists → served from snapshot, still complete.
mode = "fail";
const b = await buildFeed(env);
show("\n[2] ULW network failure, snapshot present", b);
check("still complete", b.complete);
check("flagged degraded", b.degraded);
check("ULW served from snapshot", b.sources.find(s => s.id === "ulw-substack").status === "snapshot");
check("no posts lost", b.posts.length === fullTotal);
check("cache still written (degraded → short TTL)", await cacheFeed(env, b));

// 3. ULW returns a 200 challenge page (0 items) → must NOT count as success.
mode = "challenge";
const c = await buildFeed(env);
show("\n[3] ULW returns 200 challenge page", c);
check("ULW fell back to snapshot, not treated as empty-but-ok",
      c.sources.find(s => s.id === "ulw-substack").status === "snapshot");
check("no posts lost", c.posts.length === fullTotal);

// 4. ULW fails AND no snapshot → incomplete, must NOT be cached.
mode = "fail";
store.delete(SOURCE_CACHE_PREFIX + "ulw-substack");
const d = await buildFeed(env);
show("\n[4] ULW failure with no snapshot", d);
check("marked incomplete", !d.complete);
check("merged cache write REFUSED", (await cacheFeed(env, d)) === false);
check("previously cached good list untouched",
      JSON.parse(store.get(CACHE_KEY)).length === fullTotal);

console.log(pass ? "\n✅ all assertions passed" : "\n❌ FAILURES");
process.exit(pass ? 0 : 1);
