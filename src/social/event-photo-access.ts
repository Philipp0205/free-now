import type { DatabaseSync } from "node:sqlite";
import { type PlanRow, type SocialRow, getPlan, getSocial, listCirclesForUser, planCircleForUser } from "../db.js";
import { type EventKind, canSeeEvent } from "./visibility.js";

type EventRow = SocialRow | PlanRow;

/**
 * Whether this person may see an event's cover photo: a member of its circle (any linked circle for a plan)
 * who may also see the event itself. canSeeEvent alone says yes to anyone for a public event, so membership is checked here.
 */
export function canViewEventPhoto(db: DatabaseSync, kind: EventKind, event: EventRow, viewerId: string | null): boolean {
  if (viewerId === null) return false;
  if (!canSeeEvent(db, kind, event, viewerId)) return false;
  if (kind === "plan") return Boolean(planCircleForUser(db, event.id, viewerId));
  return listCirclesForUser(db, viewerId).some((circle) => circle.id === (event as SocialRow).circle_id);
}

/** `photoRev` for a payload, only when there is a photo and this viewer may see it. Otherwise nothing, so the field never leaks. */
export function photoField(db: DatabaseSync, kind: EventKind, event: EventRow, viewerId: string | null): { photoRev?: number } {
  if (!event.photo_rev || !canViewEventPhoto(db, kind, event, viewerId)) return {};
  return { photoRev: event.photo_rev };
}

/** The event row, or undefined when it does not exist. */
export function loadEvent(db: DatabaseSync, kind: EventKind, id: string): EventRow | undefined {
  return kind === "social" ? getSocial(db, id) : getPlan(db, id);
}
