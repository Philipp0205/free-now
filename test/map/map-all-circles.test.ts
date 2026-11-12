import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import type { PushSender } from "../../src/push/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");

async function withApp(fn: (ctx: { port: number; db: DatabaseSync }) => Promise<void>) {
  const db = openDb(":memory:");
  const push: PushSender = { async send() {} };
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: ":memory:" });
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => START }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ port, db });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function api(port: number, method: string, pathname: string, options: { token?: string; body?: unknown; status?: number; circle?: string } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.circle ? { "x-circle": options.circle } : {}),
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

type Row = { id: string; note: string; circleId: string; circleName: string };

async function setup(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const uni = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Uni friends" }, status: 201 });
  const home = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Home" }, status: 201 });
  const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea" }, status: 201 });
  const work = await api(port, "POST", "/api/circles", { token: bea.token, body: { name: "Work" }, status: 201 });
  await api(port, "POST", `/api/socials?circle=${uni.circle.id}`, { token: alex.token, body: { note: "Uni soup", lat: 48.77, lng: 9.18 }, status: 201 });
  await api(port, "POST", `/api/socials?circle=${home.circle.id}`, { token: alex.token, body: { note: "Home walk", lat: 48.78, lng: 9.19 }, status: 201 });
  const uniPlan = await api(port, "POST", `/api/plans?circle=${uni.circle.id}`, { token: alex.token, body: { note: "Uni dinner", lat: 48.77, lng: 9.17 }, status: 201 });
  await api(port, "POST", `/api/plans?circle=${home.circle.id}`, { token: alex.token, body: { note: "Home brunch" }, status: 201 });
  await api(port, "POST", `/api/plans?circle=${work.circle.id}`, { token: bea.token, body: { note: "Work lunch" }, status: 201 });
  await api(port, "POST", `/api/socials?circle=${work.circle.id}`, { token: bea.token, body: { note: "Work coffee" }, status: 201 });
  return { alex, bea, uni: uni.circle, home: home.circle, work: work.circle, uniPlan: uniPlan.plan };
}

test("all=1 merges every circle the caller is in, with circleId and circleName", async () => {
  await withApp(async ({ port }) => {
    const { alex, uni, home } = await setup(port);
    const socials = (await api(port, "GET", "/api/socials?all=1", { token: alex.token, status: 200 })).socials as Row[];
    const plans = (await api(port, "GET", "/api/plans?all=1", { token: alex.token, status: 200 })).plans as Row[];
    assert.deepEqual(socials.map((row) => row.note).sort(), ["Home walk", "Uni soup"]);
    assert.deepEqual(plans.map((row) => row.note).sort(), ["Home brunch", "Uni dinner"]);
    const soup = socials.find((row) => row.note === "Uni soup")!;
    assert.equal(soup.circleId, uni.id);
    assert.equal(soup.circleName, "Uni friends");
    const brunch = plans.find((row) => row.note === "Home brunch")!;
    assert.equal(brunch.circleId, home.id);
    assert.equal(brunch.circleName, "Home");
  });
});

test("without all=1 the lists stay scoped to one circle, and a requested circle is ignored with all=1", async () => {
  await withApp(async ({ port }) => {
    const { alex, uni } = await setup(port);
    const scoped = (await api(port, "GET", `/api/socials?circle=${uni.id}`, { token: alex.token, status: 200 })).socials as Row[];
    assert.deepEqual(scoped.map((row) => row.note), ["Uni soup"]);
    assert.equal(scoped[0].circleId, uni.id);
    const scopedPlans = (await api(port, "GET", "/api/plans", { token: alex.token, circle: uni.id, status: 200 })).plans as Row[];
    assert.deepEqual(scopedPlans.map((row) => row.note), ["Uni dinner"]);
    const ignored = (await api(port, "GET", "/api/plans?all=1", { token: alex.token, circle: uni.id, status: 200 })).plans as Row[];
    assert.equal(ignored.length, 2);
  });
});

test("all=1 never shows a circle the caller is not in", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, work } = await setup(port);
    const socials = (await api(port, "GET", "/api/socials?all=1", { token: alex.token })).socials as Row[];
    const plans = (await api(port, "GET", "/api/plans?all=1", { token: alex.token })).plans as Row[];
    assert.equal([...socials, ...plans].some((row) => row.circleId === work.id), false);
    const beaPlans = (await api(port, "GET", "/api/plans?all=1", { token: bea.token })).plans as Row[];
    assert.deepEqual(beaPlans.map((row) => row.note), ["Work lunch"]);
  });
});

test("leaving a circle drops its events from all=1", async () => {
  await withApp(async ({ port }) => {
    const { alex, uni, home } = await setup(port);
    const ana = await api(port, "POST", "/api/auth/start", { body: { name: "Ana", code: uni.inviteCode }, status: 201 });
    await api(port, "POST", "/api/circles/join", { token: ana.token, body: { code: home.inviteCode }, status: 200 });
    const before = (await api(port, "GET", "/api/plans?all=1", { token: ana.token })).plans as Row[];
    assert.deepEqual(before.map((row) => row.note).sort(), ["Home brunch", "Uni dinner"]);
    await api(port, "POST", `/api/circles/leave?circle=${home.id}`, { token: ana.token, status: 200 });
    const plans = (await api(port, "GET", "/api/plans?all=1", { token: ana.token })).plans as Row[];
    const socials = (await api(port, "GET", "/api/socials?all=1", { token: ana.token })).socials as Row[];
    assert.deepEqual(plans.map((row) => row.note), ["Uni dinner"]);
    assert.deepEqual(socials.map((row) => row.note), ["Uni soup"]);
    assert.ok(alex.token);
  });
});

test("a plan shared into two circles shows up once in all=1", async () => {
  await withApp(async ({ port }) => {
    const { alex, uni, home, uniPlan } = await setup(port);
    await api(port, "PATCH", `/api/plans/${uniPlan.id}?circle=${uni.id}`, {
      token: alex.token,
      body: { circleIds: [uni.id, home.id] },
      status: 200,
    });
    const plans = (await api(port, "GET", "/api/plans?all=1", { token: alex.token })).plans as Row[];
    assert.equal(plans.filter((row) => row.id === uniPlan.id).length, 1);
    assert.equal(plans.length, 2);
  });
});

test("all=1 needs a session", async () => {
  await withApp(async ({ port }) => {
    await setup(port);
    await api(port, "GET", "/api/socials?all=1", { status: 401 });
    await api(port, "GET", "/api/plans?all=1", { status: 401 });
  });
});
