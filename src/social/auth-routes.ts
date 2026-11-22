import type { AppDeps } from "../app.js";
import { colorHex } from "../chat/chat-color.js";
import { addMember, getActiveSocialByCreator, getBuzzCircles, getUserByBuzzToken, getUserById, listCirclesForUser, markSocialBuzzed } from "../db.js";
import { accountsFor } from "../accounts/accounts.js";
import { clientKey } from "../lib/client-key.js";
import type { RouteContext } from "../lib/context.js";
import { HttpError, matchPath, safeDecode, sendEmpty, sendJson } from "../lib/http.js";
import { isoDate } from "../lib/time.js";
import { cleanCode, cleanLabel, cleanNote, readPlace, readPoint, readStart } from "../lib/validate.js";
import { BUZZ_PRESSES, circlePayload, notifyMemberJoined, requireCircle, requireLiveInvite } from "./circles.js";
import { footMassageEgg } from "./easter-egg.js";
import { endSocial } from "./events.js";
import { sharePreview } from "./plan-share.js";
import { publishSocial } from "./socials.js";

export async function handleAuthRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, deps, limits, url, method, pathname, user, body, requested } = ctx;
  if (method === "POST" && pathname === "/api/auth/start") {
    const name = cleanLabel(body.name, "name", 24);
    const email = typeof body.email === "string" ? body.email : "";
    const now = deps.now();
    const rawCode = body.code == null || body.code === "" ? "" : cleanCode(body.code);
    const invited = rawCode ? requireLiveInvite(deps.db, rawCode, now) : undefined;
    const created = await accountsFor(deps, req, limits.accounts).signup({ name, email });
    if (!created.ok) throw new HttpError(400, "enter a valid email");
    const id = created.user.id;
    const { token } = await accountsFor(deps, req, limits.accounts).startSession(id);
    if (invited) {
      addMember(deps.db, invited.id, id, now);
      await notifyMemberJoined(deps, invited, { id, name });
    }
    const row = getUserById(deps.db, id);
    sendJson(res, 201, {
      token,
      recoveryCode: created.recoveryCode,
      buzzToken: row?.buzz_token,
      user: {
        id,
        name,
        color: colorHex(id, row?.color),
        avatarRev: null,
        whatsNewSeen: null,
        email: created.user.email,
        emailVerifiedAt: null,
      },
      circle: invited ? circlePayload(deps, req, invited, id) : null,
    });
    return true;
  }

  const sharedPlan = matchPath(pathname, /^\/api\/plans\/share\/([^/]+)$/);
  if (sharedPlan && method === "GET") {
    if (!limits.share.hit(clientKey(req), deps.now())) throw new HttpError(429, "too many requests");
    const today = isoDate(deps.now(), deps.config.tz);
    sendJson(res, 200, sharePreview(deps.db, safeDecode(sharedPlan[1]), user?.id ?? null, today, deps.now()));
    return true;
  }

  const invitePreview = matchPath(pathname, /^\/api\/invites\/([^/]+)$/);
  if (invitePreview && method === "GET") {
    const circle = requireLiveInvite(deps.db, decodeURIComponent(invitePreview[1]), deps.now());
    sendJson(res, 200, { name: circle.name });
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/recover") {
    const login = await accountsFor(deps, req, limits.accounts).loginByCode({
      code: typeof body.token === "string" ? body.token : "",
      ip: clientKey(req),
    });
    if (!login.ok) {
      if (login.reason === "rate_limited") throw new HttpError(429, "too many attempts, try again later");
      throw new HttpError(401, "unknown recovery code");
    }
    const existing = getUserById(deps.db, login.user.id);
    sendJson(res, 200, {
      token: login.token,
      buzzToken: existing?.buzz_token,
      user: {
        id: login.user.id,
        name: login.user.name,
        color: colorHex(login.user.id, existing?.color),
        avatarRev: existing?.avatar_rev || null,
        email: login.user.email,
        emailVerifiedAt: login.user.emailVerifiedAt,
      },
    });
    return true;
  }

  // The link in the mail opens a page that posts the token from its fragment. A GET never consumes it.
  if (method === "POST" && pathname === "/api/auth/verify") {
    const result = await accountsFor(deps, req, limits.accounts).verifyEmail(typeof body.token === "string" ? body.token : "");
    if (!result.ok) {
      throw new HttpError(400, result.reason === "email_taken" ? "that email is already confirmed on another account" : "link is no longer valid");
    }
    sendJson(res, 200, { email: result.user.email, emailVerifiedAt: result.user.emailVerifiedAt });
    return true;
  }

  // Always the same answer, whether or not the address belongs to anyone.
  if (method === "POST" && pathname === "/api/auth/lost-code") {
    const result = await accountsFor(deps, req, limits.accounts).requestLostCode({
      email: typeof body.email === "string" ? body.email : "",
      ip: clientKey(req),
    });
    if (!result.ok) throw new HttpError(429, "too many attempts, try again later");
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/lost-code/consume") {
    const result = await accountsFor(deps, req, limits.accounts).consumeLostCode(typeof body.token === "string" ? body.token : "");
    if (!result.ok) throw new HttpError(400, "link is no longer valid");
    const row = getUserById(deps.db, result.user.id);
    sendJson(res, 200, {
      token: result.token,
      recoveryCode: result.recoveryCode,
      buzzToken: row?.buzz_token,
      user: {
        id: result.user.id,
        name: result.user.name,
        color: colorHex(result.user.id, row?.color),
        avatarRev: row?.avatar_rev || null,
        email: result.user.email,
        emailVerifiedAt: result.user.emailVerifiedAt,
      },
    });
    return true;
  }

  if (pathname.startsWith("/api/buzz/")) {
    if (method !== "POST" && method !== "DELETE") throw new HttpError(405, "method not allowed");
    let token = pathname.slice("/api/buzz/".length);
    try {
      token = decodeURIComponent(token);
    } catch {
      throw new HttpError(404, "unknown token");
    }
    const buzzer = token ? getUserByBuzzToken(deps.db, token) : undefined;
    if (!buzzer) throw new HttpError(404, "unknown token");
    const press = url.searchParams.get("press") ?? "single";
    if (!(BUZZ_PRESSES as readonly string[]).includes(press)) throw new HttpError(400, "press must be single, double or hold");
    // An explicit ?circle= wins, then the circle mapped to this press, then the default circle.
    // A mapped circle the user has left is rejected by requireCircle, never swapped for another.
    const target = requested ?? getBuzzCircles(deps.db, buzzer.id)[press] ?? buzzCircle(deps, buzzer.id);
    if (method === "DELETE") {
      // Ends the social in the circle a POST of the same press would post to.
      // Ending with nothing live is still a success, so a second hold is harmless.
      const circle = requireCircle(deps, buzzer.id, target);
      const live = getActiveSocialByCreator(deps.db, buzzer.id, circle.id, deps.now());
      if (live) await endSocial(deps, buzzer, live.id, circle.id);
      sendEmpty(res, 204);
      return true;
    }
    if (press === "hold") {
      const plan = await footMassageEgg(deps, buzzer);
      if (plan) {
        sendJson(res, 201, { plan });
        return true;
      }
    }
    // A bare buzz keeps the live note. Only a note field in the body replaces it.
    const note = Object.prototype.hasOwnProperty.call(body, "note") ? cleanNote(body.note, false) : undefined;
    const result = await publishSocial(deps, buzzer, note, readPoint(body), readPlace(body), readStart(body, deps.now(), deps.config.tz), target);
    // Marks the social as Flic-driven on every press, a re-notify of a live one included.
    const buzzedAt = deps.now();
    markSocialBuzzed(deps.db, result.social.id, buzzedAt);
    sendJson(res, result.created ? 201 : 200, { social: { ...result.social, buzzedAt } });
    return true;
  }
  return false;
}

/** A buzz with no circle posts to the circle joined last, so the bare link still works. */
function buzzCircle(deps: AppDeps, userId: string): string | null {
  const circles = listCirclesForUser(deps.db, userId);
  if (circles.length <= 1) return null;
  return circles[circles.length - 1].id;
}
