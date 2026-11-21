/** Pure rule for the buzz sound. No DOM, and no imports. */

/** True when the buzz was pressed by another member: both ids are known and differ. */
export function isFromOtherMember(social, meId) {
  const creatorId = social && social.creator && social.creator.id;
  return Boolean(creatorId) && Boolean(meId) && creatorId !== meId;
}
