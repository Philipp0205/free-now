/** Words for the plan card color palette on the Plan and Edit sheets. */
export const CARD_COLOR_COPY = {
  label: "Card color",
  group: "Card color",
  auto: "Auto",
  autoName: "Automatic color",
  /** Name of one swatch for screen readers, like "Color 3 of 14". */
  slotName: (slot, total) => `Color ${slot + 1} of ${total}`,
};
