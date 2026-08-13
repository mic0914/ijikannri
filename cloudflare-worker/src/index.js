const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const bytesToUrl = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const textToUrl = (text) => bytesToUrl(new TextEncoder().encode(text));
const urlToText = (value) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
};
const sign = async (payload, secret) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToUrl(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
};
const safeEqual = (left, right) => {
  const first = new TextEncoder().encode(left);
  const second = new TextEncoder().encode(right);
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) difference |= first[index] ^ second[index];
  return difference === 0;
};
const validateToken = async (token, secret) => {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature || !safeEqual(await sign(body, secret), signature)) return null;
  try {
    const payload = JSON.parse(urlToText(body));
    return payload.id && Number.isFinite(payload.exp) && Date.now() <= payload.exp ? payload : null;
  } catch {
    return null;
  }
};
const isAdmin = (request, env) => Boolean(env.ADMIN_KEY) && safeEqual(request.headers.get("authorization") || "", `Bearer ${env.ADMIN_KEY}`);
const clean = (value, maximum) => String(value || "").trim().slice(0, maximum);
const deviceType = (userAgent) => /iPhone/i.test(userAgent) ? "iPhone" : /iPad/i.test(userAgent) ? "iPad" : /Android/i.test(userAgent) ? "Android" : /Windows/i.test(userAgent) ? "Windows PC" : /Mac/i.test(userAgent) ? "Mac" : "その他";

const ensureSchema = async (env) => {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS issued_urls (id TEXT PRIMARY KEY, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS visitors (url_id TEXT NOT NULL, device_id TEXT NOT NULL, company TEXT NOT NULL, person TEXT NOT NULL, device_type TEXT NOT NULL, first_access INTEGER NOT NULL, last_access INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 1, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (url_id, device_id))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_visitors_last_access ON visitors(last_access DESC)")
  ]);
  const { results } = await env.DB.prepare("PRAGMA table_info(visitors)").all();
  if (!results.some((column) => column.name === "revoked")) {
    await env.DB.prepare("ALTER TABLE visitors ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0").run();
  }
};
const readBody = async (request) => {
  try { return await request.json(); } catch { return null; }
};
const requireSession = async (input, env) => {
  const payload = await validateToken(input?.token, env.SIGNING_SECRET);
  if (!payload) return { response: json({ error: "利用期限が終了しています" }, 403) };
  const deviceId = clean(input?.deviceId, 80);
  if (!deviceId) return { response: json({ error: "端末情報がありません" }, 400) };
  const visitor = await env.DB.prepare("SELECT company, person, revoked FROM visitors WHERE url_id=? AND device_id=?").bind(payload.id, deviceId).first();
  if (!visitor) return { response: json({ registered: false, error: "利用者登録が必要です" }, 401) };
  if (visitor.revoked) return { response: json({ revoked: true, error: "管理者により利用が強制解除されました" }, 403) };
  return { payload, deviceId, visitor };
};
const expiredPage = (message = "このURLの利用期限は終了しました") => new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>利用停止</title><style>body{font-family:sans-serif;background:#edf2f3;margin:0;padding:24px;color:#20313b}.box{max-width:640px;margin:12vh auto;background:#fff;border-radius:14px;padding:28px}</style><div class="box"><h1>${message}</h1><p>管理者に新しい利用者URLの発行を依頼してください。</p></div></html>`, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/issue") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      const input = await readBody(request);
      if (!input) return json({ error: "JSON形式が不正です" }, 400);
      const unit = input.unit === "minutes" ? "minutes" : "days";
      const duration = Math.trunc(Number(input.duration ?? input.days));
      const maximum = unit === "minutes" ? 1440 : 365;
      if (!Number.isInteger(duration) || duration < 1 || duration > maximum) return json({ error: unit === "minutes" ? "分数は1～1440分で指定してください" : "日数は1～365日で指定してください" }, 400);
      await ensureSchema(env);
      const issuedAt = Date.now();
      const expiresAt = issuedAt + duration * (unit === "minutes" ? 60000 : 86400000);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO issued_urls (id, issued_at, expires_at) VALUES (?, ?, ?)").bind(id, issuedAt, expiresAt).run();
      const body = textToUrl(JSON.stringify({ iat: issuedAt, exp: expiresAt, id }));
      const token = `${body}.${await sign(body, env.SIGNING_SECRET)}`;
      return json({ url: `${url.origin}/access?t=${token}&v=14.9-${issuedAt}`, issuedAt, expiresAt });
    }
    if (url.pathname === "/api/visitor") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const input = await readBody(request);
      if (!input) return json({ error: "入力が不正です" }, 400);
      const payload = await validateToken(input.token, env.SIGNING_SECRET);
      if (!payload) return json({ error: "利用期限が終了しています" }, 403);
      const deviceId = clean(input.deviceId, 80);
      if (!deviceId) return json({ error: "端末情報がありません" }, 400);
      const existing = await env.DB.prepare("SELECT company, person, revoked FROM visitors WHERE url_id=? AND device_id=?").bind(payload.id, deviceId).first();
      const now = Date.now();
      const currentDevice = deviceType(request.headers.get("user-agent") || "");
      if (existing) {
        if (existing.revoked) return json({ revoked: true, error: "管理者により利用が強制解除されました" }, 403);
        ctx.waitUntil(env.DB.prepare("UPDATE visitors SET last_access=?, access_count=access_count+1, device_type=? WHERE url_id=? AND device_id=?").bind(now, currentDevice, payload.id, deviceId).run());
        return json({ registered: true, company: existing.company, person: existing.person });
      }
      const company = clean(input.company, 100);
      const person = clean(input.person, 60);
      if (!company || !person) return json({ registered: false });
      await env.DB.prepare("INSERT INTO visitors (url_id, device_id, company, person, device_type, first_access, last_access, access_count, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)").bind(payload.id, deviceId, company, person, currentDevice, now, now).run();
      return json({ registered: true, company, person });
    }
    if (url.pathname === "/api/session") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const input = await readBody(request);
      if (!input) return json({ error: "入力が不正です" }, 400);
      const session = await requireSession(input, env);
      if (session.response) return session.response;
      ctx.waitUntil(env.DB.prepare("UPDATE visitors SET last_access=?, device_type=? WHERE url_id=? AND device_id=?").bind(Date.now(), deviceType(request.headers.get("user-agent") || ""), session.payload.id, session.deviceId).run());
      return json({ active: true, expiresAt: session.payload.exp });
    }
    if (url.pathname === "/api/visitors") {
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      await ensureSchema(env);
      const { results } = await env.DB.prepare("SELECT v.url_id,v.device_id,v.company,v.person,v.device_type,v.first_access,v.last_access,v.access_count,v.revoked,u.expires_at FROM visitors v JOIN issued_urls u ON u.id=v.url_id ORDER BY v.last_access DESC LIMIT 200").all();
      return json({ visitors: results });
    }
    if (url.pathname === "/api/visitor/revoke") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      const input = await readBody(request);
      const urlId = clean(input?.urlId, 80);
      const deviceId = clean(input?.deviceId, 80);
      if (!urlId || !deviceId) return json({ error: "対象利用者が不正です" }, 400);
      await ensureSchema(env);
      const result = await env.DB.prepare("UPDATE visitors SET revoked=? WHERE url_id=? AND device_id=?").bind(input.revoked ? 1 : 0, urlId, deviceId).run();
      if (!result.meta.changes) return json({ error: "対象利用者が見つかりません" }, 404);
      return json({ success: true, revoked: Boolean(input.revoked) });
    }
    if (url.pathname === "/access") {
      const token = url.searchParams.get("t");
      const payload = await validateToken(token, env.SIGNING_SECRET);
      if (!payload) return expiredPage();
      const asset = await env.ASSETS.fetch(new URL("/index.html", url));
      const html = await asset.text();
      const marker = `<script>window.__LIMITED_ACCESS__=${JSON.stringify({ expiresAt: payload.exp, token })};</script>`;
      return new Response(html.replace("<head>", `<head>${marker}`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const asset = await env.ASSETS.fetch(new URL("/index.html", url));
      const headers = new Headers(asset.headers);
      headers.set("cache-control", "no-store, no-cache, must-revalidate");
      headers.set("pragma", "no-cache");
      headers.set("expires", "0");
      return new Response(asset.body, { status: asset.status, headers });
    }
    return env.ASSETS.fetch(request);
  }
};
