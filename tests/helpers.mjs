/** Test doubles: a D1-compatible wrapper over node:sqlite, an in-memory R2 and KV. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../workers/articles/schema.sql", import.meta.url), "utf8"));
  const wrap = sql => {
    let args = [];
    const st = sqlite.prepare(sql);
    const api = {
      bind: (...a) => { args = a; return api; },
      first: async () => st.get(...args) ?? null,
      all: async () => ({ results: st.all(...args) }),
      run: async () => ({ success: true, meta: { changes: Number(st.run(...args).changes) } }),
    };
    return api;
  };
  return { prepare: wrap, raw: sqlite };
}

export function makeR2() {
  const m = new Map();
  return {
    m,
    put: async (k, v, o) => { m.set(k, { bytes: v, httpMetadata: o?.httpMetadata }); },
    get: async k => (m.has(k) ? { body: m.get(k).bytes, httpMetadata: m.get(k).httpMetadata } : null),
  };
}

export function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    m,
    get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async k => { m.delete(k); },
  };
}

export const ENV_BASE = { ADMIN_USER: "michael", ADMIN_PASSWORD: "correct horse battery", ADMIN_SESSION_SECRET: "s3cret-s3cret-s3cret" };

export function makeEnv() {
  return { ...ENV_BASE, DB: makeD1(), MEDIA: makeR2(), SITE_KV: makeKV() };
}

export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
