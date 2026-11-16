import type { AppDeps } from "../app.js";
import { colorHex } from "../chat/chat-color.js";
import { getPlanReply, getSocialReply, listPastPlans, listPastSocials, listPlanJoins, listSocialJoins } from "../db.js";
import { visiblePaymentUrls } from "../lib/payment-url.js";
import { addDays, clockLabel, isoDate } from "../lib/time.js";
import { isInReply } from "./events.js";
import { type PersonStatus, visibleStatuses } from "./status.js";

type PastEvent = {
  kind: "social" | "plan";
  id: string;
  note: string;
  day: string;
  at: number;
  time: string;
  place: string;
  host: { id: string; name: string; color: string; avatarRev: number | null; status: PersonStatus | null; paymentUrl: string | null };
  people: Array<{ id: string; name: string; color: string; avatarRev: number | null; status: PersonStatus | null; paymentUrl: string | null; arriveAt: number | null }>;
};

export function pastDays(deps: AppDeps, circleId: string, viewerId: string) {
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  const statuses = visibleStatuses(deps.db, viewerId, now);
  const payments = visiblePaymentUrls(deps.db, viewerId);
  const events: PastEvent[] = [];
  for (const social of listPastSocials(deps.db, circleId, now)) {
    if (getSocialReply(deps.db, social.id, viewerId)?.blocked) continue;
    const at = social.starts_at ?? social.created_at;
    events.push({
      kind: "social",
      id: social.id,
      note: social.note,
      day: isoDate(at, deps.config.tz),
      at,
      time: clockLabel(at, deps.config.tz),
      place: social.place ?? "",
      host: { id: social.creator_id, name: social.creator_name, color: colorHex(social.creator_id, social.creator_color), avatarRev: social.creator_avatar_rev || null, status: statuses.get(social.creator_id) ?? null, paymentUrl: payments.get(social.creator_id) ?? null },
      people: listSocialJoins(deps.db, social.id)
        .filter((join) => isInReply(join.reply))
        .map((join) => ({ id: join.id, name: join.name, color: colorHex(join.id, join.color), avatarRev: join.avatar_rev || null, status: statuses.get(join.id) ?? null, paymentUrl: payments.get(join.id) ?? null, arriveAt: join.arrive_at })),
    });
  }
  for (const plan of listPastPlans(deps.db, circleId, today)) {
    if (getPlanReply(deps.db, plan.id, viewerId)?.blocked) continue;
    const at = plan.ended_at ?? plan.created_at;
    const day = plan.for_date < today ? plan.for_date : isoDate(at, deps.config.tz);
    events.push({
      kind: "plan",
      id: plan.id,
      note: plan.note,
      day,
      at,
      time: plan.at_time ?? "",
      place: plan.place ?? "",
      host: { id: plan.creator_id, name: plan.creator_name, color: colorHex(plan.creator_id, plan.creator_color), avatarRev: plan.creator_avatar_rev || null, status: statuses.get(plan.creator_id) ?? null, paymentUrl: payments.get(plan.creator_id) ?? null },
      people: listPlanJoins(deps.db, plan.id)
        .filter((join) => isInReply(join.reply))
        .map((join) => ({ id: join.id, name: join.name, color: colorHex(join.id, join.color), avatarRev: join.avatar_rev || null, status: statuses.get(join.id) ?? null, paymentUrl: payments.get(join.id) ?? null, arriveAt: join.arrive_at })),
    });
  }
  events.sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at || b.id.localeCompare(a.id));
  const days: Array<{ day: string; label: string; events: PastEvent[] }> = [];
  for (const event of events) {
    const last = days.at(-1);
    if (!last || last.day !== event.day) {
      days.push({ day: event.day, label: pastDayLabel(event.day, today), events: [event] });
    } else last.events.push(event);
  }
  return days;
}

function pastDayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date} ${names[month - 1] ?? ""}`.trim();
}
