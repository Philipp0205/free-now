import type http from "node:http";
import { type Auth, createAuth } from "../app-kit/auth.ts";
import type { AppDeps } from "../app.js";
import { requestOrigin } from "../lib/http.js";
import type { RateLimiter } from "../lib/rate-limit.js";
import { extractBuzzSecret } from "../social/code.js";
import { createAuthStore } from "./auth-store.js";

/** Email, recovery-code and lost-code attempts. Shared by every request. */
export const ACCOUNT_LIMIT = { limit: 10, windowMs: 10 * 60_000 };

/**
 * What a person typed back to the secret that is hashed. Accepts the recovery code as before: the
 * XXXX-XXXX-XXXX form (any case or spacing), and a pasted Flic URL or curl line for accounts whose
 * recovery code is still the buzz token. Empty input is null.
 */
export function normalizeRecovery(input: string): string | null {
  const secret = extractBuzzSecret(input);
  return secret === "" ? null : secret;
}

/** The kit's Auth for one request. The links point at PUBLIC_BASE_URL, else the request's own (validated) origin. */
export function accountsFor(deps: AppDeps, req: http.IncomingMessage, limiter: RateLimiter): Auth {
  const origin = requestOrigin(req, deps.config);
  return createAuth({
    store: createAuthStore(deps.db),
    mailer: deps.mailer,
    limiter,
    appName: "Hangry",
    now: deps.now,
    normalize: normalizeRecovery,
    revokeOtherSessions: true,
    linkUrl: (kind, token) => `${origin}/${kind === "verify" ? "verify" : "recover"}#t=${token}`,
  });
}
