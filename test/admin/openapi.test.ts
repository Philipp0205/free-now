import assert from "node:assert/strict";
import test from "node:test";
import { listOperations, openapi } from "../../src/admin/openapi.js";
import { api, withApp, testEmail } from "../http.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { res, text: await res.text() };
}

test("GET /api/openapi.json is public OpenAPI 3.1 with a bearer scheme and the agent paths", async () => {
  await withApp(async (ctx) => {
    const { res, text } = await get(ctx.port, "/api/openapi.json");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const doc = JSON.parse(text);
    assert.ok(doc.openapi.startsWith("3.1"));
    assert.equal(doc.components.securitySchemes.bearer.type, "http");
    assert.equal(doc.components.securitySchemes.bearer.scheme, "bearer");
    const ops = listOperations(doc).map((op) => `${op.method} ${op.path}`);
    for (const want of [
      "GET /api/openapi.json",
      "GET /llms.txt",
      "GET /api/health",
      "GET /api/me",
      "GET /api/me/status",
      "PUT /api/me/status",
      "PATCH /api/me/status",
      "DELETE /api/me/status",
      "GET /api/socials",
      "POST /api/socials",
      "POST /api/socials/{id}/join",
      "POST /api/socials/{id}/leave",
      "POST /api/socials/{id}/reply",
      "GET /api/plans",
      "POST /api/plans",
      "POST /api/plans/{id}/join",
      "POST /api/plans/{id}/leave",
      "POST /api/plans/{id}/reply",
      "GET /api/circles/availability",
      "GET /api/notifications",
    ]) {
      assert.ok(ops.includes(want), `missing ${want}`);
    }
    for (const path of Object.keys(doc.paths)) {
      assert.doesNotMatch(path, /admin|agent-tokens|logout|recover|buzz-token|avatar|calendar-sync|push/);
    }
    assert.equal(text.includes("buzzToken"), false);
    const head = await fetch(`http://127.0.0.1:${ctx.port}/api/openapi.json`, { method: "HEAD" });
    assert.equal(head.status, 200);
  });
});

test("GET /llms.txt is public plain text that points at the real routes", async () => {
  await withApp(async (ctx) => {
    const { res, text } = await get(ctx.port, "/llms.txt");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain; charset=utf-8/);
    for (const word of ["Bearer", "/api/me", "status", "socials", "plans", "join", "https://imhangry.app", "/api/openapi.json"]) {
      assert.ok(text.includes(word), `mentions ${word}`);
    }
    assert.doesNotMatch(text, /hng_[A-Za-z0-9_-]{8,}/);
    assert.doesNotMatch(text, /admin|buzz|recover/i);
    // Every /api/ path in the guide is documented (ID stands for the {id} parameter).
    const documented = new Set(listOperations().map((op) => op.path));
    for (const [path] of text.matchAll(/\/api\/[A-Za-z./]+/g)) {
      const template = path.replace(/[./]+$/, "").replace("/ID", "/{id}");
      assert.ok(documented.has(template), `guide mentions undocumented ${path}`);
    }
  });
});

test("every documented operation is routed", async () => {
  await withApp(async (ctx) => {
    const { json: alex } = await api(ctx, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
    await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });

    // Negative control: with a session, an unmatched path is the generic 404.
    const missing = await api(ctx, "GET", "/api/definitely-not-a-route", { token: alex.token });
    assert.deepEqual([missing.status, missing.json], [404, { error: "not found" }]);

    for (const { method, path } of listOperations(openapi)) {
      const url = path.replace(/\{[^}]+\}/g, UUID);
      const res = await fetch(`http://127.0.0.1:${ctx.port}${url}`, {
        method,
        headers: { authorization: `Bearer ${alex.token}`, "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      const text = await res.text();
      const label = `${method} ${path} -> ${res.status} ${text.slice(0, 80)}`;
      if (path.includes("{")) {
        // A valid UUID that names nothing gets a specific message, never the generic one.
        assert.equal(res.status, 404, label);
        assert.match(JSON.parse(text).error, /^(plan|social) not found$/, label);
      } else {
        assert.notEqual(res.status, 404, label);
        assert.ok(res.status < 500, label);
      }
    }
  });
});
