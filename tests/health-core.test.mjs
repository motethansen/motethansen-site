import test from "node:test";
import assert from "node:assert/strict";
import { computeHealth, withStaleSince } from "../shared/health-core.js";

const NOW = 1_800_000_000;
const okFeed = (over = {}) => ({ ts: NOW - 600, complete: true, degraded: false,
  sources: [{ id: "ulw", status: "live", staleSince: null }, { id: "va", status: "live", staleSince: null }], ...over });

test("everything fresh and live is up", () => {
  const h = computeHealth(okFeed(), NOW);
  assert.equal(h.status, "up"); assert.deepEqual(h.errors, []); assert.equal(h.component, "motethansen-site");
});
test("one 429 (snapshot for a run) is noise, not degraded", () => {
  const feed = okFeed({ sources: [{ id: "va", status: "snapshot", error: "HTTP 429", staleSince: NOW - 600 }] });
  assert.equal(computeHealth(feed, NOW).status, "up");
});
test("a source on its snapshot for 4 h is degraded and names the source", () => {
  const feed = okFeed({ sources: [{ id: "va", status: "snapshot", error: "HTTP 429", staleSince: NOW - 4 * 3600 }] });
  const h = computeHealth(feed, NOW);
  assert.equal(h.status, "degraded"); assert.match(h.errors[0], /va served from its snapshot for 4 h/);
});
test("a refresh that stopped running is degraded even if its last result was clean", () => {
  const h = computeHealth(okFeed({ ts: NOW - 5 * 3600 }), NOW);
  assert.equal(h.status, "degraded"); assert.equal(h.checks.feed_refresh, false); assert.match(h.errors[0], /last ran 5 h ago/);
});
test("a missing record is degraded, not up", () => {
  const h = computeHealth(null, NOW);
  assert.equal(h.status, "degraded"); assert.equal(h.errors.length, 1);
});
test("an incomplete feed is degraded", () => {
  assert.equal(computeHealth(okFeed({ complete: false }), NOW).status, "degraded");
});
test("short durations read in minutes", () => {
  assert.match(computeHealth(okFeed({ ts: NOW - 4 * 3600 }), NOW).errors[0], /4 h ago/);
  const feed = okFeed({ sources: [{ id: "va", status: "snapshot", error: "x", staleSince: NOW - 4 * 3600 }] });
  assert.match(computeHealth(feed, NOW).errors[0], /4 h/);
});
test("staleSince is carried across runs and cleared on recovery", () => {
  const prev = { sources: [{ id: "va", status: "snapshot", staleSince: NOW - 7200 }] };
  assert.equal(withStaleSince([{ id: "va", status: "snapshot", count: 1 }], prev, NOW)[0].staleSince, NOW - 7200);
  assert.equal(withStaleSince([{ id: "va", status: "live", count: 1 }], prev, NOW)[0].staleSince, null);
  assert.equal(withStaleSince([{ id: "va", status: "snapshot", count: 1 }], null, NOW)[0].staleSince, NOW);
});
