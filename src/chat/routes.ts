import { routeChat } from "./chat.js";
import type { AuthedRouteContext } from "../lib/context.js";
import { sendEmpty, sendJson } from "../lib/http.js";

export async function handleChatRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { res, deps, method, pathname, body, requested, me } = ctx;
  const chat = await routeChat(deps, me, method, pathname, body, requested);
  if (chat) {
    if (chat.body == null) sendEmpty(res, chat.status);
    else sendJson(res, chat.status, chat.body);
    return true;
  }
  return false;
}
