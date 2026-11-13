import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCredentials, signSession, verifySession, throttleState, recordFailure,
  THROTTLE_MAX_FAILS, THROTTLE_WINDOW_S,
} from "../shared/admin-core.js";
import { login, me } from "../workers/articles/src/auth.js";

const NOW = 1_800_000_000;
const ENV = { ADMIN_USER: "michael", ADMIN_PASSWORD: "correct horse battery", ADMIN_SESSION_SECRET: "s3cret-s3cret-s3cret" };

function kv(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    m,
    get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async k => { m.delete(k); },
  };
}
const req = (path, { method = "POST", body, origin = "https://motethansen.com", cookie } = {}) =>
  new Request("https://motethansen.com" + path, {
    method,
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), "cf-connecting-ip": "1.2.3.4" },
    body: body ? JSON.stringify(body) : undefined,
  });
const cookieOf = res => res.headers.get("set-cookie").split(";")[0];

test("credentials: both must match; unset env admits nobody", async () => {
  assert.equal(await checkCredentials(ENV, "michael", "correct horse battery"), true);
  assert.equal(await checkCredentials(ENV, "michael", "wrong"), false);
  assert.equal(await checkCredentials(ENV, "someone", "correct horse battery"), false);
  assert.equal(await checkCredentials({}, "", ""), false);
  assert.equal(await checkCredentials({ ADMIN_USER: "a", ADMIN_PASSWORD: "" }, "a", ""), false);
});

test("session: valid, tampered, expired and wrong-secret tokens", async () => {
  const t = await signSession(ENV.ADMIN_SESSION_SECRET, "michael", NOW);
  assert.equal((await verifySession(ENV.ADMIN_SESSION_SECRET, t, NOW + 60)).u, "michael");
  assert.equal(await verifySession(ENV.ADMIN_SESSION_SECRET, t, NOW + 13 * 3600), null);
  assert.equal(await verifySession("other-secret", t, NOW + 60), null);
  const [p, s] = t.split(".");
  const forged = btoa(JSON.stringify({ u: "michael", exp: NOW + 999999 })).replace(/=+$/, "");
  assert.equal(await verifySession(ENV.ADMIN_SESSION_SECRET, `${forged}.${s}`, NOW + 60), null);
  assert.equal(await verifySession(ENV.ADMIN_SESSION_SECRET, "garbage", NOW), null);
  assert.equal(await verifySession(undefined, t, NOW), null);
});

test("throttle: locks after the max failures, lifts after the window", () => {
  let rec = null;
  for (let i = 0; i < THROTTLE_MAX_FAILS; i++) rec = recordFailure(rec, NOW + i);
  assert.equal(throttleState(rec, NOW + 10).locked, true);
  assert.equal(throttleState(rec, NOW + THROTTLE_WINDOW_S + 1).locked, false);
  assert.equal(throttleState(recordFailure(null, NOW), NOW + 1).locked, false);
});

test("login: wrong password 401, throttled after 5, right password sets a hardened cookie", async () => {
  const SITE_KV = kv();
  const env = { ...ENV, SITE_KV };
  for (let i = 0; i < THROTTLE_MAX_FAILS; i++) {
    assert.equal((await login({ request: req("/api/admin/login", { body: { username: "michael", password: "no" } }), env })).status, 401);
  }
  const locked = await login({ request: req("/api/admin/login", { body: { username: "michael", password: "correct horse battery" } }), env });
  assert.equal(locked.status, 429);                         // even the right password is refused while locked
  assert.ok(locked.headers.get("retry-after"));
  const env2 = { ...ENV, SITE_KV: kv() };
  const ok = await login({ request: req("/api/admin/login", { body: { username: "michael", password: "correct horse battery" } }), env: env2 });
  assert.equal(ok.status, 200);
  const c = ok.headers.get("set-cookie");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) assert.match(c, new RegExp(flag));
});

test("login: cross-origin and unconfigured are refused", async () => {
  const env = { ...ENV, SITE_KV: kv() };
  assert.equal((await login({ request: req("/api/admin/login", { origin: "https://evil.example", body: {} }), env })).status, 403);
  assert.equal((await login({ request: req("/api/admin/login", { origin: null, body: {} }), env })).status, 403);
  assert.equal((await login({ request: req("/api/admin/login", { body: {} }), env: { SITE_KV: kv() } })).status, 503);
});

async function signedIn(env) {
  const r = await login({ request: req("/api/admin/login", { body: { username: "michael", password: "correct horse battery" } }), env });
  return cookieOf(r);
}

test("me: reports the signed-in user, 401 otherwise", async () => {
  const env = { ...ENV, SITE_KV: kv() };
  const cookie = await signedIn(env);
  const ok = await me({ request: req("/api/admin/me", { method: "GET", cookie }), env });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).user, "michael");
  assert.equal((await me({ request: req("/api/admin/me", { method: "GET" }), env })).status, 401);
  assert.equal((await me({ request: req("/api/admin/me", { method: "GET", cookie: "admin_session=forged.value" }), env })).status, 401);
});
