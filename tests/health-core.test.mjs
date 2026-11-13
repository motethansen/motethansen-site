import test from "node:test";
import assert from "node:assert/strict";
import { computeHealth, SYNC_MAX_AGE_S } from "../shared/health-core.js";

const NOW = 1_800_000_000;
const fresh = { "va-substack": { ts: NOW - 600, seen: 18 }, "ulw-substack": { ts: NOW - 1200, seen: 16 } };

test("both sources pulled recently and the service up is up", () => {
  const h = computeHealth(fresh, true, NOW);
  assert.equal(h.status, "up"); assert.deepEqual(h.errors, []); assert.equal(h.component, "motethansen-site");
  assert.deepEqual(Object.keys(h.checks).sort(), ["articles_service", "sync_ulw-substack", "sync_va-substack"]);
});
test("a source not pulled for over 3 h is degraded and names it and the job to look at", () => {
  const h = computeHealth({ ...fresh, "va-substack": { ts: NOW - SYNC_MAX_AGE_S - 60, seen: 18 } }, true, NOW);
  assert.equal(h.status, "degraded"); assert.equal(h.checks["sync_va-substack"], false);
  assert.match(h.errors[0], /va-substack last pulled 3 h ago .*thinkpad/);
});
test("exactly at the limit is still fine; one missed hourly run is fine", () => {
  assert.equal(computeHealth({ ...fresh, "va-substack": { ts: NOW - SYNC_MAX_AGE_S, seen: 1 } }, true, NOW).status, "up");
  assert.equal(computeHealth({ ...fresh, "va-substack": { ts: NOW - 5400, seen: 1 } }, true, NOW).status, "up");
});
test("a source never pulled is degraded", () => {
  const h = computeHealth({ ...fresh, "ulw-substack": null }, true, NOW);
  assert.equal(h.status, "degraded"); assert.match(h.errors[0], /ulw-substack has never been pulled/);
});
test("the articles service being down is degraded even when the pulls are fresh", () => {
  const h = computeHealth(fresh, false, NOW);
  assert.equal(h.status, "degraded"); assert.equal(h.checks.articles_service, false);
});
test("short durations are shown in minutes", () => {
  assert.match(computeHealth({ ...fresh, "va-substack": { ts: NOW - 4 * 3600, seen: 1 } }, true, NOW).errors[0], /4 h ago/);
});
