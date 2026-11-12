import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getPlan, getPlanByShareId, planCircleForUser, setPlanShareId, type PlanRow } from "../db.js";
import { shortDate } from "../lib/time.js";

/** Same copy for an ended, a deleted, a revoked and an unknown link, so a guess learns nothing. */
export const ENDED_COPY = "This link no longer works";

/** What anyone with the link may see. No place, pin, people, chat or push status. */
export type SharePreview =
  | { ended: true }
  | {
      ended: false;
      note: string;
      whenLabel: string;
      time: string | null;
      circleName?: string;
      member: boolean;
      planId?: string;
      circleId?: string;
    };

const SHARE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** 18 random bytes, 24 url-safe characters. Never the plan id. */
export function newShareId(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function isOpenPlan(plan: PlanRow, today: string): boolean {
  return plan.ended_at == null && plan.for_date >= today;
}

/** Gives the plan a share id on first use and keeps it after that. */
export function ensureShareId(db: DatabaseSync, planId: string): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = getPlan(db, planId)?.share_id;
    if (existing) return existing;
    try {
      const id = setPlanShareId(db, planId, newShareId());
      if (id) return id;
    } catch (error) {
      if (!(error instanceof Error && /UNIQUE/i.test(error.message)) || attempt === 4) throw error;
    }
  }
  throw new Error("could not make a share link");
}

/** The open plan behind a link, or nothing for a bad, unknown or ended one. */
export function openSharedPlan(db: DatabaseSync, shareId: string, today: string): PlanRow | undefined {
  if (!SHARE_ID_RE.test(shareId)) return undefined;
  const plan = getPlanByShareId(db, shareId);
  if (!plan || !isOpenPlan(plan, today)) return undefined;
  return plan;
}

export function sharePreview(db: DatabaseSync, shareId: string, viewerId: string | null, today: string): SharePreview {
  const plan = openSharedPlan(db, shareId, today);
  if (!plan) return { ended: true };
  const base = {
    ended: false as const,
    note: plan.note,
    whenLabel: shortDate(plan.for_date, today),
    time: plan.at_time,
  };
  // The viewer's own linked circle: home if they are in it, else the first linked one they are in.
  const circle = viewerId ? planCircleForUser(db, plan.id, viewerId) : undefined;
  if (!circle) return { ...base, member: false };
  return { ...base, member: true, circleName: circle.name, planId: plan.id, circleId: circle.id };
}

/** Link-preview text: the note, then an absolute day ("Fri 7 Nov") and time. Read later, so never Today/Tomorrow. */
export function shareMeta(plan: PlanRow | undefined, today: string): { title: string; description: string } {
  if (!plan) return { title: ENDED_COPY, description: "Hangry" };
  const day = shortDate(plan.for_date, today);
  return { title: plan.note, description: plan.at_time ? `${day} · ${plan.at_time}` : day };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** index.html with Open Graph tags for WhatsApp and Signal. It still boots the app. */
export function shareHtml(template: string, meta: { title: string; description: string }, url: string, origin: string): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const tags = [
    `<title>${title} · Hangry</title>`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Hangry" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:image" content="${escapeHtml(`${origin}/icons/icon-512.png`)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${escapeHtml(`${origin}/icons/icon-512.png`)}" />`,
  ].join("\n    ");
  // A function replacer, so "$&" in a note stays literal text.
  return template
    .replace(/<meta name="description"[^>]*>\s*/, () => "")
    .replace(/<title>[^<]*<\/title>/, () => tags);
}
