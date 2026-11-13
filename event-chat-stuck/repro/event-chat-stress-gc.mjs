#!/usr/bin/env node
// Phone stress for "can't open event chats". node event-chat-stress.mjs --dir <repo> --out <dir> --prefix before|after [--rounds 60] [--seed 1]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].slice(2), process.argv[i + 1]);
const dir = args.get("dir"), out = args.get("out"), prefix = args.get("prefix") || "run";
const rounds = Number(args.get("rounds") || 60);
const latency = Number(args.get("latency") || 0), hang = Number(args.get("hang") || 0), openWait = Number(args.get("open-wait") || 4000);
let seedN = Number(args.get("seed") || 1);
const rnd = () => { seedN = (seedN * 1664525 + 1013904223) % 4294967296; return seedN / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
fs.mkdirSync(out, { recursive: true });
const port = 19900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const dbPath = `/tmp/ecs-${prefix}.sqlite`;
for (const s of ["", "-wal", "-shm"]) { try { fs.rmSync(dbPath + s); } catch {} }
const env = { PORT: String(port), DB_PATH: dbPath, PUBLIC_BASE_URL: base, APP_TZ: "Europe/Berlin", SOCIAL_TTL_MS: "7200000" };
const child = spawn("npm", ["start"], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let slog = ""; child.stdout.on("data", (d) => (slog += d)); child.stderr.on("data", (d) => (slog += d));
const done = (code) => { try { proxy?.close(); proxy?.closeAllConnections?.(); } catch {} try { process.kill(-child.pid, "SIGTERM"); } catch {} setTimeout(() => process.exit(code), 500); };
const say = (m) => console.log(m);

async function api(method, p, token, body) {
  const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
for (let i = 0; i < 100; i++) { try { await fetch(base + "/welcome"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

import http from "node:http";
const proxyPort = port + 1000;
const proxyBase = `http://127.0.0.1:${proxyPort}`;
let hung = 0; let stallLeft = 0;
const stallK = Number(args.get("proxy-stall") || 0);
const hangRate = Number(args.get("proxy-hang") || 0) || (stallK ? 1e-9 : 0);
const proxy = hangRate ? http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/") && (stallLeft > 0 ? (stallLeft--, true) : rnd() < hangRate)) { hung++; req.on("error", () => {}); return; }
  const up = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on("error", () => res.destroy());
  req.pipe(up);
}).listen(proxyPort) : null;
const browseBase = hangRate ? proxyBase : base;
const result = { prefix, rounds: 0, failedAt: null, probes: 0, consoleErrors: [], pageErrors: [], httpErrors: [], requestFailed: [], dump: null };
try {
  const latestId = JSON.parse(fs.readFileSync(path.join(dir, "public/whats-new.json"), "utf8"))[0]?.id ?? "";
  const alex = await api("POST", "/api/auth/start", undefined, { name: "Alex" });
  const circle = (await api("POST", "/api/circles", alex.token, { name: "Friends" })).circle;
  const bea = await api("POST", "/api/auth/start", undefined, { name: "Bea", code: circle.inviteCode });
  const planIds = [];
  for (const [n, t] of [["Board games", "19:30"], ["Climbing", "20:00"], ["Ramen", "21:00"], ["Cinema", "22:00"]]) planIds.push((await api("POST", "/api/plans", bea.token, { note: n, time: t, place: "Cafe Lux" })).plan.id);
  for (const n of ["Coffee?", "Walk in the park", "Beers"]) await api("POST", "/api/socials", alex.token, { note: n });
  say("seeded");
  const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }));
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36" };
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(({ token, circleId, seen }) => {
    localStorage.setItem("fn_token", token); localStorage.setItem("fn_circle", circleId);
    localStorage.setItem("fn_install_later", String(Date.now())); if (seen) localStorage.setItem("fn_whats_new_seen", seen);
  }, { token: bea.token, circleId: circle.id, seen: latestId });
  ctx.on("response", (r) => { if (r.status() >= 400) result.httpErrors.push(`${r.status()} ${r.request().method()} ${r.url().replace(browseBase, "")}`); });
  ctx.on("requestfailed", (r) => result.requestFailed.push(r.url().replace(browseBase, "") + " " + r.failure()?.errorText));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => result.pageErrors.push(String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") result.consoleErrors.push(m.text().slice(0, 300)); });
  const tab = (name) => page.locator(".tabbar").getByRole("button", { name: new RegExp(`^${name}`) });
  const T = { timeout: 1500 };
  const snap = (name) => page.screenshot({ path: path.join(out, `${prefix}-${name}.png`) });
  const stateDump = () => page.evaluate(async () => {
    const { state } = await import(location.origin + "/js/state.js");
    return { tab: state.tab, chat: state.chat, hasThread: !!state.chatThread, chatQueue: state.chatQueue, error: state.error, offline: state.offline, statusMessage: state.statusMessage, sheet: state.sheet, confirm: !!state.confirm, cardMenu: state.cardMenu, past: state.past, circleMenu: state.circleMenu, histLen: history.length, histState: history.state,
      cls: document.documentElement.className, chatRows: document.querySelectorAll(".chat-row").length, screen: document.querySelector(".chat-screen") ? "chat-screen" : document.querySelector("[data-page]")?.dataset.page };
  });

  await page.goto(browseBase + "/", { waitUntil: "load" });
  await tab("Now").waitFor({ timeout: 15000 });
  await page.getByText("Board games").first().waitFor({ timeout: 10000 });
  const cdp = await ctx.newCDPSession(page);
  let inflight = 0, maxInflight = 0; const pend = new Set();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => { if (e.request.url.includes("/api/")) { pend.add(e.requestId); maxInflight = Math.max(maxInflight, pend.size); } });
  for (const ev of ["Network.loadingFinished", "Network.loadingFailed"]) cdp.on(ev, (e) => pend.delete(e.requestId));
  if (latency) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: 200 * 1024, uploadThroughput: 100 * 1024 });
  if (hang) await page.route("**/api/**", (route) => { if (route.request().method() === "GET" && rnd() < hang) return; return route.continue(); });
  result.openTimes = [];
  const counters = async () => { if (args.get("gc")) { await cdp.send("HeapProfiler.enable"); await cdp.send("HeapProfiler.collectGarbage"); await new Promise(r=>setTimeout(r,300)); } const c = await cdp.send("Memory.getDOMCounters"); return { nodes: c.nodes, listeners: c.jsEventListeners }; };
  result.counters = [await counters()];

  const safeBack = async () => { const ok = await page.evaluate(() => Boolean(history.state && history.state.hangryOverlay)); if (ok) await page.goBack(); };
  const back = async () => { const b = page.getByRole("button", { name: "Back", exact: true }); if (await b.count()) await b.first().click(T); else await safeBack(); };
  const actions = {
    tabNow: () => tab("Now").click(T),
    tabEvents: () => tab("Events").click(T),
    tabCircle: () => tab("Circle").click(T),
    tabYou: () => tab("You").click(T),
    bell: () => page.locator('[aria-label^="Alerts"]').first().click(T),
    circleChat: async () => { await tab("Chat").click(T); await page.waitForTimeout(150); await back(); },
    goBack: () => safeBack(),
    openCloseEventChat: async () => { await tab("Now").click(T); const rows = page.locator(".chat-row"); const n = await rows.count(); if (n) { await rows.nth(Math.floor(rnd() * n)).click(T); await page.waitForTimeout(100); await back(); } },
    sendInEventChat: async () => { await tab("Now").click(T); const rows = page.locator(".chat-row"); const n = await rows.count(); if (!n) return; await rows.nth(Math.floor(rnd() * n)).click(T); const ta = page.locator("#chat-input"); await ta.waitFor(T); await ta.fill("hi " + Math.floor(rnd() * 1000)); await page.getByRole("button", { name: /^Send$/ }).click(T); await page.waitForTimeout(100); await back(); },
    eventsViews: async () => { await tab("Events").click(T); const m = page.locator(".events-view").getByRole("button", { name: "Map", exact: true }); if (await m.count()) await m.click(T); await page.waitForTimeout(150); const c = page.locator(".events-view").getByRole("button", { name: "Calendar", exact: true }); if (await c.count()) await c.click(T); },
    openPlanSheet: async () => { await tab("Now").click(T); await page.getByRole("button", { name: "Let friends know you're free now" }).click(T); await page.waitForTimeout(100); await safeBack(); },
    openEventFromCard: async () => { await tab("Now").click(T); await page.getByText(pick(["Board games", "Climbing", "Ramen", "Coffee?"])).first().click(T); await page.waitForTimeout(100); await safeBack(); },
    youSection: async () => { await tab("You").click(T); const b = page.locator(".page").getByRole("button", { name: /^Profile/ }); if (await b.count()) await b.click(T); await page.waitForTimeout(100); await safeBack(); },
    calendarSheetChat: async () => { await tab("Events").click(T); await page.waitForTimeout(250); const row = page.locator(".cal-list button, .cal-row, .cal-list > *").first(); if (await row.count()) await row.click(T); await page.waitForTimeout(150); const c = page.locator(".sheet .chat-row"); if (await c.count()) { await c.first().click(T); await page.waitForTimeout(200); await back(); } await page.waitForTimeout(100); await safeBack(); },
    mapCardChat: async () => { await tab("Events").click(T); const m = page.locator(".events-view").getByRole("button", { name: "Map", exact: true }); if (await m.count()) await m.click(T); await page.waitForTimeout(600); const pin = page.locator(".pin, .leaflet-marker-icon").first(); if (await pin.count()) await pin.click({ ...T, force: true }); await page.waitForTimeout(200); const c = page.locator(".map-card .chat-row"); if (await c.count()) { await c.first().click(T); await page.waitForTimeout(200); await back(); } },
    alertsChat: async () => { await page.locator('[aria-label^="Alerts"]').first().click(T); await page.waitForTimeout(150); const a = page.locator(".alert-card"); if (await a.count()) { await a.nth(Math.floor(rnd() * await a.count())).click(T); await page.waitForTimeout(200); await back(); } },
    friendActs: async () => { await api("POST", `/api/plans/${planIds[Math.floor(rnd()*planIds.length)]}/chat`, alex.token, { text: "yo " + Math.floor(rnd()*999) }).catch(() => {}); await api("POST", "/api/circles/chat", alex.token, { text: "circle hi" }).catch(() => {}); if (rnd() < 0.3) await api("POST", "/api/plans", alex.token, { note: "Extra " + Math.floor(rnd()*99), time: "23:00" }).catch(() => {}); },
    cardMenu: async () => { await tab("Now").click(T); const m = page.getByRole("button", { name: /^More for/ }); if (await m.count()) await m.first().click(T); await page.waitForTimeout(80); await safeBack(); },
  };
  const names = Object.keys(actions);

  async function probe(label) {
    result.probes++;
    // leave whatever is open, reach Now, open an event chat
    for (let i = 0; i < 4; i++) { if (await page.locator(".chat-screen").count()) await back(); }
    await page.evaluate(() => { document.activeElement?.blur?.(); });
    await tab("Now").click({ timeout: 2500 }).catch(() => {});
    const rows = page.locator(".chat-row");
    await rows.first().waitFor({ timeout: 3000 }).catch(() => {});
    if (!(await rows.count())) return { ok: false, why: "no chat rows on Now" };
    const i = Math.floor(rnd() * await rows.count());
    await rows.nth(i).click({ timeout: 3000 }).catch(() => {});
    const t0 = Date.now();
    const opened = await page.waitForFunction(() => document.querySelector("#chat-input") && !document.querySelector(".chat-log .help"), null, { timeout: openWait, polling: 50 }).then(() => true, () => false);
    result.openTimes.push(opened ? Date.now() - t0 : -1);
    if (opened) { await back(); await page.waitForTimeout(100); }
    return { ok: opened, why: opened ? "" : `chat ${label} did not open` };
  }

  stallLeft = stallK;
  let failed = false;
  for (let r = 1; r <= rounds && !failed; r++) {
    const seq = []; const steps = 12 + Math.floor(rnd() * 8);
    for (let s = 0; s < steps; s++) { const a = pick(names); seq.push(a); try { await actions[a](); } catch (e) { /* tap missed, keep going */ } }
    result.rounds = r;
    const p = await probe(`round ${r}`);
    if (r % (latency || hangRate ? 3 : 10) === 0) { result.counters.push(await counters()); say(`round ${r}: ok=${p.ok} inflight=${pend.size} max=${maxInflight} openMs=${result.openTimes.at(-1)} counters=${JSON.stringify(result.counters.at(-1))}`); }
    if (!p.ok) {
      failed = true; result.failedAt = r; result.lastSeq = seq;
      result.dump = await stateDump().catch((e) => String(e)); result.inflightAtFail = pend.size;
      await snap("stuck");
      say(`FAILED at round ${r}: ${p.why}`); say(JSON.stringify(result.dump));
      // does a retry / reload recover?
      const again = await page.locator(".chat-row").first().click({ timeout: 2000 }).then(() => true, () => false);
      result.retryClickWorked = again && await page.locator("#chat-input").waitFor({ timeout: 3000 }).then(() => true, () => false);
      result.dumpAfterRetry = await stateDump();
    }
  }
  result.maxInflight = maxInflight; result.proxyHung = hung;
  if (!failed) { await snap("fine"); say(`no failure in ${rounds} rounds`); }
  await browser.close();
} catch (e) { say("ERROR " + e.stack); result.error = String(e); }
result.consoleErrors = [...new Set(result.consoleErrors)].slice(0, 20);
result.pageErrors = [...new Set(result.pageErrors)].slice(0, 20);
const tally = {}; for (const h of result.httpErrors) tally[h] = (tally[h] || 0) + 1; result.httpErrors = tally;
result.requestFailed = [...new Set(result.requestFailed)].slice(0, 20);
fs.writeFileSync(path.join(out, `${prefix}-result.json`), JSON.stringify(result, null, 2));
say(JSON.stringify(result, null, 2).slice(0, 4000));
done(result.failedAt ? 1 : 0);
