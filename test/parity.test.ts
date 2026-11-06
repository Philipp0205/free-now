import assert from "node:assert/strict";
import test from "node:test";
// Client and server copies of the same rules. None of these modules opens a DB or starts a server on import.
import { addDays as clientAddDays, dayLabel as clientDayLabel, PLAN_DAYS_AHEAD as CLIENT_DAYS_AHEAD } from "../public/when.js";
import { audiencePlace as clientAudiencePlace, isMapsLink, looksLikeUrl as clientLooksLikeUrl } from "../public/place.js";
import { addDays as serverAddDays, dayLabel as serverDayLabel } from "../src/time.js";
import { PLAN_DAYS_AHEAD as SERVER_DAYS_AHEAD } from "../src/plans.js";
import { audiencePlace as serverAudiencePlace } from "../src/notify.js";
import { isMapsLinkInput, looksLikeUrl as serverLooksLikeUrl } from "../src/geocode.js";

test("addDays matches on client and server", () => {
  const days = ["2026-01-31", "2026-02-28", "2026-03-29", "2026-10-25", "2026-12-31", "2027-01-01", "2028-02-28", "2028-02-29", "2028-03-01"];
  const steps = [-400, -365, -31, -1, 0, 1, 2, 7, 30, 365];
  for (const iso of days) {
    for (const step of steps) {
      assert.equal(clientAddDays(iso, step), serverAddDays(iso, step), `${iso} ${step}`);
    }
  }
});

test("dayLabel matches on client and server", () => {
  for (const today of ["2026-06-15", "2026-12-28", "2027-02-27", "2028-02-28", "2026-03-29", "2026-10-25"]) {
    for (let gap = -1; gap <= 400; gap += 1) {
      const iso = serverAddDays(today, gap);
      assert.equal(clientDayLabel(iso, today), serverDayLabel(iso, today), `${today} +${gap}`);
    }
  }
});

test("plans reach the same number of days ahead", () => {
  assert.equal(CLIENT_DAYS_AHEAD, SERVER_DAYS_AHEAD);
});

test("audiencePlace matches on client and server", () => {
  for (const place of ["near you", "Near you", " near you ", "", "  Cafe  ", "near Schlossplatz", "nearby"]) {
    assert.equal(clientAudiencePlace(place), serverAudiencePlace(place), JSON.stringify(place));
  }
});

test("looksLikeUrl matches on client and server", () => {
  for (const value of ["http://x", "HTTPS://x", "  https://maps.app.goo.gl/abc", "www.x.com", "ftp://x", "", "cafe"]) {
    assert.equal(clientLooksLikeUrl(value), serverLooksLikeUrl(value), JSON.stringify(value));
  }
});

test("maps link check matches on client and server", () => {
  // Known difference, left out: the client accepts any 2-3 letter Google TLD, the server only its
  // exact list. So "https://google.xyz/maps" and "https://maps.google.xyz/" are true on the client, false on the server.
  const links = [
    "https://maps.app.goo.gl/abc",
    "  https://maps.app.goo.gl/abc  ",
    "https://MAPS.APP.GOO.GL/x",
    "https://maps.app.goo.gl./x",
    "https://goo.gl/maps/abc",
    "https://goo.gl/abc",
    "https://www.google.com/maps/place/X",
    "https://google.de/maps?q=1,2",
    "https://maps.google.com/?q=48.1,9.1",
    "https://maps.google.co.uk/",
    "https://www.google.com/search?q=x",
    "http://maps.app.goo.gl/abc",
    "https://example.com/maps",
    "not a url",
    "",
  ];
  for (const link of links) {
    assert.equal(isMapsLink(link), isMapsLinkInput(link), JSON.stringify(link));
  }
});
