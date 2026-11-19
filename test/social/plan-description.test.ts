import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../../src/db.js";
import { api, withApp, testEmail } from "../http.js";

async function circle(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  const join = (name: string) =>
    api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name, code: created.circle.inviteCode }, status: 201 });
  const bea = await join("Bea");
  const sam = await join("Sam");
  await api(port, "POST", `/api/circles/members/${bea.user.id}`, { token: alex.token, body: { admin: true }, status: 200 });
  for (const person of [alex, bea, sam]) {
    await api(port, "POST", "/api/push/subscribe", {
      token: person.token,
      body: { endpoint: `https://push.example/${person.user.id}`, keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
  }
  return { alex, bea, sam };
}

function notificationCount(db: import("node:sqlite").DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n);
}

test("the description column is added once and reopening is safe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-desc-"));
  const file = path.join(dir, "app.db");
  try {
    openDb(file).close();
    const db = openDb(file);
    const columns = (db.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string; type: string; notnull: number }>)
      .filter((column) => column.name === "description");
    assert.equal(columns.length, 1);
    assert.equal(columns[0].type, "TEXT");
    assert.equal(columns[0].notnull, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create keeps a cleaned description, cuts it at 280, and works without one", async () => {
  await withApp(async ({ port, db }) => {
    const { alex } = await circle(port);
    const create = (body: Record<string, unknown>, status = 201) =>
      api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", ...body }, status });
    const none = await create({});
    assert.equal(none.plan.description, "");
    const row = (id: string) => db.prepare("SELECT description FROM plans WHERE id = ?").get(id) as { description: string | null };
    assert.equal(row(none.plan.id).description, null);

    const made = await create({ description: "  Bring snacks.\nLink: https://example.com/menu\u0007  " });
    assert.equal(made.plan.description, "Bring snacks. Link: https://example.com/menu");
    assert.equal(row(made.plan.id).description, "Bring snacks. Link: https://example.com/menu");

    assert.equal((await create({ description: "x".repeat(281) })).plan.description, "x".repeat(280));
    assert.equal((await create({ description: "   " })).plan.description, "");
    assert.equal((await create({ description: 42 }, 400)).error, "description must be a string");

    const listed = await api(port, "GET", "/api/plans", { token: alex.token, status: 200 });
    assert.ok(listed.plans.some((plan: { id: string; description: string }) =>
      plan.id === made.plan.id && plan.description === "Bring snacks. Link: https://example.com/menu"));
  });
});

test("PATCH sets, cleans, cuts at 280, and clears the description", async () => {
  await withApp(async ({ port, db }) => {
    const { alex } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const patch = (body: Record<string, unknown>, status = 200) =>
      api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body, status });

    const set = await patch({ description: "  Bring snacks.\nLink: https://example.com/menu\u0007  " });
    assert.equal(set.plan.description, "Bring snacks. Link: https://example.com/menu");
    assert.equal(set.plan.note, "Dinner");

    const kept = await patch({ note: "Dinner at mine" });
    assert.equal(kept.plan.description, "Bring snacks. Link: https://example.com/menu");

    const long = await patch({ description: "x".repeat(281) });
    assert.equal(long.plan.description, "x".repeat(280));
    const exact = await patch({ description: "y".repeat(280) });
    assert.equal(exact.plan.description.length, 280);

    assert.equal((await patch({ description: 42 }, 400)).error, "description must be a string");

    const cleared = await patch({ description: "" });
    assert.equal(cleared.plan.description, "");
    const row = db.prepare("SELECT description FROM plans WHERE id = ?").get(made.plan.id) as { description: string | null };
    assert.equal(row.description, null);

    await patch({ description: "Again" });
    assert.equal((await patch({ description: null })).plan.description, "");
    await patch({ description: "Spaces" });
    assert.equal((await patch({ description: "   " })).plan.description, "");
  });
});

test("changing only the description sends no push", async () => {
  await withApp(async ({ port, db, sent }) => {
    const { alex, bea, sam } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", place: "Cafe" }, status: 201 });
    await api(port, "POST", `/api/plans/${made.plan.id}/reply`, { token: sam.token, body: { reply: "in" }, status: 200 });
    sent.length = 0;
    const before = notificationCount(db);

    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { description: "Bring snacks" }, status: 200 });
    // An admin's description-only edit stays quiet too.
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: bea.token, body: { description: "Bring more snacks" }, status: 200 });
    // Same note and place sent back with a new description still counts as description only.
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, {
      token: alex.token,
      body: { note: "Dinner", place: "Cafe", description: "" },
      status: 200,
    });
    const quiet = [...sent];
    assert.equal(quiet.length, 0, JSON.stringify(quiet));
    assert.equal(notificationCount(db), before);

    await api(port, "PATCH", `/api/plans/${made.plan.id}`, {
      token: alex.token,
      body: { note: "Dinner at 8", description: "New text" },
      status: 200,
    });
    assert.equal(sent.length, 0, "a note change is quiet too");

    await api(port, "PATCH", `/api/plans/${made.plan.id}`, {
      token: alex.token,
      body: { place: "Bar", description: "Newer text" },
      status: 200,
    });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].title, "Dinner at 8 moved to Bar");
    assert.equal(sent[0].body, "Tap to see the plan.");
  });
});

test("host and admin can edit the description, a member cannot", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, sam } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const url = `/api/plans/${made.plan.id}`;
    assert.equal((await api(port, "PATCH", url, { token: alex.token, body: { description: "Host" }, status: 200 })).plan.description, "Host");
    assert.equal((await api(port, "PATCH", url, { token: bea.token, body: { description: "Admin" }, status: 200 })).plan.description, "Admin");
    const denied = await api(port, "PATCH", url, { token: sam.token, body: { description: "Member" }, status: 403 });
    assert.equal(denied.error, "Only the host can do that.");
    const listed = await api(port, "GET", "/api/plans", { token: sam.token, status: 200 });
    assert.equal(listed.plans[0].description, "Admin");
  });
});
