import assert from "node:assert/strict";
import test from "node:test";
import { api, withApp, testEmail } from "../http.js";

type Person = { token: string; user: { id: string } };

async function start(port: number, name: string, code?: string): Promise<Person> {
  return api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
}

async function raw(port: number, pathname: string, token: string) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, text: await response.text() };
}

function line(text: string, name: string): string {
  const row = text.replace(/\r\n /g, "").split("\r\n").find((item) => item.startsWith(`${name}:`));
  return row?.slice(name.length + 1) ?? "";
}

test("the feed asks for hourly polling and the one-time file does not", async () => {
  await withApp(async ({ port }) => {
    const alex = await start(port, "Alex");
    const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
    const plan = (await api(port, "POST", `/api/plans?circle=${circle.id}`, {
      token: alex.token,
      body: { note: "Sushi", date: "2026-06-02", time: "19:00" },
      status: 201,
    })).plan;
    const made = await fetch(`http://127.0.0.1:${port}/api/me/calendar-feed`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${alex.token}` },
      body: "{}",
    });
    const feedPath = new URL(((await made.json()) as { url: string }).url).pathname;
    const feed = await fetch(`http://127.0.0.1:${port}${feedPath}`);
    const feedText = await feed.text();
    assert.ok(feedText.includes("REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n"));
    assert.ok(feedText.includes("X-PUBLISHED-TTL:PT1H\r\n"));
    const file = await raw(port, `/api/plans/${plan.id}/calendar.ics`, alex.token);
    assert.equal(file.text.includes("REFRESH-INTERVAL"), false);
    assert.equal(file.text.includes("X-PUBLISHED-TTL"), false);
  });
});

test("calendarRev follows SEQUENCE: date, start, end and not replies, and the file keeps its UID", async () => {
  await withApp(async ({ port, advance }) => {
    const alex = await start(port, "Alex");
    const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
    const bea = await start(port, "Bea", circle.inviteCode);
    const created = (await api(port, "POST", `/api/plans?circle=${circle.id}`, {
      token: alex.token,
      body: { note: "Sushi", date: "2026-06-02", time: "19:00" },
      status: 201,
    })).plan;
    const edit = async (body: Record<string, unknown>) => {
      advance(60_000);
      return (await api(port, "PATCH", `/api/plans/${created.id}?circle=${circle.id}`, { token: alex.token, body, status: 200 })).plan.calendarRev as number;
    };
    const listed = async () => {
      const plans = (await api(port, "GET", `/api/plans?circle=${circle.id}`, { token: bea.token, status: 200 })).plans as Array<{ id: string; calendarRev: number }>;
      return plans.find((row) => row.id === created.id)!.calendarRev;
    };
    assert.equal(created.calendarRev, 0);
    const before = await raw(port, `/api/plans/${created.id}/calendar.ics`, alex.token);

    const afterDate = await edit({ date: "2026-06-03" });
    assert.ok(afterDate > 0, "date edit raises it");
    const afterTime = await edit({ time: "20:00" });
    assert.ok(afterTime > afterDate, "start time edit raises it");
    const afterEnd = await edit({ endsAt: "22:30" });
    assert.ok(afterEnd > afterTime, "setting an end raises it");

    advance(60_000);
    await api(port, "POST", `/api/plans/${created.id}/reply?circle=${circle.id}`, { token: bea.token, body: { reply: "in" }, status: 200 });
    assert.equal(await listed(), afterEnd, "a reply does not raise it");

    const after = await raw(port, `/api/plans/${created.id}/calendar.ics`, alex.token);
    assert.equal(line(after.text, "UID"), line(before.text, "UID"));
    assert.equal(Number(line(after.text, "SEQUENCE")), afterEnd, "calendarRev is the SEQUENCE in the file");
    assert.ok(Number(line(after.text, "SEQUENCE")) > Number(line(before.text, "SEQUENCE")));
    assert.equal(line(before.text, "DTSTART"), "20260602T170000Z");
    assert.equal(line(after.text, "DTSTART"), "20260603T180000Z", "20:00 Berlin on the new day");
  }, { tz: "Europe/Berlin" });
});
