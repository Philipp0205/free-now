import type { AppDeps } from "../app.js";
import { listCirclesForUser, listPlansOnDays, type UserRow } from "../db.js";
import { addDays, isoDate, zonedDateTime } from "../lib/time.js";
import { planPayload } from "./payload.js";
import { publishPlan } from "./plans.js";

const NOTE = "Foot massage 💆";
const CLOCK = "20:00";
const CIRCLE = "amanda & philipp";

/** The plan payload when the egg fired, otherwise null and the buzz carries on as usual. */
export async function footMassageEgg(deps: AppDeps, buzzer: UserRow) {
  const id = deps.config.footMassageUserId;
  if (!id || id !== buzzer.id) return null;
  const circle = listCirclesForUser(deps.db, buzzer.id).find((row) => row.name.trim().toLowerCase() === CIRCLE);
  if (!circle) return null;
  const now = deps.now();
  const tz = deps.config.tz;
  const today = isoDate(now, tz);
  const forDate = now < zonedDateTime(today, CLOCK, tz) ? today : addDays(today, 1);
  // No await between this check and the insert inside publishPlan, so a double press makes one plan.
  const existing = listPlansOnDays(deps.db, circle.id, forDate, forDate).find(
    (plan) => plan.note === NOTE && plan.at_time === CLOCK && plan.ended_at == null,
  );
  if (existing) return planPayload(deps.db, existing, today, buzzer.id, now);
  return publishPlan(deps, buzzer, NOTE, "", null, CLOCK, circle.id, forDate);
}
