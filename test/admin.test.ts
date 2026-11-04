import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");

async function withApp(fn: (ctx: { port: number; sent: Array<PushPayload & { endpoint: string }>; at: (ms: number) => void }) => Promise<void>) {
  const sent: Array<PushPayload & { endpoint: string }> = [];
  let now = START;
  const db = openDb(":memory:");
  const push: PushSender = { async send(sub, payload) { sent.push({ ...payload, endpoint: sub.endpoint }); } };
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: ":memory:" });
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ port, sent, at(ms) { now = ms; } });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function api(port: number, method: string, pathname: string, options: { token?: string; body?: unknown; status?: number } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (options.status !== undefined && response.status !== options.status) {
    throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  }
  return json;
}

test("the creator is admin and a new member is not", async () => {
  await withApp(async ({ port }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    assert.equal(created.circle.youAreAdmin, true);
    assert.equal(created.circle.members[0].admin, true);
    const fritz = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
      status: 201,
    });
    assert.equal(fritz.circle.youAreAdmin, false);
    assert.equal(fritz.circle.members.find((member: { name: string; admin: boolean }) => member.name === "Fritz").admin, false);
  });
});

test("only an admin can remove a member, and that ends their posts", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    at(START + 1000);
    const fritz = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
      status: 201,
    });
    const social = await api(port, "POST", "/api/socials", { token: fritz.token, body: { note: "Coffee" }, status: 201 });
    await api(port, "POST", "/api/plans", { token: fritz.token, body: { note: "Bouldering" }, status: 201 });
    const fritzId = fritz.user.id as string;
    await api(port, "DELETE", `/api/circles/members/${fritzId}`, { token: fritz.token, status: 403 });
    await api(port, "DELETE", `/api/circles/members/${fritzId}`, { token: alex.token, status: 204 });
    const after = await api(port, "GET", "/api/me", { token: fritz.token });
    assert.equal(after.circle, null);
    const socials = await api(port, "GET", "/api/socials", { token: alex.token });
    assert.equal(socials.socials.length, 0);
    const plans = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(plans.plans.length, 0);
    assert.ok(social.social.id);
  });
});

test("a circle keeps an admin, and leaving promotes the longest-standing member", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const alexId = (await api(port, "GET", "/api/me", { token: alex.token })).user.id as string;
    at(START + 1000);
    const fritz = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
      status: 201,
    });
    at(START + 2000);
    await api(port, "POST", "/api/auth/start", {
      body: { name: "Sam", code: created.circle.inviteCode },
      status: 201,
    });
    const demote = await api(port, "POST", `/api/circles/members/${alexId}`, {
      token: alex.token,
      body: { admin: false },
      status: 409,
    });
    assert.equal(demote.error, "A circle needs an admin.");
    await api(port, "DELETE", `/api/circles/members/${alexId}`, { token: alex.token, status: 409 });
    await api(port, "POST", "/api/circles/leave", { token: alex.token, status: 200 });
    const host = await api(port, "GET", "/api/me", { token: fritz.token });
    assert.equal(host.circle.youAreAdmin, true);
    assert.equal(host.circle.members.find((member: { name: string }) => member.name === "Sam").admin, false);
  });
});

test("an admin can edit or end someone else's free post and plan", async () => {
  await withApp(async ({ port, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const fritz = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
      status: 201,
    });
    await api(port, "POST", "/api/push/subscribe", {
      token: fritz.token,
      body: { endpoint: "https://push.example/fritz", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const sam = await api(port, "POST", "/api/auth/start", {
      body: { name: "Sam", code: created.circle.inviteCode },
      status: 201,
    });
    const social = await api(port, "POST", "/api/socials", { token: fritz.token, body: { note: "Coffee" }, status: 201 });
    const plan = await api(port, "POST", "/api/plans", { token: fritz.token, body: { note: "Bouldering" }, status: 201 });
    await api(port, "PATCH", `/api/socials/${social.social.id}`, {
      token: sam.token,
      body: { note: "Nope" },
      status: 403,
    });
    const edited = await api(port, "PATCH", `/api/plans/${plan.plan.id}`, {
      token: alex.token,
      body: { note: "Climbing", place: "Gym" },
      status: 200,
    });
    assert.equal(edited.plan.note, "Climbing");
    assert.equal(edited.plan.place, "Gym");
    await api(port, "DELETE", `/api/socials/${social.social.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.at(-1)?.title, "Ended");
    assert.equal(sent.at(-1)?.body, "Alex ended Coffee");
    const socials = await api(port, "GET", "/api/socials", { token: alex.token });
    assert.equal(socials.socials.length, 0);
  });
});

test("host and admin can change every event, and a member cannot", async () => {
  await withApp(async ({ port, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const bea = await api(port, "POST", "/api/auth/start", {
      body: { name: "Bea", code: created.circle.inviteCode },
      status: 201,
    });
    const sam = await api(port, "POST", "/api/auth/start", {
      body: { name: "Sam", code: created.circle.inviteCode },
      status: 201,
    });
    const nia = await api(port, "POST", "/api/auth/start", {
      body: { name: "Nia", code: created.circle.inviteCode },
      status: 201,
    });
    await api(port, "POST", `/api/circles/members/${bea.user.id}`, {
      token: alex.token,
      body: { admin: true },
      status: 200,
    });
    await api(port, "POST", "/api/push/subscribe", {
      token: nia.token,
      body: { endpoint: "https://push.example/nia", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    await api(port, "POST", "/api/push/subscribe", {
      token: bea.token,
      body: { endpoint: "https://push.example/bea", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const social = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Coffee", place: "Cafe" },
      status: 201,
    });
    const plan = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Bouldering", place: "Gym" },
      status: 201,
    });
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: nia.token,
      body: { reply: "in" },
      status: 200,
    });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: nia.token,
      body: { reply: "in" },
      status: 200,
    });

    async function denied(method: string, pathname: string, body?: unknown) {
      const result = await api(port, method, pathname, { token: sam.token, body, status: 403 });
      assert.equal(result.error, "Only the host can do that.");
    }

    const socialEdit = { note: "Tea", place: "Park", startsAt: "18:00" };
    await denied("PATCH", `/api/socials/${social.social.id}`, socialEdit);
    const byHost = await api(port, "PATCH", `/api/socials/${social.social.id}`, { token: alex.token, body: socialEdit, status: 200 });
    assert.equal(byHost.social.note, "Tea");
    assert.equal(byHost.social.place, "Park");
    assert.ok(byHost.social.startsAt > START);
    const byAdmin = await api(port, "PATCH", `/api/socials/${social.social.id}`, {
      token: bea.token,
      body: { note: "Cocoa", place: "Bar", startsAt: null },
      status: 200,
    });
    assert.equal(byAdmin.social.note, "Cocoa");
    assert.equal(byAdmin.social.place, "Bar");
    assert.equal(byAdmin.social.startsAt, null);

    const later = await api(port, "POST", "/api/socials", {
      token: bea.token,
      body: { note: "Walk", place: "Park", startsAt: "18:30" },
      status: 201,
    });
    await denied("PATCH", `/api/socials/${later.social.id}`, { note: "Nope", place: "Nope", startsAt: "19:00" });
    const laterHost = await api(port, "PATCH", `/api/socials/${later.social.id}`, {
      token: bea.token,
      body: { note: "Stroll", place: "River", startsAt: "19:00" },
      status: 200,
    });
    assert.equal(laterHost.social.note, "Stroll");
    assert.equal(laterHost.social.place, "River");
    assert.ok(laterHost.social.startsAt > byHost.social.startsAt);
    const laterAdmin = await api(port, "PATCH", `/api/socials/${later.social.id}`, {
      token: alex.token,
      body: { note: "Dusk walk", place: "Bridge", startsAt: "19:30" },
      status: 200,
    });
    assert.equal(laterAdmin.social.note, "Dusk walk");
    assert.equal(laterAdmin.social.place, "Bridge");
    assert.ok(laterAdmin.social.startsAt > laterHost.social.startsAt);

    const planEdit = { note: "Climbing", place: "Wall", time: "19:40" };
    await denied("PATCH", `/api/plans/${plan.plan.id}`, planEdit);
    const planHost = await api(port, "PATCH", `/api/plans/${plan.plan.id}`, { token: alex.token, body: planEdit, status: 200 });
    assert.equal(planHost.plan.note, "Climbing");
    assert.equal(planHost.plan.place, "Wall");
    assert.equal(planHost.plan.time, "19:40");
    const planAdmin = await api(port, "PATCH", `/api/plans/${plan.plan.id}`, {
      token: bea.token,
      body: { note: "Boulder", place: "Cave", time: "20:00" },
      status: 200,
    });
    assert.equal(planAdmin.plan.note, "Boulder");
    assert.equal(planAdmin.plan.place, "Cave");
    assert.equal(planAdmin.plan.time, "20:00");

    await denied("DELETE", `/api/socials/${social.social.id}/people/${nia.user.id}`);
    await api(port, "DELETE", `/api/socials/${social.social.id}/people/${nia.user.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.at(-1)?.body, "Alex removed you from Cocoa");
    const stillIn = await api(port, "GET", "/api/me", { token: nia.token });
    assert.equal(stillIn.circle.name, "friends");
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: nia.token,
      body: { reply: "in" },
      status: 403,
    });
    await api(port, "POST", `/api/socials/${later.social.id}/reply`, {
      token: nia.token,
      body: { reply: "in" },
      status: 200,
    });
    await denied("DELETE", `/api/socials/${later.social.id}/people/${nia.user.id}`);
    await api(port, "DELETE", `/api/socials/${later.social.id}/people/${nia.user.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.at(-1)?.body, "Alex removed you from Dusk walk");

    await denied("DELETE", `/api/plans/${plan.plan.id}/people/${nia.user.id}`);
    await api(port, "DELETE", `/api/plans/${plan.plan.id}/people/${nia.user.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.at(-1)?.body, "Alex removed you from Boulder");
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: nia.token,
      body: { reply: "in" },
      status: 403,
    });
    const dinner = await api(port, "POST", "/api/plans", {
      token: bea.token,
      body: { note: "Dinner", place: "Kitchen" },
      status: 201,
    });
    await denied("PATCH", `/api/plans/${dinner.plan.id}`, { note: "Nope", place: "Nope", time: "21:00" });
    const dinnerHost = await api(port, "PATCH", `/api/plans/${dinner.plan.id}`, {
      token: bea.token,
      body: { note: "Dinner", place: "Kitchen", time: "18:00" },
      status: 200,
    });
    assert.equal(dinnerHost.plan.time, "18:00");
    const dinnerAdmin = await api(port, "PATCH", `/api/plans/${dinner.plan.id}`, {
      token: alex.token,
      body: { note: "Supper", place: "Table", time: "18:30" },
      status: 200,
    });
    assert.equal(dinnerAdmin.plan.note, "Supper");
    assert.equal(dinnerAdmin.plan.place, "Table");
    assert.equal(dinnerAdmin.plan.time, "18:30");
    await api(port, "POST", `/api/plans/${dinner.plan.id}/reply`, {
      token: nia.token,
      body: { reply: "in" },
      status: 200,
    });
    await denied("DELETE", `/api/plans/${dinner.plan.id}/people/${nia.user.id}`);
    await api(port, "DELETE", `/api/plans/${dinner.plan.id}/people/${nia.user.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.at(-1)?.body, "Alex removed you from Supper");

    await denied("DELETE", `/api/socials/${social.social.id}`);
    await api(port, "DELETE", `/api/socials/${social.social.id}`, { token: alex.token, status: 204 });
    await denied("DELETE", `/api/socials/${later.social.id}`);
    await api(port, "DELETE", `/api/socials/${later.social.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.at(-1)?.title, "Ended");
    assert.equal(sent.at(-1)?.body, "Alex ended Dusk walk");
    await denied("DELETE", `/api/plans/${plan.plan.id}`);
    await api(port, "DELETE", `/api/plans/${plan.plan.id}`, { token: alex.token, status: 204 });
    await denied("DELETE", `/api/plans/${dinner.plan.id}`);
    await api(port, "DELETE", `/api/plans/${dinner.plan.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.at(-1)?.body, "Alex ended Supper");
    const socials = await api(port, "GET", "/api/socials", { token: alex.token });
    const plans = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(socials.socials.length, 0);
    assert.equal(plans.plans.length, 0);
  });
});

test("removal blocks the old invite, ends posts, and names who removed you", async () => {
  await withApp(async ({ port, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const code = created.circle.inviteCode;
    const sam = await api(port, "POST", "/api/auth/start", { body: { name: "Sam", code }, status: 201 });
    const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code }, status: 201 });
    await api(port, "POST", `/api/circles/members/${bea.user.id}`, { token: alex.token, body: { admin: true }, status: 200 });
    await api(port, "POST", "/api/push/subscribe", {
      token: sam.token,
      body: { endpoint: "https://push.example/sam", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const coffee = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    await api(port, "POST", `/api/socials/${coffee.social.id}/reply`, { token: sam.token, body: { reply: "in" }, status: 200 });
    const tea = await api(port, "POST", "/api/socials", { token: sam.token, body: { note: "Tea" }, status: 201 });
    await api(port, "DELETE", `/api/circles/members/${sam.user.id}`, { token: bea.token, status: 204 });
    const afterKick = await api(port, "GET", "/api/socials", { token: alex.token });
    assert.equal(afterKick.socials.some((social: { id: string }) => social.id === tea.social.id), false);
    const coffeeLeft = afterKick.socials.find((social: { id: string }) => social.id === coffee.social.id);
    assert.equal(coffeeLeft.joined.some((person: { id: string }) => person.id === sam.user.id), false);
    const blocked = await api(port, "POST", "/api/circles/join", { token: sam.token, body: { code }, status: 403 });
    assert.equal(blocked.error, "An admin removed you from this circle.");
    await api(port, "DELETE", `/api/circles/removals/${sam.user.id}`, { token: bea.token, status: 204 });
    await api(port, "POST", "/api/circles/join", { token: sam.token, body: { code }, status: 200 });
    await api(port, "DELETE", `/api/circles/members/${sam.user.id}`, { token: alex.token, status: 204 });
    const rotated = await api(port, "POST", "/api/circles/invite", { token: alex.token, status: 200 });
    await api(port, "POST", "/api/circles/join", { token: sam.token, body: { code: rotated.circle.inviteCode }, status: 200 });

    const late = await api(port, "POST", "/api/socials", { token: sam.token, body: { note: "Late" }, status: 201 });
    await api(port, "POST", `/api/socials/${late.social.id}/reply`, { token: alex.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", "/api/circles/leave", { token: sam.token, status: 200 });
    const afterLeave = await api(port, "GET", "/api/socials", { token: alex.token });
    assert.equal(afterLeave.socials.some((social: { note: string }) => social.note === "Late"), false);

    await api(port, "DELETE", `/api/socials/${coffee.social.id}`, { token: alex.token, status: 204 });
    const again = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Again" }, status: 201 });
    await api(port, "POST", "/api/auth/start", { body: { name: "Nia", code: rotated.circle.inviteCode }, status: 201 }).then(async (nia) => {
      await api(port, "POST", "/api/push/subscribe", {
        token: nia.token,
        body: { endpoint: "https://push.example/nia", keys: { p256dh: "p", auth: "a" } },
        status: 204,
      });
      await api(port, "POST", `/api/socials/${again.social.id}/reply`, { token: nia.token, body: { reply: "in" }, status: 200 });
      await api(port, "DELETE", `/api/socials/${again.social.id}/people/${nia.user.id}`, { token: bea.token, status: 204 });
      assert.equal(sent.at(-1)?.body, "Bea removed you from Again");
      const denied = await api(port, "POST", `/api/socials/${again.social.id}/reply`, { token: nia.token, body: { reply: "in" }, status: 403 });
      assert.equal(denied.error, "Bea removed you from this.");
      const seen = await api(port, "GET", "/api/socials", { token: nia.token });
      const row = seen.socials.find((social: { id: string }) => social.id === again.social.id);
      assert.equal(row.joined.some((person: { id: string }) => person.id === nia.user.id), false);
      assert.equal(row.removedBy, "Bea");
      const hostView = await api(port, "GET", "/api/socials", { token: alex.token });
      assert.equal(hostView.socials.find((social: { id: string }) => social.id === again.social.id).removedBy, null);
      const supper = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Supper" }, status: 201 });
      await api(port, "POST", `/api/plans/${supper.plan.id}/reply`, { token: nia.token, body: { reply: "in" }, status: 200 });
      await api(port, "DELETE", `/api/plans/${supper.plan.id}/people/${nia.user.id}`, { token: bea.token, status: 204 });
      const plans = await api(port, "GET", "/api/plans", { token: nia.token });
      assert.equal(plans.plans.find((plan: { id: string }) => plan.id === supper.plan.id).removedBy, "Bea");
    });
  });
});

test("editing a plan tells people who are in, keeps an omitted place, and a past day is gone", async () => {
  await withApp(async ({ port, sent, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const fritz = await api(port, "POST", "/api/auth/start", { body: { name: "Fritz", code: created.circle.inviteCode }, status: 201 });
    const sam = await api(port, "POST", "/api/auth/start", { body: { name: "Sam", code: created.circle.inviteCode }, status: 201 });
    for (const person of [alex, fritz, sam]) {
      await api(port, "POST", "/api/push/subscribe", {
        token: person.token,
        body: { endpoint: `https://push.example/${person.user.id}`, keys: { p256dh: "p", auth: "a" } },
        status: 204,
      });
    }
    const plan = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Bouldering", place: "Gym", lat: 48.1, lng: 11.5 },
      status: 201,
    });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: fritz.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: sam.token, body: { reply: "can't" }, status: 200 });
    sent.length = 0;
    const edited = await api(port, "PATCH", `/api/plans/${plan.plan.id}`, {
      token: alex.token,
      body: { note: "Bouldering at 7" },
      status: 200,
    });
    assert.equal(edited.plan.note, "Bouldering at 7");
    assert.equal(edited.plan.place, "Gym");
    assert.deepEqual(edited.plan.location, plan.plan.location);
    const notePushes = sent.filter((item) => item.title.startsWith("Plan changed"));
    assert.equal(notePushes.length, 1);
    assert.equal(notePushes[0]?.endpoint, `https://push.example/${fritz.user.id}`);
    assert.equal(notePushes[0]?.title, "Plan changed: Bouldering at 7");
    assert.equal(notePushes[0]?.body, "Note is now Bouldering at 7.");
    sent.length = 0;
    const timed = await api(port, "PATCH", `/api/plans/${plan.plan.id}`, {
      token: alex.token,
      body: { time: "19:40" },
      status: 200,
    });
    assert.equal(timed.plan.place, "Gym");
    assert.equal(timed.plan.time, "19:40");
    assert.deepEqual(timed.plan.location, plan.plan.location);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.endpoint, `https://push.example/${fritz.user.id}`);
    assert.equal(sent[0]?.body, "Time is now 19:40.");
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${plan.plan.id}`, {
      token: alex.token,
      body: { time: "19:40" },
      status: 200,
    });
    assert.equal(sent.length, 0);

    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee", place: "Cafe" }, status: 201 });
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: fritz.token, body: { reply: "in" }, status: 200 });
    sent.length = 0;
    const socialEdit = await api(port, "PATCH", `/api/socials/${social.social.id}`, {
      token: alex.token,
      body: { note: "Tea" },
      status: 200,
    });
    assert.equal(socialEdit.social.place, "Cafe");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.endpoint, `https://push.example/${fritz.user.id}`);
    assert.equal(sent[0]?.title, "Updated: Tea");
    assert.equal(sent[0]?.body, "Note is now Tea.");

    at(START + 2 * 24 * 60 * 60 * 1000);
    const gone = await api(port, "PATCH", `/api/plans/${plan.plan.id}`, {
      token: alex.token,
      body: { note: "Too late" },
      status: 410,
    });
    assert.equal(gone.error, "That plan has ended.");
  });
});

test("opening an older database makes the creator the admin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-admin-"));
  const file = path.join(dir, "old.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      buzz_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE circles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE memberships (
      user_id TEXT PRIMARY KEY,
      circle_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL
    );
  `);
  raw.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)").run("u1", "Alex", "h1", "b1", 1);
  raw.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)").run("u2", "Fritz", "h2", "b2", 2);
  raw.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run("c1", "friends", "CODE", "u1", 1);
  raw.prepare("INSERT INTO memberships (user_id, circle_id, joined_at) VALUES (?, ?, ?)").run("u1", "c1", 10);
  raw.prepare("INSERT INTO memberships (user_id, circle_id, joined_at) VALUES (?, ?, ?)").run("u2", "c1", 20);
  raw.close();
  const db = openDb(file);
  try {
    const rows = db.prepare("SELECT user_id, is_admin FROM memberships ORDER BY joined_at").all() as Array<{ user_id: string; is_admin: number }>;
    assert.equal(rows[0].user_id, "u1");
    assert.equal(rows[0].is_admin, 1);
    assert.equal(rows[1].user_id, "u2");
    assert.equal(rows[1].is_admin, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
