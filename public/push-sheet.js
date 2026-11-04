/** Heading for the push sheet. */
export function pushTitle(kind, item) {
  return item?.note || (kind === "plan" ? "Plan" : "Free now");
}

/**
 * The open push sheet against fresh poll data.
 * Returns the updated detail, or null when nothing changed or the event is gone
 * (ended or deleted). Null leaves the sheet showing what it had.
 */
export function nextPushDetail(detail, socials, plans) {
  if (!detail || !detail.id) return null;
  const list = detail.kind === "plan" ? plans : socials;
  if (!Array.isArray(list)) return null;
  const item = list.find((entry) => entry?.id === detail.id);
  if (!item?.push || !Array.isArray(item.push.people)) return null;
  const next = { ...detail, title: pushTitle(detail.kind, item), push: item.push };
  if (JSON.stringify([next.title, next.push]) === JSON.stringify([detail.title, detail.push])) return null;
  return next;
}
