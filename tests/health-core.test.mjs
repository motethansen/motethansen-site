import test from "node:test";
import assert from "node:assert/strict";
import { computeHealth, withStaleSince, LINKEDIN_MAX_AGE_S } from "../shared/health-core.js";

const NOW = 1_800_000_000;
const okFeed = (over = {}) => ({ ts: NOW - 600, complete: true, degraded: false,
  sources: [{ id: "ulw", status: "live", staleSince: null }, { id: "va", status: "live", staleSince: null }], ...over });
const okLi = (over = {}) => ({ ts: NOW - 3600, discovery: "ok", ...over });

test("everything fresh and live is up", () => {
  const h = computeHealth(okFeed(), okLi(), NOW);
  assert.equal(h.status, "up"); assert.deepEqual(h.errors, []); assert.equal(h.component, "motethansen-site");
});
test("one 429 (snapshot for a run) is noise, not degraded", () => {
  const feed = okFeed({ sources: [{ id: "va", status: "snapshot", error: "HTTP 429", staleSince: NOW - 600 }] });
  assert.equal(computeHealth(feed, okLi(), NOW).status, "up");
});
test("a source on its snapshot for 4 h is degraded and names the source", () => {
  const feed = okFeed({ sources: [{ id: "va", status: "snapshot", error: "HTTP 429", staleSince: NOW - 4 * 3600 }] });
  const h = computeHealth(feed, okLi(), NOW);
  assert.equal(h.status, "degraded"); assert.match(h.errors[0], /va served from its snapshot for 4 h/);
});
test("a refresh that stopped running is degraded even if its last result was clean", () => {
  const h = computeHealth(okFeed({ ts: NOW - 5 * 3600 }), okLi(), NOW);
  assert.equal(h.status, "degraded"); assert.equal(h.checks.feed_refresh, false);
});
test("LinkedIn walled discovery is degraded with the manual-add consequence", () => {
  const h = computeHealth(okFeed(), okLi({ discovery: "walled" }), NOW);
  assert.equal(h.status, "degraded"); assert.match(h.errors[0], /added by hand/);
});
test("LinkedIn sync silent past its window is degraded", () => {
  const h = computeHealth(okFeed(), okLi({ ts: NOW - LINKEDIN_MAX_AGE_S - 1 }), NOW);
  assert.equal(h.checks.linkedin_sync, false); assert.equal(h.status, "degraded");
});
test("missing records are degraded, not up", () => {
  const h = computeHealth(null, null, NOW);
  assert.equal(h.status, "degraded"); assert.equal(h.errors.length, 2);
});
test("an incomplete feed is degraded", () => {
  assert.equal(computeHealth(okFeed({ complete: false }), okLi(), NOW).status, "degraded");
});
test("staleSince is carried across runs and cleared on recovery", () => {
  const prev = { sources: [{ id: "va", status: "snapshot", staleSince: NOW - 7200 }] };
  assert.equal(withStaleSince([{ id: "va", status: "snapshot", count: 1 }], prev, NOW)[0].staleSince, NOW - 7200);
  assert.equal(withStaleSince([{ id: "va", status: "live", count: 1 }], prev, NOW)[0].staleSince, null);
  assert.equal(withStaleSince([{ id: "va", status: "snapshot", count: 1 }], null, NOW)[0].staleSince, NOW);
});

const okQueue = (over = {}) => ({ poller: { ts: NOW - 120 }, pending: 0, oldestPendingS: null, ...over });

test("queue: live poller heartbeat and an empty queue are fine", () => {
  const h = computeHealth(okFeed(), okLi(), NOW, okQueue());
  assert.equal(h.status, "up"); assert.equal(h.checks.admin_poller, true); assert.equal(h.checks.admin_queue, true);
});
test("queue: a silent poller is degraded even with nothing queued", () => {
  const h = computeHealth(okFeed(), okLi(), NOW, okQueue({ poller: { ts: NOW - 20 * 60 } }));
  assert.equal(h.status, "degraded"); assert.match(h.errors[0], /poller last reported/);
});
test("queue: no heartbeat at all is degraded", () => {
  assert.equal(computeHealth(okFeed(), okLi(), NOW, okQueue({ poller: null })).checks.admin_poller, false);
});
test("queue: an address waiting 3 minutes is fine, 11 minutes is degraded", () => {
  assert.equal(computeHealth(okFeed(), okLi(), NOW, okQueue({ pending: 1, oldestPendingS: NOW - 180 })).status, "up");
  const h = computeHealth(okFeed(), okLi(), NOW, okQueue({ pending: 2, oldestPendingS: NOW - 11 * 60 }));
  assert.equal(h.status, "degraded"); assert.match(h.errors[0], /2 address\(es\) from \/admin have waited/);
});
test("queue omitted keeps the old behaviour", () => {
  assert.equal(computeHealth(okFeed(), okLi(), NOW).checks.admin_poller, undefined);
});

test("durations read as minutes when short, hours when long", () => {
  const short = computeHealth(okFeed(), okLi(), NOW, okQueue({ pending: 1, oldestPendingS: NOW - 18 * 60 }));
  assert.match(short.errors[0], /have waited 18 min without/);
  const long = computeHealth(okFeed({ ts: NOW - 5 * 3600 }), okLi(), NOW);
  assert.match(long.errors[0], /last ran 5 h ago/);
});
