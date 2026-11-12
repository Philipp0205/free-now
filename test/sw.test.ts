import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import zlib from "node:zlib";

const SOURCE = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

type Reply = number | Error;

/** Runs public/sw.js in a sandbox. fetch answers from `replies` in order; setTimeout fires at once and records the delay. */
function loadWorker(options: { replies?: Reply[]; show?: () => Promise<void> } = {}) {
  const replies = [...(options.replies ?? [])];
  const fetches: Array<{ url: string; body: string }> = [];
  const delays: number[] = [];
  const handlers: Record<string, (event: unknown) => void> = {};
  const order: string[] = [];
  const sandbox: Record<string, unknown> = {
    URL,
    console,
    setTimeout: (fn: () => void, ms: number) => {
      delays.push(ms);
      queueMicrotask(fn);
      return 0;
    },
    fetch: async (url: string, init: { body: string }) => {
      fetches.push({ url, body: init.body });
      order.push("ack");
      const next = replies.shift() ?? 204;
      if (next instanceof Error) throw next;
      return { status: next };
    },
    caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [] },
    self: {
      location: { origin: "https://hangry.test" },
      addEventListener: (type: string, fn: (event: unknown) => void) => { handlers[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
      registration: {
        showNotification: async () => {
          await (options.show ?? (async () => {}))();
          order.push("shown");
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  const retryAck = sandbox.retryAck as (
    send: () => Promise<{ status: number }>,
    wait: (ms: number) => Promise<void>,
    delays: number[],
  ) => Promise<string>;
  async function push(data: Record<string, string>): Promise<{ settled: Promise<unknown> }> {
    let settled: Promise<unknown> = Promise.resolve();
    handlers.push({ data: { json: () => data }, waitUntil: (promise: Promise<unknown>) => { settled = promise; } });
    return { settled };
  }
  return { retryAck, push, fetches, delays, order };
}

function sender(replies: Reply[]) {
  let calls = 0;
  const send = async () => {
    calls += 1;
    const next = replies.shift() ?? 204;
    if (next instanceof Error) throw next;
    return { status: next };
  };
  return { send, calls: () => calls };
}

test("an ack retries after a 500 and then succeeds", async () => {
  const { retryAck } = loadWorker();
  const waits: number[] = [];
  const { send, calls } = sender([500, 204]);
  assert.equal(await retryAck(send, async (ms) => { waits.push(ms); }, [1000, 3000, 9000]), "ok");
  assert.equal(calls(), 2);
  assert.deepEqual(waits, [1000]);
});

test("an ack retries after a network error", async () => {
  const { retryAck } = loadWorker();
  const waits: number[] = [];
  const { send, calls } = sender([new TypeError("Failed to fetch"), new TypeError("Failed to fetch"), 204]);
  assert.equal(await retryAck(send, async (ms) => { waits.push(ms); }, [1000, 3000, 9000]), "ok");
  assert.equal(calls(), 3);
  assert.deepEqual(waits, [1000, 3000]);
});

test("an ack stops on a 4xx", async () => {
  const { retryAck } = loadWorker();
  for (const status of [400, 429]) {
    const waits: number[] = [];
    const { send, calls } = sender([status, 204]);
    assert.equal(await retryAck(send, async (ms) => { waits.push(ms); }, [1000, 3000, 9000]), "rejected");
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
  }
});

test("an ack gives up after the last backoff", async () => {
  const { retryAck } = loadWorker();
  const waits: number[] = [];
  const { send, calls } = sender([500, 503, new TypeError("offline"), 502, 204]);
  assert.equal(await retryAck(send, async (ms) => { waits.push(ms); }, [1000, 3000, 9000]), "gave_up");
  assert.equal(calls(), 4);
  assert.deepEqual(waits, [1000, 3000, 9000]);
});

test("the push handler acks only after the notification shows, and retries inside waitUntil", async () => {
  const worker = loadWorker({ replies: [500, 500, 204] });
  const { settled } = await worker.push({ title: "Alex is free", id: "row-1" });
  assert.equal(await settled, "ok");
  assert.deepEqual(worker.order, ["shown", "ack", "ack", "ack"]);
  assert.deepEqual(worker.delays, [1000, 3000]);
  assert.equal(worker.fetches[0].url, "/api/push/ack");
  assert.deepEqual(JSON.parse(worker.fetches[0].body), { id: "row-1" });
});

test("the push handler sends no ack when showNotification fails", async () => {
  const worker = loadWorker({ show: async () => { throw new TypeError("No notification permission"); } });
  const { settled } = await worker.push({ title: "Alex is free", id: "row-1" });
  await assert.rejects(settled as Promise<unknown>);
  assert.equal(worker.fetches.length, 0);
});

test("a push without a row id shows the notification and sends no ack", async () => {
  const worker = loadWorker();
  const { settled } = await worker.push({ title: "Test" });
  await settled;
  assert.deepEqual(worker.order, ["shown"]);
});

test("the service worker cache moved past v9", () => {
  const version = Number(/const CACHE = "hangry-v(\d+)"/.exec(SOURCE)?.[1]);
  assert.ok(version >= 10);
});

/** Reads an RGBA PNG written by scripts/generate-assets.mjs (8-bit, no interlace, filter 0 rows). */
function readRgbaPng(file: URL) {
  const data = fs.readFileSync(file);
  assert.equal(data.subarray(1, 4).toString("latin1"), "PNG");
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  assert.equal(data[24], 8, "8-bit");
  assert.equal(data[25], 6, "RGBA");
  const parts: Buffer[] = [];
  for (let at = 8; at < data.length; ) {
    const length = data.readUInt32BE(at);
    if (data.subarray(at + 4, at + 8).toString("latin1") === "IDAT") parts.push(data.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, "unfiltered rows");
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, pixels };
}

test("the notification badge is a bold solid silhouette that fills most of the canvas", () => {
  assert.match(SOURCE, /badge: "\/icons\/badge-96\.png"/);
  const { width, height, pixels } = readRgbaPng(new URL("../public/icons/badge-96.png", import.meta.url));
  assert.equal(width, 96);
  assert.equal(height, 96);
  let opaque = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] >= 250) {
      opaque += 1;
      assert.deepEqual([...pixels.subarray(i, i + 3)], [255, 255, 255], "opaque pixels are white");
    }
  }
  // Android keeps only the alpha. A faint or tiny shape vanishes in the status bar.
  assert.ok(opaque / (width * height) >= 0.5, `only ${opaque} of ${width * height} pixels are solid`);
  const centre = (48 * width + 48) * 4;
  assert.equal(pixels[centre + 3], 255, "solid in the middle");
  assert.equal(pixels[3], 0, "clear in the corner");
});

test("the worker caches buzzer.js with the shell", () => {
  const shell = JSON.parse(/const SHELL = (\[[^\]]*\]);/.exec(SOURCE)?.[1] ?? "[]") as string[];
  assert.ok(shell.includes("/buzzer.js"));
});
