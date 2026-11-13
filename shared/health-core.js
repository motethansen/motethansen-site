/**
 * Pure health computation for GET /api/health (Vantage component-health contract, Mode B).
 *
 * The site makes no request to Substack. The thinkpad pulls both publications hourly and pushes them into the
 * article store; the store records when each source last synced (`external-sync-v1:<source>` in KV). Health is therefore
 * "did that job run recently, and does the articles service answer", never a live probe of a third party.
 */

export const SYNC_SOURCES = ["va-substack", "ulw-substack"];
export const SYNC_PREFIX = "external-sync-v1:";
export const SYNC_MAX_AGE_S = 3600;              // runs every 10 minutes: an hour of silence is six missed runs

/** "18 min" under 90 minutes, "3.5 h" above. */
const ago = s => (s < 5400 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.round(s / 360) / 10} h`);

/**
 * @param {Record<string, {ts:number, seen:number}|null>} syncs  last-sync record per source (null = never)
 * @param {boolean} serviceUp  the articles service answered
 * @param {number} nowS        epoch seconds
 */
export function computeHealth(syncs, serviceUp, nowS) {
  const errors = [];
  const checks = { articles_service: !!serviceUp };
  let status = "up";
  const degrade = msg => { errors.push(msg); if (status === "up") status = "degraded"; };

  if (!serviceUp) degrade("the articles service did not answer");
  for (const id of SYNC_SOURCES) {
    const rec = syncs[id];
    if (!rec) { checks[`sync_${id}`] = false; degrade(`${id} has never been pulled (thinkpad substack-sync.timer)`); continue; }
    const age = nowS - rec.ts;
    checks[`sync_${id}`] = age <= SYNC_MAX_AGE_S;
    if (age > SYNC_MAX_AGE_S) degrade(`${id} last pulled ${ago(age)} ago (runs every 10 min on the thinkpad)`);
  }
  return { component: "motethansen-site", status, ts: nowS, checks, errors };
}
