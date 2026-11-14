import { routeChat } from "./chat.js";
import { cleanAppVersion } from "../admin/feedback.js";
import type { AuthedRouteContext } from "../lib/context.js";
import { clientKey } from "../lib/client-key.js";
import { sendEmpty, sendJson } from "../lib/http.js";

export async function handleChatRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { req, res, deps, limits, method, pathname, body, requested, me } = ctx;
  // A @Goblin mention files feedback, so it shares the feedback form's limiter and version label.
  const ask = { appVersion: cleanAppVersion(body.appVersion), allow: () => limits.feedback.hit(clientKey(req), deps.now()) };
  const chat = await routeChat(deps, me, method, pathname, body, requested, ask);
  if (chat) {
    if (chat.body == null) sendEmpty(res, chat.status);
    else sendJson(res, chat.status, chat.body);
    return true;
  }
  return false;
}
