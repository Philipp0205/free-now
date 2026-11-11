import http from "node:http";
import type { AddressInfo } from "node:net";

const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
export const REFRESH = "refresh-token-value-1234567890";

/** A fake Google: /auth (a page with one Allow link), /token, /freebusy and /revoke. Shared by the server and UI tests. */
export type Fake = {
  env: NodeJS.ProcessEnv;
  busy: Array<{ start: number; end: number }>;
  tokenBody: () => Record<string, unknown>;
  tokenForms: URLSearchParams[];
  freebusyCalls: Array<{ bearer: string; body: any }>;
  revokes: string[];
  authViews: Array<{ scope: string; redirectUri: string }>;
  mode: { scope: string; refreshToken: string | null; refreshFails: boolean; freebusyError: boolean; revokeStatus: number; accessCount: number };
  close: () => Promise<void>;
};

export async function fakeGoogle(): Promise<Fake> {
  const fake: Fake = {
    env: {},
    busy: [],
    tokenBody: () => ({}),
    tokenForms: [],
    freebusyCalls: [],
    revokes: [],
    authViews: [],
    mode: { scope: SCOPE, refreshToken: REFRESH, refreshFails: false, freebusyError: false, revokeStatus: 200, accessCount: 0 },
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/auth") {
        // A tiny consent page: one Allow button that returns to Hangry with a good code.
        const query = new URL(req.url ?? "/", "http://fake.test").searchParams;
        const back = new URL(query.get("redirect_uri") ?? "");
        back.searchParams.set("code", "good-code");
        back.searchParams.set("state", query.get("state") ?? "");
        fake.authViews.push({ scope: query.get("scope") ?? "", redirectUri: query.get("redirect_uri") ?? "" });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Fake Google</title><h1>Fake Google consent</h1><p>Hangry wants to see when you are busy.</p><a id="allow" href="${back.href.replace(/&/g, "&amp;")}">Allow</a>`);
        return;
      }
      if (path === "/token") {
        const form = new URLSearchParams(text);
        fake.tokenForms.push(form);
        if (form.get("grant_type") === "refresh_token") {
          if (fake.mode.refreshFails) return send(400, { error: "invalid_grant" });
          return send(200, { access_token: `access-${++fake.mode.accessCount}`, expires_in: 3600, token_type: "Bearer" });
        }
        if (form.get("code") !== "good-code") return send(400, { error: "invalid_grant" });
        return send(200, {
          access_token: `access-${++fake.mode.accessCount}`,
          expires_in: 3600,
          token_type: "Bearer",
          scope: fake.mode.scope,
          ...(fake.mode.refreshToken ? { refresh_token: fake.mode.refreshToken } : {}),
        });
      }
      if (path === "/freebusy") {
        fake.freebusyCalls.push({ bearer: String(req.headers.authorization ?? ""), body: JSON.parse(text) });
        if (fake.mode.freebusyError) return send(200, { calendars: { primary: { errors: [{ reason: "notFound" }], busy: [] } } });
        return send(200, {
          kind: "calendar#freeBusy",
          calendars: { primary: { busy: fake.busy.map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() })) } },
        });
      }
      if (path === "/revoke") {
        fake.revokes.push(new URLSearchParams(text).get("token") ?? "");
        return send(fake.mode.revokeStatus, {});
      }
      send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.env = {
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_OAUTH_AUTH_URL: `${base}/auth`,
    GOOGLE_OAUTH_TOKEN_URL: `${base}/token`,
    GOOGLE_OAUTH_FREEBUSY_URL: `${base}/freebusy`,
    GOOGLE_OAUTH_REVOKE_URL: `${base}/revoke`,
  };
  fake.close = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}
