import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeAdminReaders, resetAdminFailures } from "../../src/admin/admin-query.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { api, START, testEmail } from "../http.js";

const ADMIN = "a".repeat(32);

// The admin query reads the database file from another process, so this needs a file, not :memory:.
test("the admin query still sees a private plan and everyone on it", async () => {
  resetAdminFailures();
  closeAdminReaders();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-private-admin-"));
  const file = path.join(dir, "app.sqlite");
  const db = openDb(file);
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: file, ADMIN_TOKEN: ADMIN });
  const server = http.createServer(createApp({ db, push: { async send() {} }, config, now: () => START }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex", email: testEmail() }, status: 201 });
    const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
    const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", email: testEmail(), code: circle.inviteCode }, status: 201 });
    const plan = (await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Secret supper", date: "2026-06-03", invitees: [bea.user.id] },
      status: 201,
    })).plan;

    const found = await api(port, "POST", "/api/admin/query", {
      token: ADMIN,
      body: {
        sql: "SELECT p.note, COUNT(i.user_id) FROM plans p JOIN event_invitees i ON i.event_id = p.id WHERE p.id = ? GROUP BY p.id",
        params: [plan.id],
      },
      status: 200,
    });
    assert.deepEqual(found.rows, [["Secret supper", 2]]);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeAdminReaders();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
