import type { DatabaseSync } from "node:sqlite";
import { type EventKind, type JoinRow, listEventPaid } from "../db.js";
import { formatCents, paypalAmountUrl, visiblePaymentUrls, visibleWeroEmails } from "../lib/payment-url.js";

/** The parts of a plan or social the payment rules need. */
export type PayEvent = {
  id: string;
  creator_id: string;
  creator_name: string;
  price_cents: number | null;
  collector_id: string | null;
};

export type Going = { id: string; name: string };

/** Same set as isInReply in events.ts, kept here so payload.ts does not import events.ts. */
function isGoingReply(reply: string | null | undefined): boolean {
  return reply === "coming" || reply === "join" || reply === "in";
}

/** The organizer first, then everyone who said they are in. Blocked guests are already out of the joins. */
export function goingPeople(event: PayEvent, joins: JoinRow[]): Going[] {
  const people: Going[] = [{ id: event.creator_id, name: event.creator_name }];
  for (const join of joins) {
    if (join.id !== event.creator_id && isGoingReply(join.reply)) people.push({ id: join.id, name: join.name });
  }
  return people;
}

/** The stored collector while they are still the organizer or going, else the organizer. */
export function effectiveCollectorId(event: Pick<PayEvent, "creator_id" | "collector_id">, going: Going[]): string {
  const stored = event.collector_id;
  if (stored && going.some((person) => person.id === stored)) return stored;
  return event.creator_id;
}

/** The organizer, the collector, or the person themselves may tick a row. */
export function canSetPaid(actorId: string, creatorId: string, collectorId: string, targetId: string): boolean {
  return actorId === creatorId || actorId === collectorId || actorId === targetId;
}

/** A new collector is the organizer, or a going member who has already paid. */
export function canBeCollector(candidateId: string, creatorId: string, going: Going[], paidIds: Set<string>): boolean {
  if (candidateId === creatorId) return true;
  return going.some((person) => person.id === candidateId) && paidIds.has(candidateId);
}

export type PaymentPayload = {
  priceCents: number;
  amount: string;
  currency: "EUR";
  collector: { id: string; name: string; paypalUrl: string | null; weroEmail: string | null };
  members: Array<{
    id: string;
    name: string;
    collector: boolean;
    paid: boolean;
    setBy: string | null;
    setByName: string | null;
    at: number | null;
  }>;
};

/** Null when the event has no price. Payment links follow the same circle visibility as the rest of the payload. */
export function paymentPayload(
  db: DatabaseSync,
  kind: EventKind,
  event: PayEvent,
  joins: JoinRow[],
  viewerId: string | null,
): PaymentPayload | null {
  if (event.price_cents == null) return null;
  const going = goingPeople(event, joins);
  const collectorId = effectiveCollectorId(event, going);
  const collector = going.find((person) => person.id === collectorId) ?? going[0];
  const paid = new Map(listEventPaid(db, kind, event.id).map((row) => [row.user_id, row]));
  const links = visiblePaymentUrls(db, viewerId);
  const weros = visibleWeroEmails(db, viewerId);
  return {
    priceCents: event.price_cents,
    amount: formatCents(event.price_cents),
    currency: "EUR",
    collector: {
      id: collector.id,
      name: collector.name,
      paypalUrl: paypalAmountUrl(links.get(collector.id), event.price_cents),
      weroEmail: weros.get(collector.id) ?? null,
    },
    members: going.map((person) => {
      const row = paid.get(person.id);
      return {
        id: person.id,
        name: person.name,
        collector: person.id === collectorId,
        paid: Boolean(row),
        setBy: row?.set_by ?? null,
        setByName: row?.set_by_name ?? null,
        at: row?.set_at ?? null,
      };
    }),
  };
}
