import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const origin = "http://127.0.0.1:8787";
const stagingOrigin = "https://ijikannri-access-staging.mic0914.workers.dev";
const adminKey = "smoke-test-admin";
const signingSecret = "smoke-test-signing-secret";
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

const worker = {
  name: "ijikannri-security-smoke",
  modules: true,
  scriptPath: new URL("../src/index.js", import.meta.url).pathname,
  compatibilityDate: "2026-08-13",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    WORKER_ENV: "staging",
    PUBLIC_ORIGIN: stagingOrigin,
    ADMIN_KEY: adminKey,
    SIGNING_SECRET: signingSecret
  },
  d1Databases: { DB: "ijikannri-security-smoke" },
  serviceBindings: {
    ASSETS: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
  }
};

const miniflare = new Miniflare(convertV4MiniflareOptions({
  host: "127.0.0.1",
  port: 8792,
  workers: [worker]
}));

const request = (path, init) => miniflare.dispatchFetch(`${origin}${path}`, init);
const postJson = (path, body, headers = {}) => request(path, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body)
});

try {
  let response = await request("/");
  assert.equal(response.status, 403);
  assert.match(await response.text(), /直接起動することはできません/);

  response = await request("/index.html");
  assert.equal(response.status, 403);

  response = await request("/access");
  assert.equal(response.status, 403);

  response = await request("/admin");
  assert.equal(response.status, 401);
  assert.match(await response.text(), /管理者認証/);

  response = await postJson("/api/admin/login", { key: "wrong" });
  assert.equal(response.status, 401);

  response = await postJson("/api/admin/login", { key: adminKey });
  assert.equal(response.status, 200);
  const adminCookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(adminCookie?.startsWith("ijikannri_admin="));

  response = await request("/admin", { headers: { cookie: adminCookie } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Ver\.16\.7/);

  response = await postJson("/api/issue", { duration: 5, unit: "minutes" });
  assert.equal(response.status, 401);

  response = await postJson("/api/issue", { duration: 5, unit: "minutes" }, { authorization: `Bearer ${adminKey}` });
  assert.equal(response.status, 200);
  const issued = await response.json();
  assert.ok(issued.url.startsWith(`${stagingOrigin}/access?t=`));
  assert.ok(!issued.url.includes("https://ijikannri-access.mic0914.workers.dev"));
  const token = new URL(issued.url).searchParams.get("t");
  assert.ok(token);

  response = await request(`/access?t=${encodeURIComponent(token)}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /window\.__LIMITED_ACCESS__/);

  const deviceId = "smoke-test-device";
  response = await postJson("/api/visitor", { token, deviceId });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: false });

  response = await postJson("/api/visitor", { token, deviceId, company: "検証会社", person: "検証利用者" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).registered, true);

  response = await postJson("/api/session", { token, deviceId });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).active, true);

  const adminHeaders = { authorization: `Bearer ${adminKey}` };
  response = await request("/api/visitors", { headers: adminHeaders });
  let visitors = await response.json();
  assert.equal(response.status, 200);
  assert.equal(visitors.visitors.length, 1);
  assert.equal(visitors.visitors[0].online, 1);
  assert.equal(visitors.visitors[0].revoked, 0);

  response = await postJson("/api/visitor/revoke", { urlId: visitors.visitors[0].url_id, deviceId, revoked: true }, adminHeaders);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revoked, true);

  response = await postJson("/api/session", { token, deviceId });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).revoked, true);

  response = await postJson("/api/visitor", { token, deviceId, company: "再登録会社", person: "再登録利用者" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).revoked, true);

  const database = await miniflare.getD1Database("DB", worker.name);
  await database.prepare("UPDATE visitors SET last_access=0 WHERE device_id=?").bind(deviceId).run();

  response = await request("/api/visitors", { headers: adminHeaders });
  visitors = await response.json();
  assert.equal(response.status, 200);
  assert.equal(visitors.visitors.length, 1);
  assert.equal(visitors.visitors[0].online, 0);
  assert.equal(visitors.visitors[0].revoked, 1);

  response = await request("/api/visitors", { headers: adminHeaders });
  visitors = await response.json();
  assert.equal(visitors.visitors.length, 1);
  assert.equal(visitors.visitors[0].revoked, 1);

  await database.prepare("DELETE FROM visitors WHERE device_id=?").bind(deviceId).run();
  const persisted = await database.prepare("SELECT COUNT(*) AS count FROM visitor_revocations WHERE device_id=?").bind(deviceId).first();
  assert.equal(persisted.count, 1);

  response = await postJson("/api/visitor", { token, deviceId, company: "再登録会社", person: "再登録利用者" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).revoked, true);

  console.log("security smoke tests: passed");
} finally {
  await miniflare.dispose();
}
