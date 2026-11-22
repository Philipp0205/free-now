import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { api, withApp, testEmail, type AppCtx } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };
type Kind = "socials" | "plans";

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("0000000d49484452", "hex")]);
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");

/** Alex hosts. Bea, Cam and Dan are in his circle. Olli has a circle of his own. */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", circle.inviteCode);
  const cam = await start("Cam", circle.inviteCode);
  const dan = await start("Dan", circle.inviteCode);
  const olli = await start("Olli");
  await api(port, "POST", "/api/circles", { token: olli.token, body: { name: "Elsewhere" }, status: 201 });
  return { alex, bea, cam, dan, olli, circle };
}

async function makeEvent(port: number, kind: Kind, host: Person, circleId: string, body: Record<string, unknown> = {}) {
  if (kind === "socials") {
    return (await api(port, "POST", `/api/socials?circle=${circleId}`, { token: host.token, body: { note: "Quiet walk", ...body }, status: 201 })).social;
  }
  const plan = { note: "Supper", place: "Hall", date: "2026-06-03", time: "18:00", ...body };
  return (await api(port, "POST", `/api/plans?circle=${circleId}`, { token: host.token, body: plan, status: 201 })).plan;
}

function send(ctx: AppCtx, kind: Kind, id: string, token: string | null, data: Buffer, method = "PUT") {
  return fetch(`http://127.0.0.1:${ctx.port}/api/${kind}/${id}/photo`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/octet-stream" },
    body: new Uint8Array(data),
  });
}

function fetchPhoto(ctx: AppCtx, kind: Kind, id: string, token: string | null, rev: unknown = 1, method = "GET") {
  return fetch(`http://127.0.0.1:${ctx.port}/api/${kind}/${id}/photo?v=${rev}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function listed(ctx: AppCtx, kind: Kind, person: Person, circleId: string) {
  const list = (await api(ctx, "GET", `/api/${kind}?circle=${circleId}`, { token: person.token, status: 200 })).json[kind] as Array<Record<string, any>>;
  return list;
}

for (const kind of ["socials", "plans"] as const) {
  test(`${kind}: the host adds a JPEG and a friend reads the same bytes`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, circle } = await seed(ctx.port);
      const event = await makeEvent(ctx.port, kind, alex, circle.id);
      assert.equal(event.photoRev, undefined, "no photo, no field");

      const put = await send(ctx, kind, event.id, alex.token, JPEG);
      assert.equal(put.status, 200);
      const { photoRev } = (await put.json()) as { photoRev: number };
      assert.ok(photoRev > 0);

      const row = (await listed(ctx, kind, bea, circle.id)).find((item) => item.id === event.id);
      assert.equal(row?.photoRev, photoRev, "a member's list carries the revision");

      const got = await fetchPhoto(ctx, kind, event.id, bea.token, photoRev);
      assert.equal(got.status, 200);
      assert.equal(got.headers.get("content-type"), "image/jpeg");
      assert.match(got.headers.get("cache-control") ?? "", /max-age=\d+/);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG);

      const head = await fetchPhoto(ctx, kind, event.id, bea.token, photoRev, "HEAD");
      assert.equal(head.status, 200);
      const again = await fetch(`http://127.0.0.1:${ctx.port}/api/${kind}/${event.id}/photo`, {
        headers: { authorization: `Bearer ${bea.token}`, "if-none-match": got.headers.get("etag") ?? "" },
      });
      assert.equal(again.status, 304);
    });
  });

  test(`${kind}: replacing bumps the revision and switches the format`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, circle } = await seed(ctx.port);
      const event = await makeEvent(ctx.port, kind, alex, circle.id);
      const first = ((await (await send(ctx, kind, event.id, alex.token, WEBP)).json()) as { photoRev: number }).photoRev;
      const second = ((await (await send(ctx, kind, event.id, alex.token, PNG, "POST")).json()) as { photoRev: number }).photoRev;
      assert.ok(second > first, "a new photo gets a new revision");
      const got = await fetchPhoto(ctx, kind, event.id, bea.token, second);
      assert.equal(got.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
      const files = fs.readdirSync(loadConfig({ DB_PATH: ":memory:" }).eventPhotosDir).filter((name) => name.includes(event.id));
      assert.deepEqual(files, [`${kind === "socials" ? "social" : "plan"}-${event.id}.png`], "the old format is gone");
    });
  });

  test(`${kind}: removing clears the photo, the field and the file`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, circle } = await seed(ctx.port);
      const event = await makeEvent(ctx.port, kind, alex, circle.id);
      await send(ctx, kind, event.id, alex.token, JPEG);
      assert.equal((await send(ctx, kind, event.id, bea.token, JPEG, "DELETE")).status, 403, "a friend cannot remove it");
      assert.equal((await send(ctx, kind, event.id, alex.token, Buffer.alloc(0), "DELETE")).status, 200);
      assert.equal((await fetchPhoto(ctx, kind, event.id, bea.token)).status, 404);
      const row = (await listed(ctx, kind, bea, circle.id)).find((item) => item.id === event.id);
      assert.equal(row?.photoRev, undefined);
      const files = fs.readdirSync(loadConfig({ DB_PATH: ":memory:" }).eventPhotosDir).filter((name) => name.includes(event.id));
      assert.deepEqual(files, []);
    });
  });

  test(`${kind}: only the host changes the photo, and only the right sizes and types are kept`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, circle } = await seed(ctx.port);
      const event = await makeEvent(ctx.port, kind, alex, circle.id);
      assert.equal((await send(ctx, kind, event.id, bea.token, JPEG)).status, 403, "a friend is not the host");
      assert.equal((await send(ctx, kind, event.id, null, JPEG)).status, 401);
      assert.equal((await fetchPhoto(ctx, kind, event.id, null)).status, 401);
      assert.equal((await send(ctx, kind, event.id, alex.token, SVG)).status, 415, "SVG is refused");
      assert.equal((await send(ctx, kind, event.id, alex.token, GIF)).status, 415, "GIF is refused");
      assert.equal((await send(ctx, kind, event.id, alex.token, Buffer.from("not an image at all"))).status, 415);
      assert.equal((await send(ctx, kind, event.id, alex.token, Buffer.alloc(0))).status, 415, "an empty body is not a photo");
      const big = Buffer.concat([JPEG, Buffer.alloc(700 * 1024)]);
      assert.equal((await send(ctx, kind, event.id, alex.token, big)).status, 413);
      assert.equal((await fetchPhoto(ctx, kind, event.id, alex.token)).status, 404, "nothing was stored");
    });
  });

  test(`${kind}: an outsider and a bad id get the same 404`, async () => {
    await withApp(async (ctx) => {
      const { alex, olli, circle } = await seed(ctx.port);
      const event = await makeEvent(ctx.port, kind, alex, circle.id);
      await send(ctx, kind, event.id, alex.token, JPEG);
      for (const id of [event.id, UNKNOWN, "not-a-uuid"]) {
        assert.equal((await fetchPhoto(ctx, kind, id, olli.token)).status, 404, `GET ${id}`);
        assert.equal((await send(ctx, kind, id, olli.token, JPEG)).status, 404, `PUT ${id}`);
        assert.equal((await send(ctx, kind, id, olli.token, JPEG, "DELETE")).status, 404, `DELETE ${id}`);
      }
    });
  });

  test(`${kind}: a private event keeps its photo from friends who are not picked`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, cam, olli, circle } = await seed(ctx.port);
      const event = await makeEvent(ctx.port, kind, alex, circle.id, { invitees: [bea.user.id] });
      const put = await send(ctx, kind, event.id, alex.token, JPEG);
      assert.equal(put.status, 200);
      assert.equal((await fetchPhoto(ctx, kind, event.id, alex.token)).status, 200, "the host");
      assert.equal((await fetchPhoto(ctx, kind, event.id, bea.token)).status, 200, "a picked friend");
      const hidden = await fetchPhoto(ctx, kind, event.id, cam.token);
      const absent = await fetchPhoto(ctx, kind, UNKNOWN, cam.token);
      assert.equal(hidden.status, 404, "an unpicked friend");
      assert.equal(await hidden.text(), await absent.text(), "same answer as a missing event");
      assert.equal((await send(ctx, kind, event.id, cam.token, JPEG)).status, 404, "an unpicked friend cannot upload either");
      assert.equal((await fetchPhoto(ctx, kind, event.id, olli.token)).status, 404, "an outsider");
      assert.deepEqual(await listed(ctx, kind, cam, circle.id), [], "no row, so no photoRev for Cam");
      const beaRow = (await listed(ctx, kind, bea, circle.id)).find((item) => item.id === event.id);
      assert.ok(beaRow?.photoRev, "the picked friend sees the revision");
    });
  });

  test(`${kind}: the photo stays on a past event`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, circle } = await seed(ctx.port);
      const event = await makeEvent(ctx.port, kind, alex, circle.id);
      await send(ctx, kind, event.id, alex.token, JPEG);
      ctx.advance(10 * 24 * 60 * 60 * 1000);
      const got = await fetchPhoto(ctx, kind, event.id, bea.token);
      assert.equal(got.status, 200, "still served after the day has passed");
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG);
    });
  });
}

test("the photo of a deleted circle is cleaned up and the file is gone", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const event = await makeEvent(ctx.port, "plans", alex, circle.id);
    await send(ctx, "plans", event.id, alex.token, JPEG);
    const dir = loadConfig({ DB_PATH: ":memory:" }).eventPhotosDir;
    const file = `${dir}/plan-${event.id}.jpg`;
    assert.ok(fs.existsSync(file));
    // The sweep leaves very young files alone, so age this one past the grace period.
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(file, old, old);
    await api(ctx, "DELETE", `/api/circles?circle=${circle.id}`, { token: alex.token, status: 200 });
    assert.equal(fs.existsSync(file), false);
  });
});
