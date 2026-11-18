import assert from "node:assert/strict";
import test from "node:test";
import { findLinks, messageParts } from "../../public/js/links.js";
import { findMentions } from "../../public/js/mentions.js";

const urls = (text: string) => findLinks(text).map((link: { url: string }) => link.url);

test("only http and https URLs are links, scheme in any case", () => {
  assert.deepEqual(urls("see http://example.com/a and https://example.org/b"), ["http://example.com/a", "https://example.org/b"]);
  assert.deepEqual(urls("HTTPS://Example.com/Path HtTp://example.net"), ["HTTPS://Example.com/Path", "HtTp://example.net"]);
  assert.deepEqual(urls("javascript:alert(1)"), []);
  assert.deepEqual(urls("JAVASCRIPT:alert(1) data:text/html,<b>x</b>"), []);
  assert.deepEqual(urls("ftp://example.com/file"), []);
  assert.deepEqual(urls("www.example.com and example.com/menu"), []);
  assert.deepEqual(urls("https:// and http://"), []);
  assert.deepEqual(urls("xhttps://example.com"), []);
});

test("several URLs in one string keep their positions", () => {
  const text = "a https://one.example/x b https://two.example/y?q=1#z c";
  const links = findLinks(text);
  assert.equal(links.length, 2);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.url);
  assert.deepEqual(links.map((link: { url: string }) => link.url), ["https://one.example/x", "https://two.example/y?q=1#z"]);
});

test("trailing sentence punctuation is not part of the link", () => {
  assert.deepEqual(urls("Try https://example.com/menu."), ["https://example.com/menu"]);
  assert.deepEqual(urls("Try https://example.com/menu, then go"), ["https://example.com/menu"]);
  assert.deepEqual(urls("https://example.com/a;"), ["https://example.com/a"]);
  assert.deepEqual(urls("Is it https://example.com/a?"), ["https://example.com/a"]);
  assert.deepEqual(urls("Wow https://example.com/a!!!"), ["https://example.com/a"]);
  assert.deepEqual(urls("https://example.com/a?!.,"), ["https://example.com/a"]);
  assert.deepEqual(urls("https://example.com/a?b=1"), ["https://example.com/a?b=1"]);
  assert.deepEqual(urls("https://example.com/a."), ["https://example.com/a"]);
});

test("brackets and parentheses: balanced ones stay, wrapping ones go", () => {
  assert.deepEqual(urls("(see https://example.com/menu)"), ["https://example.com/menu"]);
  assert.deepEqual(urls("(see https://example.com/menu)."), ["https://example.com/menu"]);
  assert.deepEqual(urls("[https://example.com/menu]"), ["https://example.com/menu"]);
  assert.deepEqual(urls("https://en.example.org/wiki/Ramen_(food)"), ["https://en.example.org/wiki/Ramen_(food)"]);
  assert.deepEqual(urls("(https://en.example.org/wiki/Ramen_(food))."), ["https://en.example.org/wiki/Ramen_(food)"]);
  assert.deepEqual(urls("https://example.com/a)),"), ["https://example.com/a"]);
});

test("a mention and a URL in the same message", () => {
  const text = "@Bea look https://example.com/menu, @Alex too";
  const parts = messageParts(text, findMentions(text, ["Bea", "Alex"]));
  assert.deepEqual(parts.map((part: { type: string }) => part.type), ["mention", "text", "link", "text", "mention", "text"]);
  assert.equal(parts.map((part: { text: string }) => part.text).join(""), text);
  assert.equal(parts[0].name, "Bea");
  assert.equal(parts[2].url, "https://example.com/menu");
  assert.equal(parts[2].text, "https://example.com/menu");
  assert.equal(parts[3].text, ", ");
});

test("an @name inside a URL stays part of the link", () => {
  const text = "https://example.com/@Bea/photos";
  const parts = messageParts(text, findMentions(text, ["Bea"]));
  assert.deepEqual(parts.map((part: { type: string }) => part.type), ["link"]);
});

test("quote-breaking and raw HTML payloads never become links or markup", () => {
  const payload = 'https://example.com"><img src=x onerror=alert(1)>';
  const parts = messageParts(payload);
  const link = parts.find((part: { type: string }) => part.type === "link");
  assert.equal(link.url, "https://example.com");
  assert.equal(parts.map((part: { text: string }) => part.text).join(""), payload, "every character is still shown as text");
  for (const part of parts) assert.ok(part.type !== "link" || !/[<>"'\s]/.test(part.url), part.url);

  assert.deepEqual(urls("<script>alert(1)</script>"), []);
  assert.deepEqual(urls('<a href="javascript:alert(1)">x</a>'), []);
  assert.deepEqual(urls("<img src=x onerror=alert(1)>"), []);
  assert.deepEqual(urls("https://example.com/<script>alert(1)</script>"), ["https://example.com/"]);
  assert.deepEqual(urls("https://example.com/a'b\"c"), ["https://example.com/a'b"]);
  assert.deepEqual(urls("[x](javascript:alert(1))"), []);
  assert.deepEqual(urls("&#x6A;avascript:alert(1)"), []);
});

test("text without a URL is one unchanged text part", () => {
  for (const text of ["", "Running 5 min late", "email me at a@b.co, ok?", "http is a protocol", "50% off: now!"]) {
    assert.deepEqual(findLinks(text), []);
    const parts = messageParts(text);
    if (text) assert.deepEqual(parts, [{ type: "text", text }]);
    else assert.deepEqual(parts, []);
  }
});

test("a message that is only a URL is a single link", () => {
  assert.deepEqual(messageParts("https://example.com/menu"), [{ type: "link", url: "https://example.com/menu", text: "https://example.com/menu" }]);
});
