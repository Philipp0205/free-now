import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../../src/db.js";
import { gradientClass } from "../../public/js/card-grad.js";
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

test("the card_color column is added once, nullable, and reopening is safe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-color-"));
  try {
    const file = path.join(dir, "app.db");
    openDb(file).close();
    const db = openDb(file);
    const columns = (db.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string; type: string; notnull: number }>)
      .filter((column) => column.name === "card_color");
    assert.equal(columns.length, 1);
    assert.equal(columns[0].type, "INTEGER");
    assert.equal(columns[0].notnull, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a default create has a null cardColor, so the card keeps the id hash", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, sam } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    assert.equal(made.plan.cardColor, null);
    assert.equal((db.prepare("SELECT card_color FROM plans WHERE id = ?").get(made.plan.id) as { card_color: number | null }).card_color, null);
    const seen = (await api(port, "GET", "/api/plans", { token: sam.token, status: 200 })).plans[0];
    assert.equal(seen.cardColor, null);
    assert.match(gradientClass(seen.id), /^grad-\d+$/);
    // Sending null on create is the same as leaving it out.
    const nulled = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Lunch", cardColor: null }, status: 201 });
    assert.equal(nulled.plan.cardColor, null);
  });
});

test("create with a cardColor stores it and a second member sees it", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, sam } = await circle(port);
    for (const slot of [0, 7, 13]) {
      const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: `Slot ${slot}`, cardColor: slot }, status: 201 });
      assert.equal(made.plan.cardColor, slot);
      assert.equal((db.prepare("SELECT card_color FROM plans WHERE id = ?").get(made.plan.id) as { card_color: number }).card_color, slot);
      const listed = (await api(port, "GET", "/api/plans", { token: sam.token, status: 200 })).plans;
      assert.equal(listed.find((plan: { id: string }) => plan.id === made.plan.id).cardColor, slot);
    }
  });
});

test("PATCH sets, changes and clears the cardColor; other fields keep it", async () => {
  await withApp(async ({ port }) => {
    const { alex, sam } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const patch = (body: Record<string, unknown>, status = 200) =>
      api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body, status });
    const second = async () => (await api(port, "GET", "/api/plans", { token: sam.token, status: 200 })).plans[0].cardColor;

    assert.equal((await patch({ cardColor: 4 })).plan.cardColor, 4);
    assert.equal(await second(), 4);
    assert.equal((await patch({ cardColor: 0 })).plan.cardColor, 0, "slot 0 is a real pick, not empty");
    assert.equal((await patch({ note: "Dinner at 8" })).plan.cardColor, 0, "an edit without cardColor keeps it");
    assert.equal((await patch({ cardColor: null })).plan.cardColor, null);
    assert.equal(await second(), null, "cleared for everyone, back to the id hash");
  });
});

test("an out of range or wrong typed cardColor is a 400 and nothing else in that edit is saved", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", cardColor: 3 }, status: 201 });
    for (const bad of [-1, 14, 100, 1.5, "3", true, [], {}]) {
      await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Bad", cardColor: bad }, status: 400 });
      await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { note: "Changed", cardColor: bad }, status: 400 });
    }
    const after = (await api(port, "GET", "/api/plans", { token: alex.token, status: 200 })).plans.find((plan: { id: string }) => plan.id === made.plan.id);
    assert.equal(after.cardColor, 3);
    assert.equal(after.note, "Dinner");
  });
});

test("the host and a circle admin can change the color, a member cannot", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, sam } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", cardColor: 2 }, status: 201 });
    const url = `/api/plans/${made.plan.id}`;
    const denied = await api(port, "PATCH", url, { token: sam.token, body: { cardColor: 9 }, status: 403 });
    assert.equal(denied.error, "Only the host can do that.");
    await api(port, "PATCH", url, { token: sam.token, body: { cardColor: null }, status: 403 });
    assert.equal((await api(port, "GET", "/api/plans", { token: sam.token, status: 200 })).plans[0].cardColor, 2);
    assert.equal((await api(port, "PATCH", url, { token: bea.token, body: { cardColor: 9 }, status: 200 })).plan.cardColor, 9);
    assert.equal((await api(port, "PATCH", url, { token: alex.token, body: { cardColor: 5 }, status: 200 })).plan.cardColor, 5);
  });
});

test("a color change is quiet: no push, no alert, and the calendar copy is not touched", async () => {
  await withApp(async ({ port, db, sent }) => {
    const { alex, sam } = await circle(port);
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", place: "Cafe", time: "19:00", date: soon }, status: 201 });
    await api(port, "POST", `/api/plans/${made.plan.id}/reply`, { token: sam.token, body: { reply: "in" }, status: 200 });
    sent.length = 0;
    const alerts = () => Number((db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n);
    const before = alerts();
    const updated = () => (db.prepare("SELECT updated_at FROM plans WHERE id = ?").get(made.plan.id) as { updated_at: number | null }).updated_at;
    const stamp = updated();

    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { cardColor: 6 }, status: 200 });
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { cardColor: null }, status: 200 });
    assert.equal(sent.length, 0, JSON.stringify(sent));
    assert.equal(alerts(), before);
    assert.equal(updated(), stamp, "updated_at (the calendar SEQUENCE source) is unchanged");
  });
});
