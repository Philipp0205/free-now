import http from "node:http";
import { loadConfig } from "./config.js";
import { clearExpiredLocations, openDb, sweep } from "./db.js";
import { createApp } from "./app.js";
import { createNoopPushSender, createWebPushSender } from "./push.js";
import { sendStartReminders } from "./remind.js";
import { addDays, isoDate } from "./time.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const push = config.vapid ? createWebPushSender(config.vapid) : createNoopPushSender();

function sweepNow(): void {
  const now = Date.now();
  const today = isoDate(now, config.tz);
  sweep(db, now, addDays(today, -2), today);
}

function clearLocationsNow(): void {
  const now = Date.now();
  clearExpiredLocations(db, now, isoDate(now, config.tz));
  void sendStartReminders(db, push, now).catch((error: unknown) => {
    console.error("start reminder failed", error instanceof Error ? error.message : error);
  });
}

sweepNow();
const sweepTimer = setInterval(sweepNow, 60 * 60 * 1000);
const locationTimer = setInterval(clearLocationsNow, 60 * 1000);
sweepTimer.unref?.();
locationTimer.unref?.();

const server = http.createServer(
  createApp({
    db,
    push,
    config,
    now: () => Date.now(),
  }),
);

server.listen(config.port, "0.0.0.0", () => {
  console.log("Hangry");
  console.log(`  listening   http://localhost:${config.port}`);
  console.log(`  database    ${config.dbPath}`);
  console.log(`  timezone    ${config.tz}`);
  console.log(`  socials     expire after ${Math.round(config.socialTtlMs / 60000)} minutes`);
  if (config.vapid) {
    console.log("  web push    enabled");
  } else {
    console.log("  web push    off (no VAPID keys) — in-app notifications still work");
  }
  if (config.publicBaseUrl) {
    console.log(`  public url  ${config.publicBaseUrl}`);
  }
});

function shutdown(): void {
  clearInterval(sweepTimer);
  clearInterval(locationTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
