import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  SEEN_KEY,
  formatEntryDate,
  latestId,
  newerSeen,
  normalizeEntries,
  unseenEntries,
  validId,
} from "../public/js/whats-new.js";
import { api, withApp, testEmail } from "./http.js";
import { builtPrecache, readBuilt } from "./built.js";

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const RAW = JSON.parse(read("../public/whats-new.json")) as Array<{
  id: string;
  date: string;
  title: string;
  bullets: string[];
}>;

const entry = (id: string) => ({ id, date: "2026-11-05", title: id, bullets: ["one", "two"] });
const LIST = [entry("c"), entry("b"), entry("a")];

test("the shipped changelog is newest first and every entry is well-formed", () => {
  assert.ok(Array.isArray(RAW) && RAW.length > 0);
  const ids = new Set<string>();
  let previous = "9999-12-31";
  for (const item of RAW) {
    assert.deepEqual(Object.keys(item).sort(), ["bullets", "date", "id", "title"], item.id);
    assert.ok(validId(item.id), `bad id ${item.id}`);
    assert.equal(ids.has(item.id), false, `duplicate id ${item.id}`);
    ids.add(item.id);
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(`${item.date}T00:00:00Z`)), item.date);
    assert.ok(item.date <= previous, `${item.id} is out of order`);
    previous = item.date;
    assert.ok(item.title.trim().length > 0 && item.title.length <= 60, item.id);
    assert.ok(item.bullets.length >= 2 && item.bullets.length <= 4, `${item.id} needs 2–4 bullets`);
    for (const bullet of item.bullets) assert.ok(bullet.trim().length > 0 && bullet.length <= 140, bullet);
  }
  assert.equal(normalizeEntries(RAW).length, RAW.length);
});

test("the busy until and weekly hours entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-11-busy-until")!;
  assert.ok(top, "busy until entry");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Busy until a time, or every week");
  assert.equal(top.bullets.length, 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /You tab/);
  assert.match(text, /clears itself/);
  assert.match(text, /weekly hours/);
  assert.match(text, /only see that you're busy or free, and until when/);
  assert.match(text, /free/);
  assert.ok(RAW.some((item) => item.id === "2026-11-11-chat-caret"), "older entries are kept");
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the card Share entry is in the changelog, in plain words without an em dash", () => {
  const share = RAW.find((item) => item.id === "2026-11-07-card-share");
  assert.ok(share, "card Share entry");
  assert.equal(share.title, "Share plans anywhere");
  for (const text of [share.title, ...share.bullets]) assert.ok(!text.includes("\u2014"), text);
});

test("the Meet the Goblin entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-14-meet-the-goblin")!;
  assert.ok(top, "Meet the Goblin entry");
  assert.equal(top.date, "2026-11-14");
  assert.equal(top.title, "Meet the Goblin");
  assert.equal(top.bullets.length, 2);
  assert.match([top.title, ...top.bullets].join(" "), /@Goblin/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= (line === top.title ? 60 : 140), line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-14-invite-finds-account"), "invite entry is kept");
});

test("the invite links entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-14-invite-finds-account")!;
  assert.ok(top, "invite entry");
  assert.equal(top.date, "2026-11-14");
  assert.equal(top.title, "Invite links find your account");
  assert.equal(top.bullets.length, 3);
  assert.match([top.title, ...top.bullets].join(" "), /I already have an account/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= (line === top.title ? 60 : 140), line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-14-plan-for-day-button"), "Plan for this day entry is kept");
});

test("the Plan for this day button entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-14-plan-for-day-button")!;
  assert.ok(top, "Plan for this day entry");
  assert.equal(top.date, "2026-11-14");
  assert.equal(top.bullets.length, 2);
  assert.match([top.title, ...top.bullets].join(" "), /Plan for this day/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= (line === top.title ? 60 : 140), line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-13-flic-circle-per-press"), "Flic entry is kept");
});

test("the Flic circle per press entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-13-flic-circle-per-press")!;
  assert.ok(top, "Flic entry");
  assert.equal(top.date, "2026-11-13");
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Flic/);
  assert.match(text, /double click/i);
  assert.match(text, /hold/i);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= (line === top.title ? 60 : 140), line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-13-calendar-plans-and-scroll"), "calendar plans entry is kept");
});

test("the calendar plans and scroll entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-13-calendar-plans-and-scroll")!;
  assert.ok(top, "calendar plans entry");
  assert.equal(top.date, "2026-11-13");
  assert.equal(top.title, "Plan from the calendar, and Back keeps your place");
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= (line === top.title ? 60 : 140), line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-13-chats-open-on-bad-signal"), "weak connection entry is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-13-admin-end-events"), "admin end events entry is kept");
});

test("the admin end events entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-13-admin-end-events")!;
  assert.ok(top, "admin end events entry");
  assert.equal(top.date, "2026-11-13");
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /admins/i);
  assert.match(text, /End/);
  assert.match(text, /disappears for everyone/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= (line === top.title ? 60 : 140), line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-12-install-app"), "install app entry is kept");
});

test("the install app entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-12-install-app")!;
  assert.ok(top, "install app entry");
  assert.equal(top.date, "2026-11-12");
  assert.equal(top.title, "Install Hangry from You > Account");
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Install app/);
  assert.match(text, /home screen/);
  assert.match(text, /comes back/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= (line === top.title ? 60 : 140), line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-12-chat-read-alerts"), "chat read alerts entry is kept");
});

test("the chat read alerts entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-12-chat-read-alerts")!;
  assert.ok(top, "chat read alerts entry");
  assert.equal(top.date, "2026-11-12");
  assert.equal(top.title, "Reading a chat clears its alerts");
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /marked read/);
  assert.match(text, /Alerts tab/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= 140, line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-12-chat-wrap"), "chat wrap entry is kept");
});

test("the chat wrap entry is in the changelog, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-12-chat-wrap")!;
  assert.ok(top, "chat wrap entry");
  assert.equal(top.title, "Long chat messages wrap");
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= 140, line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-12-blocked-wording"), "blocked wording entry is kept");
});

test("the blocked wording entry stays in the changelog, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-12-blocked-wording");
  assert.ok(top, "blocked wording entry");
  assert.equal(top.title, "Clearer busy times");
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  assert.match(top.bullets.join(" "), /Blocked from 09:00 to 10:00/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= 140, line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-12-friends-view"), "friends view entry is kept");
});

test("the friends view entry stays in the changelog, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-12-friends-view");
  assert.ok(top, "friends view entry");
  assert.equal(top.date, "2026-11-12");
  assert.equal(top.title, "See what friends see");
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Availability & calendar/);
  assert.match(text, /Check now/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= 140, line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-11-settings-menu"), "settings menu entry is kept");
});

test("the settings menu entry stays in the changelog, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-11-settings-menu");
  assert.ok(top, "settings menu entry");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Settings, split into pages");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /You tab is now a short menu/);
  assert.match(text, /Back button/);
  assert.match(text, /Android back/);
  for (const line of [top.title, ...top.bullets]) {
    assert.ok(line.length <= 140, line);
    assert.ok(!line.includes("\u2014"), line);
  }
  assert.ok(RAW.some((item) => item.id === "2026-11-11-privacy"), "privacy entry is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-11-google-return"), "google return entry is kept");
});

test("the Google return entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-11-google-return")!;
  assert.ok(top, "google return entry");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Google Calendar connects without a second login");
  assert.equal(top.bullets.length, 2);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /says it is connected as soon as you come back/);
  assert.match(text, /go back to Hangry/);
  assert.match(text, /not signed in/);
  for (const jargon of ["OAuth", "Custom Tab", "localStorage", "PWA"]) assert.ok(!text.includes(jargon), jargon);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the reaction notification entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-11-reaction-notify")!;
  assert.ok(top, "reaction notification entry");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Get notified when friends react");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /reacts to your chat message/);
  assert.match(text, /which emoji/);
  assert.match(text, /short bit of your message/);
  assert.match(text, /your own reactions/);
  assert.match(text, /muted the chat/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the privacy policy entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-11-privacy")!;
  assert.ok(top, "privacy policy entry");
  assert.equal(top.id, "2026-11-11-privacy");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "A public privacy policy");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /\/privacy/);
  assert.match(text, /calendar and assistant tokens/);
  assert.match(text, /do not sell your data/);
  assert.match(text, /Ask in the app/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014") && line.length <= 140, line);
  assert.ok(RAW.some((item) => item.id === "2026-11-11-google-return"), "google return entry is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-11-reaction-notify"), "older entries are kept");
});

test("the Connect Google Calendar entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-11-google-freebusy")!;
  assert.ok(top, "google freebusy entry");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Connect Google Calendar");
  assert.equal(top.bullets.length, 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /busy or free/);
  assert.match(text, /never event names/);
  assert.match(text, /how often it checks/);
  assert.match(text, /myaccount\.google\.com\/permissions/);
  assert.match(text, /private link still works/);
  assert.match(text, /only the times and your own titles/);
  assert.doesNotMatch(text, /OAuth|PKCE|FreeBusy|scope|token/i, "no jargon");
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the assistant tokens entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-11-assistant-tokens")!;
  assert.ok(top, "assistant tokens entry");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Let an assistant act for you");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /named token/);
  assert.match(text, /shown only once/);
  assert.match(text, /Revoke it any time/);
  assert.match(text, /read your circles, set your status, make plans and say you are in/);
  assert.match(text, /Friends see those actions as you/);
  assert.doesNotMatch(text, /OpenAPI|Bearer|SHA|REST|OAuth|API/, "no jargon");
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the chat cursor fix entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-11-chat-caret")!;
  assert.ok(top, "chat cursor entry");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Tap to move the cursor while typing in chat");
  assert.equal(top.bullets.length, 2);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /moves the cursor/);
  assert.match(text, /keyboard stays open/);
  assert.doesNotMatch(text, /touch-action|caret|iOS|CSS/i, "no jargon");
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the faster map entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-faster-map")!;
  assert.ok(top, "faster map entry");
  assert.equal(top.id, "2026-11-09-faster-map");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Faster map");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /stays dark until the dark map is ready/);
  assert.doesNotMatch(text, /right away|fills in/, "no street map first");
  assert.match(text, /snappier/);
  assert.doesNotMatch(text, /PMTiles|cache|prefetch|archive/i, "no jargon");
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the chat mentions, reactions and replies entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-chat-mentions-reactions")!;
  assert.ok(top, "chat mentions entry");
  assert.equal(top.id, "2026-11-09-chat-mentions-reactions");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Mentions, reactions and replies in chat");
  assert.equal(top.bullets.length, 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Type @/);
  assert.match(text, /hold a message/);
  assert.match(text, /Reaction counts/);
  assert.match(text, /Swipe a message to the right to reply/);
  assert.match(text, /tap Reply/);
  assert.match(text, /quote/);
  assert.match(text, /person you replied to gets a notification/);
  assert.equal(RAW.filter((item) => item.id.includes("repl")).length, 0, "replies ride on the same entry, not a new one");
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the Away or Busy entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-away-status")!;
  assert.ok(top, "Away or Busy entry");
  assert.equal(top.id, "2026-11-09-away-status");
  assert.equal(top.date, "2026-11-11");
  assert.equal(top.title, "Away or Busy");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /You tab/);
  assert.match(text, /badge/);
  assert.match(text, /clears itself/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the install-after-joining entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-invite-install")!;
  assert.ok(top, "invite install entry");
  assert.equal(top.id, "2026-11-10-invite-install");
  assert.equal(top.date, "2026-11-10");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /join a circle/);
  assert.match(text, /iPhone/);
  assert.match(text, /Share, then Add to Home Screen/);
  assert.match(text, /Android/);
  assert.match(text, /Install app/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the card who's in entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-card-whos-in")!;
  assert.ok(top, "card who's in entry");
  assert.equal(top.id, "2026-11-10-card-whos-in");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.title, "See who's in on the card");
  assert.equal(top.bullets.length, 2);
  assert.match(top.bullets[0], /people who are coming/);
  assert.match(top.bullets[1], /can't make it/);
  assert.match(top.bullets[1], /details/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the Zürich dark map entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-zurich-map")!;
  assert.ok(top, "Zürich dark map entry");
  assert.equal(top.id, "2026-11-10-zurich-map");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.title, "Dark map in Zürich too");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Zürich/);
  assert.match(text, /Stuttgart/);
  assert.match(text, /between the two cities/);
  assert.match(text, /regular street map/);
  assert.doesNotMatch(text, /\b(pmtiles|archive|vector|tiles?|zoom|bounds)\b/i);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the circle switch alerts entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-circle-switch-alerts")!;
  assert.ok(top, "circle switch alerts entry");
  assert.equal(top.id, "2026-11-10-circle-switch-alerts");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.title, "Alerts no longer repeat when you switch circles");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /already seen/);
  assert.match(text, /shows once/);
  for (const line of top.bullets) assert.ok(line.length <= 140, line);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the Flic button entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-flic-button")!;
  assert.ok(top, "Flic button entry");
  assert.equal(top.id, "2026-11-10-flic-button");
  assert.equal(top.date, "2026-11-10");
  assert.ok(top.title.length <= 60, top.title);
  assert.ok(top.bullets.length <= 4);
  for (const line of top.bullets) assert.ok(line.length <= 140, line);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Flic button/);
  assert.match(text, /You tab/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("calendar availability is listed, in plain words", () => {
  const top = RAW.find((entry) => entry.id === "2026-11-10-calendar-availability")!;
  assert.equal(top.id, "2026-11-10-calendar-availability");
  assert.equal(top.date, "2026-11-10");
  assert.ok(top.title.length <= 60, top.title);
  assert.ok(top.bullets.length <= 4);
  for (const line of top.bullets) assert.ok(line.length <= 140, line);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /busy or free/);
  assert.match(text, /never the names/);
  assert.match(text, /until you turn one on/);
  assert.match(text, /I'm in/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the monthly calendar entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-calendar-month")!;
  assert.ok(top, "monthly calendar entry");
  assert.equal(top.id, "2026-11-10-calendar-month");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.title, "Events: a monthly calendar and the map");
  assert.ok(top.title.length <= 60, top.title);
  assert.equal(top.bullets.length, 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /called Events/);
  assert.match(text, /calendar icon/);
  assert.match(text, /Map \/ Calendar/);
  assert.match(text, /Calendar is the first view/);
  assert.match(text, /remembers/);
  assert.match(text, /past days/);
  assert.match(text, /who is in/);
  assert.match(text, /This circle \/ All circles works on the calendar/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the clearer notification icon entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-notification-icon");
  assert.ok(top, "notification icon entry");
  assert.equal(top.id, "2026-11-10-notification-icon");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Android/);
  assert.match(text, /solid dot/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the one map for every circle entry stays, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-map-all-circles")!;
  assert.equal(top.id, "2026-11-09-map-all-circles");
  assert.equal(top.date, "2026-11-09");
  assert.equal(top.title, "One map for every circle");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /This circle \/ All circles/);
  assert.match(text, /names the circle/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the glass map pins entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-glass-pins")!;
  assert.ok(top, "glass pins entry");
  assert.equal(top.title, "Nicer map pins");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /glass chip/);
  assert.match(text, /Reduce motion/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the map card close entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-map-card-close");
  assert.ok(top, "map card close entry");
  assert.equal(top.title, "Close the map card");
  assert.equal(top.bullets.length, 2);
  assert.match(top.bullets[0], /X in its corner/);
  assert.match(top.bullets[1], /empty spot on the map/);
  assert.match(top.bullets[1], /Escape/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the dark map that sticks over the covered area is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-dark-map-sticks");
  assert.ok(top, "dark map sticks entry");
  assert.equal(top.title, "The dark map stays put");
  assert.equal(top.bullets.length, 2);
  assert.equal(
    top.bullets[0],
    "Dark map sticks while you look at the covered area, even if the edges stick out a little; zoom out past it and the usual map returns.",
  );
  const text = [top.title, ...top.bullets].join(" ");
  assert.doesNotMatch(text, /\b(now live|everywhere|worldwide|all over)\b/i);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the dark map entry is kept, and it does not claim the map is live everywhere", () => {
  const top = RAW.find((item) => item.id === "2026-11-08-dark-map-ready");
  assert.ok(top, "dark map entry");
  assert.equal(top.title, "A dark map, where we have one");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /only for an area the server has a map file for/);
  assert.match(text, /usual map/);
  assert.doesNotMatch(text, /\b(now live|everywhere|worldwide|all over)\b/i);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the menu and tab polish entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-08-menu-tab-polish");
  assert.ok(top, "menu and tab polish entry");
  assert.equal(top.title, "Smoother menus and tabs");
  assert.equal(top.bullets.length, 2);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  assert.ok(RAW.some((item) => item.id === "2026-11-07-plan-another-day"), "older entries are kept");
});

test("Plan for another day is in the changelog, in plain words without an em dash", () => {
  const entry = RAW.find((item) => item.id === "2026-11-07-plan-another-day");
  assert.ok(entry, "Plan for another day entry");
  assert.equal(entry.title, "Now and later first");
  assert.equal(entry.bullets.length, 2);
  assert.ok(entry.bullets.some((bullet) => bullet.includes("Plan for another day")));
  for (const text of [entry.title, ...entry.bullets]) assert.ok(!text.includes("\u2014"), text);
});

test("the map pins entry is in the changelog, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-08-map-dates-buzz");
  assert.ok(top, "map pins entry");
  assert.equal(top.id, "2026-11-08-map-dates-buzz");
  assert.equal(top.title, "Livelier map pins");
  assert.equal(top.bullets.length, 3);
  assert.ok(top.bullets.some((bullet) => bullet.includes("Later today 19:00")));
  assert.ok(top.bullets.some((bullet) => bullet.includes("buzz")));
  assert.ok(top.bullets.some((bullet) => bullet.includes("crowd")));
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  assert.ok(RAW.some((item) => item.id === "2026-11-07-plan-another-day"), "older entries are kept");
});

test("unseen entries: nothing seen shows all, a known id shows what is newer, an unknown id shows none", () => {
  assert.deepEqual(unseenEntries(LIST, null).map((item) => item.id), ["c", "b", "a"]);
  assert.deepEqual(unseenEntries(LIST, "a").map((item) => item.id), ["c", "b"]);
  assert.deepEqual(unseenEntries(LIST, "b").map((item) => item.id), ["c"]);
  assert.deepEqual(unseenEntries(LIST, "c"), []);
  assert.deepEqual(unseenEntries(LIST, "from-a-newer-build"), []);
  assert.deepEqual(unseenEntries([], null), []);
  assert.deepEqual(unseenEntries(null, null), []);
  assert.equal(latestId(LIST), "c");
  assert.equal(latestId([]), null);
});

test("the newer of the phone's and the account's seen id wins", () => {
  assert.equal(newerSeen(LIST, null, null), null);
  assert.equal(newerSeen(LIST, "a", null), "a");
  assert.equal(newerSeen(LIST, null, "b"), "b");
  assert.equal(newerSeen(LIST, "a", "c"), "c");
  assert.equal(newerSeen(LIST, "c", "a"), "c");
  assert.equal(newerSeen(LIST, "b", "b"), "b");
  assert.equal(newerSeen(LIST, "a", "unknown"), "unknown");
  assert.equal(newerSeen(LIST, "unknown", "c"), "unknown");
});

test("broken entries are dropped instead of breaking the popup", () => {
  const kept = normalizeEntries([
    entry("ok"),
    { id: "Bad Id", date: "2026-11-05", title: "x", bullets: ["y"] },
    { id: "no-bullets", date: "2026-11-05", title: "x", bullets: [] },
    { id: "no-title", date: "2026-11-05", title: " ", bullets: ["y"] },
    { id: "blank-bullet", date: "2026-11-05", title: "x", bullets: ["y", ""] },
    null,
    "nope",
  ]);
  assert.deepEqual(kept.map((item) => item.id), ["ok"]);
  assert.deepEqual(normalizeEntries({ not: "a list" }), []);
});

test("entry dates read as a short day, month, and year", () => {
  assert.equal(formatEntryDate("2026-11-05"), "5 Nov 2026");
  assert.equal(formatEntryDate("2026-01-31"), "31 Jan 2026");
  assert.equal(formatEntryDate("soon"), "soon");
  assert.equal(SEEN_KEY, "fn_whats_new_seen");
});

test("the build label is hangry-v124 and the built worker precaches the changelog, the bundle, the kit and the vendor files", () => {
  const app = read("../public/js/app.js");
  assert.equal(/export const APP_VERSION = "([^"]+)"/.exec(app)?.[1], "hangry-v124");
  const paths = builtPrecache();
  assert.ok(paths.includes("/whats-new.json"));
  assert.ok(paths.includes("/js/app.js"));
  assert.ok(paths.includes("/css/styles.css"));
  assert.ok(paths.includes("/app-kit/ak-donate.js"));
  assert.ok(paths.includes("/app-kit/ak-tabbar.js"));
  assert.ok(paths.includes("/app-kit/ak-native.js"));
  assert.ok(paths.includes("/app-kit/ak-native.css"));
  assert.ok(paths.includes("/app-kit/ak-transition.js"));
  assert.ok(paths.includes("/app-kit/install-prompt.js"));
  assert.ok(paths.includes("/app-kit/ak-tokens.css"));
  assert.ok(paths.includes("/vendor/leaflet/leaflet.js"));
  assert.ok(paths.includes("/vendor/leaflet/leaflet.css"));
  assert.ok(paths.includes("/vendor/protomaps-leaflet/protomaps-leaflet.js"));
  // The whats-new code is bundled into the app, and no cache name is kept by hand any more.
  assert.ok(readBuilt("js/app.js").includes("fn_whats_new_seen"));
  assert.doesNotMatch(read("../sw/sw.js"), /const (CACHE|SHELL) = /);
});

test("the emoji rain entry is the newest, in plain words without an em dash", () => {
  const top = RAW[0];
  assert.equal(top.id, "2026-11-19-emoji-rain");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-19");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /taco/);
  assert.match(top.bullets.join(" "), /\/makeitrain/);
  assert.match(top.bullets.join(" "), /no emoji rains tacos/);
  assert.match(top.bullets.join(" "), /Missed a recent rain.*closed.*about an hour, once per device/);
  assert.ok(RAW.some((item) => item.id === "2026-11-19-add-description"), "the add description entry is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-19-open-bills"), "the open bills entry is kept");
});

test("the add description entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-19-add-description")!;
  assert.ok(top, "the add description entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-19");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /Description/);
  assert.match(top.bullets.join(" "), /Plan sheet/);
  assert.ok(RAW.some((item) => item.id === "2026-11-19-open-bills"), "the open bills entry is kept");
});

test("the open bills entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-19-open-bills")!;
  assert.ok(top, "the open bills entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-19");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /Bills/);
  assert.match(top.bullets.join(" "), /owe/i);
  assert.ok(RAW.some((item) => item.id === "2026-11-18-color-tokens"), "the colour tokens entry is kept");
});

test("the colour tokens entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-18-color-tokens")!;
  assert.ok(top, "the colour tokens entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-18");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /light/i);
  assert.match(top.bullets.join(" "), /dark/i);
  assert.match(top.bullets.join(" "), /emoji picker/i);
  assert.ok(RAW.some((item) => item.id === "2026-11-18-app-kit-070"), "the app-kit entry is kept");
});

test("the app-kit 0.7.0 entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-18-app-kit-070")!;
  assert.ok(top, "the app-kit entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-18");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /tab/i);
  assert.match(top.bullets.join(" "), /sheet/i);
  assert.match(top.bullets.join(" "), /menu/i);
  assert.ok(RAW.some((item) => item.id === "2026-11-18-more-goblin-lines"), "the Goblin entry is kept");
});

test("the Goblin more-lines entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-18-more-goblin-lines")!;
  assert.ok(top, "the Goblin entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-18");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /@Goblin in chat/);
  assert.ok(RAW.some((item) => item.id === "2026-11-18-gif-reactions"), "the GIF entry is kept");
});

test("the GIF entry is kept, in plain words without an em dash", () => {
  const gif = RAW.find((item) => item.id === "2026-11-18-gif-reactions")!;
  assert.ok(gif, "GIF entry");
  assert.equal(gif.date, "2026-11-18");
  assert.equal(gif.title, "Send GIFs in chat");
  for (const text of [gif.title, ...gif.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of gif.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(gif.bullets.join(" "), /GIF/);
  assert.match(gif.bullets.join(" "), /reaction bar/i);
  assert.match(gif.bullets.join(" "), /Giphy/);
});


test("the event payments entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-18-event-payments");
  assert.ok(top, "the event payments entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-18");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /price per person/i);
  assert.match(top.bullets.join(" "), /PayPal/);
  assert.match(top.bullets.join(" "), /Wero/);
  assert.match(top.bullets.join(" "), /Who paid/);
});

test("the chat event details entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-18-chat-event-details");
  assert.ok(top, "the chat event details entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-18");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /title/i);
  assert.match(top.bullets.join(" "), /details/i);
  assert.match(top.bullets.join(" "), /back in the chat/i);
});

test("the pull to refresh entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-18-pull-to-refresh");
  assert.ok(top, "the pull to refresh entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-18");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /pull/i);
  for (const tab of ["Now", "Events", "Circle", "You"]) assert.match(top.bullets.join(" "), new RegExp(`\\b${tab}\\b`));
});

test("the any emoji entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-18-any-emoji");
  assert.ok(top, "the any emoji entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-18");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /any emoji/i);
  assert.match(top.bullets.join(" "), /search/i);
});

test("the chat links and copy entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-18-chat-links-copy");
  assert.ok(top, "the chat links and copy entry is kept");
  assert.match(top.id, /^[a-z0-9-]{1,64}$/);
  assert.equal(top.date, "2026-11-18");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /link/i);
  assert.match(top.bullets.join(" "), /copy/i);
});

test("the always dark entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-17-always-dark");
  assert.ok(top, "the always dark entry is kept");
  assert.equal(top.date, "2026-11-17");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /dark/i);
  assert.match(top.bullets.join(" "), /desktop/i);
  assert.match(top.bullets.join(" "), /light mode/i);
});

test("the native feel part B entry is kept, in plain words without an em dash, and older entries are kept", () => {
  const top = RAW.find((item) => item.id === "2026-11-17-native-feel-2");
  assert.ok(top, "the native feel part B entry is kept");
  assert.equal(top.date, "2026-11-17");
  assert.ok(top.title.length <= 60);
  assert.ok(top.bullets.length >= 2 && top.bullets.length <= 4);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  for (const bullet of top.bullets) assert.ok(bullet.length <= 140, bullet);
  assert.match(top.bullets.join(" "), /sheets/i);
  assert.match(top.bullets.join(" "), /big title/i);
  assert.match(top.bullets.join(" "), /slide/i);
  const partA = RAW.find((item) => item.id === "2026-11-17-native-feel");
  assert.ok(partA, "the native feel part A entry is kept");
  assert.match(partA.bullets.join(" "), /tab bar/i);
  assert.match(partA.bullets.join(" "), /top/i);
  assert.match(partA.bullets.join(" "), /placeholder/i);
  const wero = RAW.find((item) => item.id === "2026-11-16-wero-email");
  assert.ok(wero, "the Wero email entry is kept");
  assert.match(wero.bullets.join(" "), /Wero/);
  assert.match(wero.bullets.join(" "), /copy/i);
  assert.ok(RAW.some((item) => item.id === "2026-11-15-email"), "the email entry is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-16-payment-link"), "the pay link entry is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-15-donate-accent"), "the tip entry is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-15-faster-loading"), "Faster loading is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-14-meet-the-goblin"), "Meet the Goblin is kept");
  assert.ok(RAW.some((item) => item.id === "2026-11-07-plan-another-day"), "older entries are kept");
});

test("/api/me carries whatsNewSeen and POST /api/me/whats-new stores it", async () => {
  await withApp(async ({ port, db }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
    assert.equal(alex.user.whatsNewSeen, null);
    await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });

    const fresh = await api(port, "GET", "/api/me", { token: alex.token });
    assert.equal(fresh.user.whatsNewSeen, null);

    const saved = await api(port, "POST", "/api/me/whats-new", {
      token: alex.token,
      body: { id: RAW[0].id },
      status: 200,
    });
    assert.deepEqual(saved, { whatsNewSeen: RAW[0].id });
    const after = await api(port, "GET", "/api/me", { token: alex.token });
    assert.equal(after.user.whatsNewSeen, RAW[0].id);
    const row = db.prepare("SELECT whats_new_seen AS seen FROM users WHERE id = ?").get(alex.user.id) as { seen: string };
    assert.equal(row.seen, RAW[0].id);

    // A second device of the same person signs in and already has it.
    const recovered = await api(port, "POST", "/api/auth/recover", { body: { token: alex.recoveryCode }, status: 200 });
    const other = await api(port, "GET", "/api/me", { token: recovered.token });
    assert.equal(other.user.whatsNewSeen, RAW[0].id);

    for (const id of ["", "Has Caps", "a".repeat(65), "semi;colon", 42, null]) {
      const bad = await api(port, "POST", "/api/me/whats-new", { token: alex.token, body: { id }, status: 400 });
      assert.equal(bad.error, "id is required");
    }
    await api(port, "POST", "/api/me/whats-new", { body: { id: "x" }, status: 401 });
    assert.equal((await api(port, "GET", "/api/me", { token: alex.token })).user.whatsNewSeen, RAW[0].id);
  });
});

test("whats-new.json is served as JSON", async () => {
  await withApp(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/whats-new.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await response.json(), RAW);
    assert.equal(response.headers.get("cache-control"), "no-cache");
  });
});

test("an older database gains the whats_new_seen column", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { openDb } = await import("../src/db.js");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-wn-"));
  const file = path.join(dir, "old.db");
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    )`);
    old.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u1', 'Old', 'h', 'b', 1)").run();
    old.close();
    const db = openDb(file);
    const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((col) => col.name);
    assert.ok(cols.includes("whats_new_seen"));
    const row = db.prepare("SELECT whats_new_seen AS seen FROM users WHERE id = 'u1'").get() as { seen: string | null };
    assert.equal(row.seen, null);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    assert.ok(tables.includes("feedback"));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
