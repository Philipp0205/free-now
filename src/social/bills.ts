import type { DatabaseSync } from "node:sqlite";
import {
  type EventKind,
  listCirclesForUser,
  listPlanJoins,
  listPricedPlans,
  listPricedSocials,
  listSocialJoins,
} from "../db.js";
import { formatCents } from "../lib/payment-url.js";
import { isoDate } from "../lib/time.js";
import { planPayload, socialPayload } from "./payload.js";
import { type PaymentPayload, paymentPayload } from "./payments.js";

/** What one priced event means for one viewer. Null when it does not touch them. */
export type BillShare =
  | { side: "owe"; cents: number }
  | { side: "owed"; cents: number; unpaid: Array<{ id: string; name: string }> };

/**
 * "Owe": the viewer is going, is not the collector and has not paid.
 * "Owed": the viewer is the effective collector and somebody else going has not paid.
 * Settled events and events the viewer is not part of give null.
 */
export function billShare(payment: PaymentPayload | null, viewerId: string): BillShare | null {
  if (!payment) return null;
  const mine = payment.members.find((member) => member.id === viewerId);
  if (!mine) return null;
  if (!mine.collector) return mine.paid ? null : { side: "owe", cents: payment.priceCents };
  const unpaid = payment.members.filter((member) => !member.collector && !member.paid).map((member) => ({ id: member.id, name: member.name }));
  if (!unpaid.length) return null;
  return { side: "owed", cents: unpaid.length * payment.priceCents, unpaid };
}

export type BillItem = {
  kind: EventKind;
  id: string;
  title: string;
  day: string;
  /** A circle the viewer is in that holds the event, for the paid endpoints. */
  circleId: string;
  circleName: string;
  priceCents: number;
  cents: number;
  amount: string;
  collector: { id: string; name: string };
  unpaid: Array<{ id: string; name: string }>;
  event: unknown;
};

export type Bills = {
  currency: "EUR";
  owe: BillItem[];
  owed: BillItem[];
  totals: { oweCents: number; owedCents: number; owe: string; owed: string };
};

type Candidate = { kind: EventKind; id: string; day: string; circleId: string; circleName: string };

function newestFirst(a: BillItem, b: BillItem): number {
  if (a.day !== b.day) return a.day < b.day ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every priced event across the viewer's circles, past ones included, split into what they owe and what they are owed. */
export function loadBills(db: DatabaseSync, viewerId: string, now: number, today: string, tz: string): Bills {
  const owe: BillItem[] = [];
  const owed: BillItem[] = [];
  const seen = new Set<string>();
  for (const circle of listCirclesForUser(db, viewerId)) {
    for (const row of listPricedSocials(db, circle.id)) {
      const key = `social:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const payment = paymentPayload(db, "social", row, listSocialJoins(db, row.id), viewerId);
      const share = billShare(payment, viewerId);
      if (!payment || !share) continue;
      const candidate: Candidate = { kind: "social", id: row.id, day: isoDate(row.starts_at ?? row.created_at, tz), circleId: circle.id, circleName: circle.name };
      (share.side === "owe" ? owe : owed).push(item(candidate, row.note, "Free now", payment, share, socialPayload(db, row, viewerId, now)));
    }
    for (const row of listPricedPlans(db, circle.id)) {
      const key = `plan:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const payment = paymentPayload(db, "plan", row, listPlanJoins(db, row.id), viewerId);
      const share = billShare(payment, viewerId);
      if (!payment || !share) continue;
      const candidate: Candidate = { kind: "plan", id: row.id, day: row.for_date, circleId: circle.id, circleName: circle.name };
      (share.side === "owe" ? owe : owed).push(item(candidate, row.note, "Plan", payment, share, planPayload(db, row, today, viewerId, now)));
    }
  }
  owe.sort(newestFirst);
  owed.sort(newestFirst);
  const oweCents = owe.reduce((sum, bill) => sum + bill.cents, 0);
  const owedCents = owed.reduce((sum, bill) => sum + bill.cents, 0);
  return { currency: "EUR", owe, owed, totals: { oweCents, owedCents, owe: formatCents(oweCents), owed: formatCents(owedCents) } };
}

function item(candidate: Candidate, note: string | null, fallback: string, payment: PaymentPayload, share: BillShare, event: unknown): BillItem {
  return {
    kind: candidate.kind,
    id: candidate.id,
    title: note?.trim() || fallback,
    day: candidate.day,
    circleId: candidate.circleId,
    circleName: candidate.circleName,
    priceCents: payment.priceCents,
    cents: share.cents,
    amount: formatCents(share.cents),
    collector: { id: payment.collector.id, name: payment.collector.name },
    unpaid: share.side === "owed" ? share.unpaid : [],
    event,
  };
}
