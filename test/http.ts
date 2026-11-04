import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";

// Shared by the route tests. Not a test file: `npm test` only runs `test/*.test.ts`.

export const START = Date.parse("2026-06-01T15:00:00.000Z");

/** What flow.test.ts records. Hangout and location record the payload alone. */
export type SentPush = { endpoint: string; payload: PushPayload };

export type AppCtx<TSent = PushPayload> = {
  port: number;
  server: http.Server;
  db: DatabaseSync;
  sent: TSent[];
  advance: (ms: number) => void;
  at: (ms: number) => void;
};

export type WithAppOptions = {
  /** IANA zone for APP_TZ. Wins over env.APP_TZ. Default UTC. */
  tz?: string;
  /** Extra loadConfig input, merged over PORT, DB_PATH, and APP_TZ. */
  env?: NodeJS.ProcessEnv;
  /** Replaces the stub that records into ctx.sent. */
  push?: PushSender;
  /** "payload" is the push body. "envelope" also keeps the endpoint. */
  sent?: "payload" | "envelope";
  /**
   * "controllable" starts at START and moves through at/advance.
   * "fixed" always reports START, which is what location.test.ts did.
   */
  now?: "controllable" | "fixed";
};

type ApiOptions = { token?: string; body?: unknown; status?: number };
type PayloadOptions = Omit<WithAppOptions, "sent"> & { sent?: "payload" };
type EnvelopeOptions = Omit<WithAppOptions, "sent"> & { sent: "envelope" };

export async function withApp(fn: (ctx: AppCtx<SentPush>) => Promise<void>, options: EnvelopeOptions): Promise<void>;
export async function withApp(fn: (ctx: AppCtx<PushPayload>) => Promise<void>, options?: PayloadOptions): Promise<void>;
// `any` is only this hidden implementation signature, so the overloads stay assignable.
export async function withApp(fn: (ctx: any) => Promise<void>, options: WithAppOptions = {}): Promise<void> {
  const sent: Array<PushPayload | SentPush> = [];
  let now = START;
  const db = openDb(":memory:");
  const push: PushSender = options.push ?? {
    async send(subscription, payload) {
      if (options.sent === "envelope") sent.push({ endpoint: subscription.endpoint, payload });
      else sent.push(payload);
    },
  };
  const env: NodeJS.ProcessEnv = {
    PORT: "3000",
    DB_PATH: ":memory:",
    APP_TZ: "UTC",
    ...options.env,
  };
  if (options.tz !== undefined) env.APP_TZ = options.tz;
  const config = loadConfig(env);
  const readNow = options.now === "fixed" ? () => START : () => now;
  const server = http.createServer(createApp({
    db,
    push,
    config: { ...config, dbPath: ":memory:" },
    now: readNow,
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({
      port,
      server,
      db,
      sent,
      advance(ms: number) {
        now += ms;
      },
      at(ms: number) {
        now = ms;
      },
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

// A port returns the JSON body (hangout and location). A { port } context returns
// { status, json } (flow). Same request either way.
export async function api(target: { port: number }, method: string, pathname: string, options?: ApiOptions): Promise<{ status: number; json: any }>;
export async function api(target: number, method: string, pathname: string, options?: ApiOptions): Promise<any>;
export async function api(
  target: number | { port: number },
  method: string,
  pathname: string,
  options: ApiOptions = {},
): Promise<any> {
  const port = typeof target === "number" ? target : target.port;
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (options.status !== undefined && response.status !== options.status) {
    throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  }
  if (typeof target === "number") return json;
  return { status: response.status, json };
}
