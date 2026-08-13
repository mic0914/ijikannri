const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const bytesToUrl = (bytes) => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const textToUrl = (text) => bytesToUrl(new TextEncoder().encode(text));

const urlToText = (value) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
};

const sign = async (payload, secret) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToUrl(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
};

const safeEqual = (a, b) => {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
};

const validateToken = async (token, secret) => {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature || !safeEqual(await sign(body, secret), signature)) return null;
  let payload;
  try { payload = JSON.parse(urlToText(body)); } catch { return null; }
  return Number.isFinite(payload.exp) && Date.now() <= payload.exp ? payload : null;
};

const expiredPage = () => new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>利用期限切れ</title><style>body{font-family:sans-serif;background:#edf2f3;margin:0;padding:24px;color:#20313b}.box{max-width:640px;margin:12vh auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 5px 18px #1939471c}h1{font-size:22px}</style><div class=box><h1>このURLの利用期限は終了しました</h1><p>管理者に新しい利用者URLの発行を依頼してください。</p></div>", { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/issue") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const auth = request.headers.get("authorization") || "";
      if (!env.ADMIN_KEY || !safeEqual(auth, `Bearer ${env.ADMIN_KEY}`)) return json({ error: "Unauthorized" }, 401);
      let input;
      try { input = await request.json(); } catch { return json({ error: "JSON形式が不正です" }, 400); }
      const days = Math.trunc(Number(input.days));
      if (!Number.isInteger(days) || days < 1 || days > 365) return json({ error: "日数は1～365日で指定してください" }, 400);
      const issuedAt = Date.now(), expiresAt = issuedAt + days * 86400000;
      const body = textToUrl(JSON.stringify({ iat: issuedAt, exp: expiresAt, id: crypto.randomUUID() }));
      const token = `${body}.${await sign(body, env.SIGNING_SECRET)}`;
      return json({ url: `${url.origin}/access?t=${token}`, issuedAt, expiresAt });
    }
    if (url.pathname === "/access") {
      const payload = await validateToken(url.searchParams.get("t"), env.SIGNING_SECRET);
      if (!payload) return expiredPage();
      const asset = await env.ASSETS.fetch(new URL("/index.html", url));
      const html = await asset.text();
      const marker = `<script>window.__LIMITED_ACCESS__=${JSON.stringify({ expiresAt: payload.exp })};</script>`;
      const limitedHtml = html.includes("<head>") ? html.replace("<head>", `<head>${marker}`) : html.replace("<script>", `${marker}<script>`);
      return new Response(limitedHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
    }
    return env.ASSETS.fetch(request);
  },
};
