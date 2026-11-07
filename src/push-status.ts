import type { DatabaseSync } from "node:sqlite";
import { colorHex } from "./chat-color.js";
import {
  isCircleAdmin,
  latestPushBatch,
  listMembers,
  listPlanCircleIds,
  listPushBatch,
  listReachFlags,
  type PushBatchRow,
  type ReachFlags,
} from "./db.js";

/** Active subscription, or why a push cannot land. "not_installed" only after a browser session and never a standalone one. */
export type Reach = "on" | "off" | "not_installed";

/** "not_sent": notifications are on, but this event has no delivery row for them (older event, joined later, or not pushed). */
export type PushPersonStatus = "delivered" | "sent" | "failed" | "not_sent" | "off" | "not_installed";

export type PushPerson = {
  id: string;
  name: string;
  color: string;
  avatarRev: number | null;
  status: PushPersonStatus;
  httpStatus: number | null;
  /** Plans only: the linked circles, of those the viewer may see, this person is in. */
  circleIds?: string[];
};

export type PushSummary = {
  delivered: number;
  total: number;
  people: PushPerson[];
};

export function reachOf(flags: ReachFlags): Reach {
  if (flags.subs > 0) return "on";
  if (flags.pushSeenAt) return "off";
  if (flags.displayAt && !flags.standaloneAt) return "not_installed";
  return "off";
}

export function reachForCircle(db: DatabaseSync, circleId: string): Map<string, Reach> {
  const map = new Map<string, Reach>();
  for (const row of listReachFlags(db, circleId)) map.set(row.id, reachOf(row));
  return map;
}

/** One status per member for the latest send of this event. Delivered wins over sent, sent over failed. */
export function statusFor(rows: PushBatchRow[], reach: Reach): PushPersonStatus {
  if (rows.some((row) => row.status === "delivered")) return "delivered";
  if (rows.some((row) => row.status === "sent")) return "sent";
  if (rows.some((row) => row.status === "failed")) return "failed";
  if (reach === "on") return "not_sent";
  if (reach === "not_installed") return "not_installed";
  return "off";
}

export function summarizePush(
  db: DatabaseSync,
  circleId: string,
  kind: string,
  refId: string,
  hostId: string,
): PushSummary {
  const members = listMembers(db, circleId).filter((member) => member.id !== hostId);
  const reach = reachForCircle(db, circleId);
  const batch = latestPushBatch(db, circleId, kind, refId);
  const rows = batch ? listPushBatch(db, batch) : [];
  const byUser = new Map<string, PushBatchRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id);
    if (list) list.push(row);
    else byUser.set(row.user_id, [row]);
  }
  const people = members.map((member) => {
    const mine = byUser.get(member.id) ?? [];
    const status = statusFor(mine, reach.get(member.id) ?? "off");
    const failed = mine.find((row) => row.status === "failed" && row.http_status != null);
    return {
      id: member.id,
      name: member.name,
      color: colorHex(member.id, member.color),
      avatarRev: member.avatar_rev || null,
      status,
      httpStatus: status === "failed" ? (failed?.http_status ?? null) : null,
    };
  });
  return {
    delivered: people.filter((person) => person.status === "delivered").length,
    total: people.length,
    people,
  };
}

/**
 * A plan's roster across every circle it is linked to, one row per person.
 * The host sees each linked circle they are still in. Anyone else sees only the linked circles they admin.
 * Status is the best row across the latest "plan" batch of each linked circle (home send and share notices).
 */
export function pushSummaryForPlan(
  db: DatabaseSync,
  planId: string,
  hostId: string,
  viewerId: string | null,
): PushSummary | undefined {
  if (!viewerId) return undefined;
  const linked = listPlanCircleIds(db, planId);
  const byUser = new Map<string, PushBatchRow[]>();
  for (const circleId of linked) {
    const batch = latestPushBatch(db, circleId, "plan", planId);
    for (const row of batch ? listPushBatch(db, batch) : []) {
      const list = byUser.get(row.user_id);
      if (list) list.push(row);
      else byUser.set(row.user_id, [row]);
    }
  }
  const people = new Map<string, PushPerson & { circleIds: string[] }>();
  let visible = 0;
  for (const circleId of linked) {
    const members = listMembers(db, circleId);
    const viewer = members.find((member) => member.id === viewerId);
    if (!viewer || (viewerId !== hostId && !viewer.is_admin)) continue;
    visible += 1;
    const reach = reachForCircle(db, circleId);
    for (const member of members) {
      if (member.id === hostId) continue;
      const seen = people.get(member.id);
      if (seen) {
        seen.circleIds.push(circleId);
        continue;
      }
      const mine = byUser.get(member.id) ?? [];
      const status = statusFor(mine, reach.get(member.id) ?? "off");
      const failed = mine.find((row) => row.status === "failed" && row.http_status != null);
      people.set(member.id, {
        id: member.id,
        name: member.name,
        color: colorHex(member.id, member.color),
        avatarRev: member.avatar_rev || null,
        status,
        httpStatus: status === "failed" ? (failed?.http_status ?? null) : null,
        circleIds: [circleId],
      });
    }
  }
  if (!visible) return undefined;
  const list = [...people.values()];
  return {
    delivered: list.filter((person) => person.status === "delivered").length,
    total: list.length,
    people: list,
  };
}

/** Host of the event, or an admin of its circle. Everyone else gets nothing. */
export function pushSummaryForViewer(
  db: DatabaseSync,
  circleId: string,
  kind: string,
  refId: string,
  hostId: string,
  viewerId: string | null,
): PushSummary | undefined {
  if (!viewerId) return undefined;
  if (viewerId !== hostId && !isCircleAdmin(db, circleId, viewerId)) return undefined;
  return summarizePush(db, circleId, kind, refId, hostId);
}
