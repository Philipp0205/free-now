#!/usr/bin/env node
// Phone e2e for "can't open event chats": hang the first N API GETs, tap an event chat, then (if it opens) send a message.
// node event-chat-e2e.mjs --dir <repo> --out <dir> --prefix main|branch [--stall 6] [--wait 60000]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright-core";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].slice(2), process.argv[i + 1]);
const dir = args.get("dir"), out = args.get("out"), prefix = args.get("prefix");
const stall = Number(args.get("stall") ?? 6), waitMs = Number(args.get("wait") ?? 60000);
fs.mkdirSync(out, { recursive: true });
const port = 19900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const dbPath = `/tmp/ecs-e2e-${prefix}.sqlite`;
for (const s of ["", "-wal", "-shm"]) { try { fs.rmSync(dbPath + s); } catch {} }
const child = spawn("npm", ["start"], { cwd: dir, env: { ...process.env, PORT: String(port), DB_PATH: dbPath, PUBLIC_BASE_URL: base, APP_TZ: "Europe/Berlin", SOCIAL_TTL_MS: "7200000" }, stdio: "ignore", detached: true });
const result = { prefix, stall, steps: [] };
const log = (m, extra = {}) => { result.steps.push({ m, ...extra }); console.log(m, JSON.stringify(extra)); };
let proxy;
const finish = (code) => { try { proxy?.closeAllConnections?.(); proxy?.close(); } catch {} try { process.kill(-child.pid, "SIGTERM"); } catch {} fs.writeFileSync(path.join(out, `${prefix}-e2e-result.json`), JSON.stringify(result, null, 2)); setTimeout(() => process.exit(code), 500); };
async function api(method, p, token, body) {
  const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`); return text ? JSON.parse(text) : null;
}
for (let i = 0; i < 100; i++) { try { await fetch(base + "/welcome"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
let stallLeft = 0, hung = 0;
const proxyPort = port + 1000, pbase = `http://127.0.0.1:${proxyPort}`;
proxy = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/") && stallLeft > 0) { stallLeft--; hung++; req.on("error", () => {}); return; }
  const up = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on("error", () => res.destroy()); req.pipe(up);
}).listen(proxyPort);
let code = 0;
try {
  const latestId = JSON.parse(fs.readFileSync(path.join(dir, "public/whats-new.json"), "utf8"))[0]?.id ?? "";
  const alex = await api("POST", "/api/auth/start", undefined, { name: "Alex" });
  const circle = (await api("POST", "/api/circles", alex.token, { name: "Friends" })).circle;
  const bea = await api("POST", "/api/auth/start", undefined, { name: "Bea", code: circle.inviteCode });
  for (const [n, t] of [["Board games", "19:30"], ["Climbing", "20:00"]]) {
    const plan = (await api("POST", "/api/plans", bea.token, { note: n, time: t, place: "Cafe Lux" })).plan;
    await api("POST", `/api/plans/${plan.id}/chat`, bea.token, { text: "Bring plates" });
    await api("POST", `/api/plans/${plan.id}/chat`, alex.token, { text: "I'll bring the snacks" });
  }
  const social = (await api("POST", "/api/socials", alex.token, { note: "Coffee?" })).social;
  await api("POST", `/api/socials/${social.id}/chat`, bea.token, { text: "Table by the window" });
  const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(({ token, circleId, seen }) => { localStorage.setItem("fn_token", token); localStorage.setItem("fn_circle", circleId); localStorage.setItem("fn_install_later", String(Date.now())); if (seen) localStorage.setItem("fn_whats_new_seen", seen); }, { token: alex.token, circleId: circle.id, seen: latestId });
  const page = await ctx.newPage();
  const tab = (n) => page.locator(".tabbar").getByRole("button", { name: new RegExp(`^${n}`) });
  const snap = (n) => page.screenshot({ path: path.join(out, `${prefix}-${n}.png`) });
  await page.goto(pbase + "/", { waitUntil: "load" });
  await tab("Now").waitFor({ timeout: 15000 });
  await page.getByText("Board games").first().waitFor({ timeout: 10000 });
  log("loaded and healthy");
  // the connection goes bad: the next N API GETs never answer
  stallLeft = stall;
  await page.waitForTimeout(7000); // two poll ticks
  const rows = page.locator(".chat-row");
  await rows.first().scrollIntoViewIfNeeded();
  await rows.first().click({ timeout: 3000 });
  const t0 = Date.now();
  await page.waitForTimeout(1500);
  const screenAt1s = await page.evaluate(() => document.querySelector(".chat-screen") ? "chat-screen" : "home");
  log("1.5s after tap", { screen: screenAt1s, hungSoFar: hung });
  await snap("1-after-tap");
  const opened = await page.waitForFunction(() => document.querySelector("#chat-input") && /Bring plates|Table by the window/.test(document.querySelector(".chat-log")?.textContent || ""), null, { timeout: waitMs, polling: 100 }).then(() => true, () => false);
  const ms = Date.now() - t0;
  log(opened ? "chat opened" : "chat did NOT open", { ms });
  result.opened = opened; result.openedMs = opened ? ms : null;
  if (opened) await page.waitForTimeout(8000);
  await snap(opened ? "2-opened" : "2-stuck");
  if (opened) {
    // open another chat and send a message
    await page.goBack(); await page.waitForTimeout(300);
    await tab("Now").click({ timeout: 3000 });
    const msg = "see you at 7 " + Date.now() % 1000;
    await rows.nth(1).click({ timeout: 3000 });
    const ta = page.locator("#chat-input"); await ta.waitFor({ timeout: 5000 });
    await ta.fill(msg);
    await page.getByRole("button", { name: /^Send$/ }).click({ timeout: 3000 });
    const sent = await page.getByText(msg).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    log("message sent and shown", { sent });
    result.sent = sent;
    await snap("3-sent");
    if (!sent) code = 1;
  } else code = 1;
  await browser.close();
} catch (e) { log("ERROR " + e.stack); code = 1; }
result.hung = hung;
finish(code);
