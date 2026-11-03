/** Minimum bottom occlusion treated as a soft keyboard, not browser chrome. */
export const KEYBOARD_OFFSET_MIN = 80;

/** How far the visual viewport must shrink before a touch UI counts as a keyboard. */
export const KEYBOARD_SHRINK_MIN = 120;

/** Wait for the keyboard animation before scrolling the focused field into view. */
export const FIELD_REVEAL_MS = 400;

/**
 * Pixels between the layout viewport's bottom and the visual viewport's bottom.
 * `innerHeight - visualViewport.height - visualViewport.offsetTop`, clamped at 0.
 * This is 0 when the layout viewport already resized with the keyboard.
 */
export function keyboardOffset(layoutHeight, viewportHeight, offsetTop = 0) {
  const offset = Number(layoutHeight) - Number(viewportHeight) - Number(offsetTop);
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.round(offset));
}

/**
 * Whether a soft keyboard is covering the bottom of the screen.
 * VirtualKeyboard height is optional. The visual viewport math works without it.
 * The shrink heuristic is touch-only so a desktop window resize does not count.
 */
export function keyboardIsOpen({
  offset,
  focused,
  restingHeight,
  viewportHeight,
  virtualKeyboardHeight = 0,
  touchUi = false,
}) {
  if (offset >= KEYBOARD_OFFSET_MIN) return true;
  if (touchUi && virtualKeyboardHeight >= KEYBOARD_OFFSET_MIN) return true;
  if (!touchUi || !focused) return false;
  const resting = Number(restingHeight);
  const height = Number(viewportHeight);
  if (!Number.isFinite(resting) || !Number.isFinite(height)) return false;
  return resting - height >= KEYBOARD_SHRINK_MIN;
}

/**
 * The bottom nav overlaps the keyboard when it intersects the occluded band,
 * or when a touch keyboard already resized the layout and the bar is flush
 * with the new bottom edge.
 */
export function tabbarOverlapsKeyboard({
  barTop,
  barBottom,
  layoutHeight,
  offset,
  shrunk,
  virtualKeyboardTop = null,
  virtualKeyboardBottom = null,
}) {
  if (barTop == null || barBottom == null) return false;
  if (offset >= KEYBOARD_OFFSET_MIN && barBottom > layoutHeight - offset && barTop < layoutHeight) return true;
  if (shrunk >= KEYBOARD_SHRINK_MIN && barBottom >= layoutHeight - 2 && barTop < layoutHeight) return true;
  if (virtualKeyboardTop == null || virtualKeyboardBottom == null) return false;
  if (virtualKeyboardBottom - virtualKeyboardTop < KEYBOARD_OFFSET_MIN) return false;
  return virtualKeyboardTop < barBottom && virtualKeyboardBottom > barTop;
}
