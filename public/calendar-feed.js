/**
 * Which "add the calendar feed" actions fit this device. Pure, so it can be tested.
 * Only Apple devices have a calendar app that reliably opens webcal:// links.
 * Android has no webcal handler by default, and the Google Calendar app cannot
 * subscribe to a URL at all; that only works on calendar.google.com on a computer.
 */

/** @typedef {"apple" | "android" | "other"} CalendarPlatform */

/**
 * iPadOS reports itself as a Mac (with touch points), and a real Mac opens webcal:// in
 * Calendar too, so both count as Apple and touch points do not change the answer.
 * @param {string} [userAgent]
 * @returns {CalendarPlatform}
 */
export function calendarPlatform(userAgent = "") {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod|macintosh/i.test(userAgent)) return "apple";
  return "other";
}

/**
 * Short, honest steps shown under the buttons. None of them claim that copying subscribes.
 * @param {CalendarPlatform} platform
 * @returns {string[]}
 */
export function calendarFeedSteps(platform) {
  if (platform === "apple") {
    return [
      "If nothing opens, go to Settings, Apps, Calendar, Calendar Accounts, Add Account, Other, Add Subscribed Calendar and paste the link.",
    ];
  }
  if (platform === "android") {
    return [
      "Google Calendar can only add a feed on a computer: open calendar.google.com, next to Other calendars tap +, choose From URL and paste the link. It then shows up in the Calendar app on your phone.",
      "Other calendar apps: look for Add calendar from URL or Subscribe.",
    ];
  }
  return [
    "Google Calendar on a computer: next to Other calendars click +, choose From URL and paste the link.",
    "Outlook: Add calendar, Subscribe from web, paste the link.",
    "Apple Calendar: Add Subscribed Calendar, paste the link.",
  ];
}
