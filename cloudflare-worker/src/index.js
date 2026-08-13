
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const bytesToUrl = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const textToUrl = (text) => bytesToUrl(new TextEncoder().encode(text));
const urlToText = (value) => { const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4); return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))); };
const sign = async (payload, secret) => { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return bytesToUrl(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))); };
const safeEqual = (a, b) => { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b); if (x.length !== y.length) return false; let diff = 0; for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i]; return diff === 0; };
const validateToken = async (token, secret) => { const [body, signature] = String(token || "").split("."); if (!body || !signature || !safeEqual(await sign(body, secret), signature)) return null; try { const payload = JSON.parse(urlToText(body)); return Number.isFinite(payload.exp) && Date.now() <= payload.exp ? payload : null; } catch { return null; } };
const admin = (request, env) => env.ADMIN_KEY && safeEqual(request.headers.get("authorization") || "", `Bearer ${env.ADMIN_KEY}`);
const clean = (value, max) => String(value || "").trim().slice(0, max);
const device = (ua) => /iPhone/i.test(ua) ? "iPhone" : /iPad/i.test(ua) ? "iPad" : /Android/i.test(ua) ? "Android" : /Windows/i.test(ua) ? "Windows PC" : /Mac/i.test(ua) ? "Mac" : "その他";
const ensureSchema = async (env) => env.DB.batch([
  env.DB.prepare("CREATE TABLE IF NOT EXISTS issued_urls (id TEXT PRIMARY KEY, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS visitors (url_id TEXT NOT NULL, device_id TEXT NOT NULL, company TEXT NOT NULL, person TEXT NOT NULL, device_type TEXT NOT NULL, first_access INTEGER NOT NULL, last_access INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (url_id, device_id))"),
  env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_visitors_last_access ON visitors(last_access DESC)")
]);
const expiredPage = () => new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>利用期限切れ</title><style>body{font-family:sans-serif;background:#edf2f3;margin:0;padding:24px;color:#20313b}.box{max-width:640px;margin:12vh auto;background:#fff;border-radius:14px;padding:28px}</style><div class=box><h1>このURLの利用期限は終了しました</h1><p>管理者に新しい利用者URLの発行を依頼してください。</p></div>", { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/issue") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!admin(request, env)) return json({ error: "Unauthorized" }, 401);
    let input; try { input = await request.json(); } catch { return json({ error: "JSON形式が不正です" }, 400); }
    const days = Math.trunc(Number(input.days)); if (!Number.isInteger(days) || days < 1 || days > 365) return json({ error: "日数は1～365日で指定してください" }, 400); await ensureSchema(env);
    const issuedAt = Date.now(), expiresAt = issuedAt + days * 86400000, id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO issued_urls (id, issued_at, expires_at) VALUES (?, ?, ?)").bind(id, issuedAt, expiresAt).run();
    const body = textToUrl(JSON.stringify({ iat: issuedAt, exp: expiresAt, id })); const token = `${body}.${await sign(body, env.SIGNING_SECRET)}`;
    return json({ url: `${url.origin}/access?t=${token}`, issuedAt, expiresAt });
  }
  if (url.pathname === "/api/visitor") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let input; try { input = await request.json(); } catch { return json({ error: "入力が不正です" }, 400); } await ensureSchema(env);
    const payload = await validateToken(input.token, env.SIGNING_SECRET); if (!payload) return json({ error: "利用期限が終了しています" }, 403);
    const deviceId = clean(input.deviceId, 80); if (!deviceId) return json({ error: "端末情報がありません" }, 400);
    const existing = await env.DB.prepare("SELECT company, person FROM visitors WHERE url_id=? AND device_id=?").bind(payload.id, deviceId).first();
    const now = Date.now(), deviceType = device(request.headers.get("user-agent") || "");
    if (existing) { await env.DB.prepare("UPDATE visitors SET last_access=?, access_count=access_count+1, device_type=? WHERE url_id=? AND device_id=?").bind(now, deviceType, payload.id, deviceId).run(); return json({ registered: true, company: existing.company, person: existing.person }); }
    const company = clean(input.company, 100), person = clean(input.person, 60); if (!company || !person) return json({ registered: false });
    await env.DB.prepare("INSERT INTO visitors (url_id, device_id, company, person, device_type, first_access, last_access, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").bind(payload.id, deviceId, company, person, deviceType, now, now).run();
    return json({ registered: true, company, person });
  }
  if (url.pathname === "/api/visitors") {
    if (!admin(request, env)) return json({ error: "Unauthorized" }, 401); await ensureSchema(env);
    const { results } = await env.DB.prepare("SELECT v.company,v.person,v.device_type,v.first_access,v.last_access,v.access_count,u.expires_at FROM visitors v JOIN issued_urls u ON u.id=v.url_id ORDER BY v.last_access DESC LIMIT 200").all();
    return json({ visitors: results });
  }
  if (url.pathname === "/access") {
    const token = url.searchParams.get("t"), payload = await validateToken(token, env.SIGNING_SECRET); if (!payload) return expiredPage();
    const asset = await env.ASSETS.fetch(new URL("/index.html", url)); const html = await asset.text();
    const marker = `<script>window.__LIMITED_ACCESS__=${JSON.stringify({ expiresAt: payload.exp, token })};</script>`;
    return new Response(html.replace("<head>", `<head>${marker}`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  return env.ASSETS.fetch(request);
} };
