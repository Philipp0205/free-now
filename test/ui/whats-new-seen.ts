import fs from "node:fs";
import type { BrowserContext } from "playwright-core";

const ENTRIES = JSON.parse(
  fs.readFileSync(new URL("../../public/whats-new.json", import.meta.url), "utf8"),
) as Array<{ id: string }>;

/** Newest What's new id in the shipped changelog. */
export const LATEST_WHATS_NEW = ENTRIES[0]?.id ?? "";

/**
 * Specs that sign people up through the API start with nothing seen, so the What's new popup
 * would cover the screen they test. This marks the changelog as read on every page of the context.
 */
export async function skipWhatsNew(context: BrowserContext): Promise<void> {
  await context.addInitScript((id) => {
    if (id) localStorage.setItem("fn_whats_new_seen", id);
  }, LATEST_WHATS_NEW);
}
