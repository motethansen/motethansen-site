/**
 * Pure health computation for GET /api/health (Vantage component-health contract, Mode B).
 *
 * Deliberately NOT a live probe. /api/writing?debug=1 re-fetches both Substack feeds on
 * every call, so a monitor polling that would multiply the traffic Substack already
 * answers with HTTP 429. Instead this reads two status records the jobs leave behind:
 *
 *   feed-status-v1           written hourly by the feed-refresh Worker
 *   linkedin-sync-status-v1  written twice daily by linkedin-sync on droplet 188
 *
 * Rules:
 *   - a Substack source on its snapshot is normal noise for a run or two; it becomes
 *     "degraded" only after it has been stale for SOURCE_STALE_AFTER_S
 *   - an hourly refresh that has not reported for FEED_MAX_AGE_S is "degraded"
 *   - the LinkedIn sync not reporting for LINKEDIN_MAX_AGE_S is "degraded"
 *   - LinkedIn discovery walled means new articles can only arrive by hand: "degraded"
 */

export const FEED_STATUS_KEY = "feed-status-v1";
export const LINKEDIN_STATUS_KEY = "linkedin-sync-status-v1";

export const FEED_MAX_AGE_S = 3 * 3600;          // hourly cron + 2 missed runs
export const SOURCE_STALE_AFTER_S = 3 * 3600;    // ~3 consecutive 429s
export const LINKEDIN_MAX_AGE_S = 20 * 3600;     // twice daily (12 h) + margin

const hours = s => `${Math.round(s / 360) / 10} h`;

/**
 * @param {object|null} feed      feed-status-v1: { ts, complete, degraded, sources:[{id,status,count,error,staleSince}] }
 * @param {object|null} linkedin  linkedin-sync-status-v1: { ts, discovery, collected, total, new }
 * @param {number} nowS           epoch seconds
 */
export function computeHealth(feed, linkedin, nowS) {
  const errors = [];
  const checks = {};
  let status = "up";
  const degrade = msg => { errors.push(msg); if (status === "up") status = "degraded"; };

  if (!feed) {
    degrade("feed-refresh has not written a status record yet");
    checks.feed_refresh = false;
  } else {
    const age = nowS - feed.ts;
    checks.feed_refresh = age <= FEED_MAX_AGE_S;
    if (!checks.feed_refresh) degrade(`feed-refresh last ran ${hours(age)} ago (hourly cron)`);
    if (feed.complete === false) degrade("feed is INCOMPLETE: a publication has no live data and no snapshot");
    for (const s of feed.sources || []) {
      const stale = s.status !== "live" && s.staleSince ? nowS - s.staleSince : 0;
      checks[`source_${s.id}`] = !(stale > SOURCE_STALE_AFTER_S) && s.status !== "missing";
      if (stale > SOURCE_STALE_AFTER_S) {
        degrade(`${s.id} served from its snapshot for ${hours(stale)}: ${s.error || "upstream failing"}`);
      }
    }
  }

  if (!linkedin) {
    degrade("linkedin-sync has not written a status record yet");
    checks.linkedin_sync = false;
  } else {
    const age = nowS - linkedin.ts;
    checks.linkedin_sync = age <= LINKEDIN_MAX_AGE_S;
    if (!checks.linkedin_sync) degrade(`linkedin-sync last reported ${hours(age)} ago (runs twice daily)`);
    checks.linkedin_discovery = linkedin.discovery === "ok";
    if (linkedin.discovery === "walled") {
      degrade("LinkedIn discovery is walled (HTTP 999): new articles reach the site only if added by hand");
    }
  }

  return { component: "motethansen-site", status, ts: nowS, checks, errors };
}

/** Carry `staleSince` forward so "stale for N hours" survives across hourly runs. */
export function withStaleSince(sources, previous, nowS) {
  const prev = Object.fromEntries(((previous && previous.sources) || []).map(s => [s.id, s]));
  return sources.map(s => {
    const p = prev[s.id];
    const staleSince = s.status === "live" ? null : (p && p.status !== "live" && p.staleSince) || nowS;
    return { id: s.id, status: s.status, count: s.count, error: s.error || null, staleSince };
  });
}
