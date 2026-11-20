import { readCompactHome } from "./compact-home.js";

export const TOKEN_KEY = "fn_token";
export const CIRCLE_KEY = "fn_circle";
export const MAP_ALL_KEY = "hangry-map-all";
/**
 * The Events tab (formerly Map) shows the month calendar or the map: "calendar" (default) or "map".
 * v2: the old "hangry-events-view" key is ignored, so everyone lands on Calendar once.
 */
export const EVENTS_VIEW_KEY = "hangry-events-view-v2";
export const SHARE_KEY = "fn_share_location";
export const INSTALLED_KEY = "fn_installed";
export const INSTALL_LATER_KEY = "fn_install_later";
/** Set once the install step after joining a circle was closed, so it never comes back. */
export const JOIN_INSTALL_KEY = "fn_join_install_done";
/** Set when the person turned notifications off here, so we do not nag them to turn them back on. */
export const PUSH_OFF_KEY = "hangry.pushOff";

export const FEEDBACK_MAX = 2000;

export const state = {
  booting: true,
  token: localStorage.getItem(TOKEN_KEY),
  meta: null,
  me: null,
  socials: [],
  plans: [],
  /** Map scope: true shows every circle's places, false only the selected circle. */
  mapAllCircles: localStorage.getItem(MAP_ALL_KEY) === "1",
  mapSocials: [],
  mapPlans: [],
  /** Now tab: true lists events as one compact line each, false as cards. Saved per device. */
  compactHome: readCompactHome(),
  /** Events tab: "calendar" or "map". Same circle scope (mapAllCircles) for both. */
  eventsView: readEventsView(),
  /** First of the month the calendar shows, and the picked day. Set on first show. */
  calMonth: "",
  calDay: "",
  /** The month's events, kept apart from Home and the map. calendarKey names what is loaded. */
  calendarPlans: [],
  calendarSocials: [],
  calendarKey: "",
  calendarLoading: false,
  notifications: [],
  tab: "home",
  sheet: null,
  pushDetail: null,
  noteDraft: "",
  nameDraft: "",
  circleDraft: "friends",
  codeDraft: "",
  emailDraft: "",
  /** The lost code form on the welcome screen: open, and whether the link was asked for. */
  lostOpen: false,
  lostSent: false,
  /** A fresh recovery code, shown once in a card until the person says they saved it. */
  recoveryOnce: "",
  /** The page behind an emailed link: { kind: "verify" | "recover", token, busy, done, error }. */
  linkFlow: null,
  pendingCode: "",
  error: "",
  banner: null,
  bannerTimer: 0,
  confirm: null,
  latestNotifId: null,
  bootstrappedNotifs: false,
  focusSheet: false,
  installEvent: null,
  installOpen: false,
  pushBusy: false,
  pushReminder: null,
  pushSnooze: false,
  installSheet: false,
  installSteps: false,
  remindersChecked: false,
  joinInstall: false,
  installPillHidden: false,
  onboarding: false,
  pushOn: false,
  shareLocation: localStorage.getItem(SHARE_KEY) === "1",
  placeDraft: "",
  planTime: "",
  planDraft: { description: "" },
  planDay: "tomorrow",
  planDate: "",
  planWhere: emptyWhereSession(),
  viewerLocation: null,
  mapCenter: null,
  mapCard: null,
  where: emptyWhere(),
  whereOpen: false,
  whereQuery: "",
  whereAutofill: false,
  whereResults: [],
  whereSearching: false,
  whereStatus: "",
  whereHint: "",
  whereMap: false,
  focusSocial: "",
  deepLink: null,
  statusMessage: "",
  whereArea: "",
  whereFallback: "",
  invitePreview: null,
  inviteError: "",
  whenMode: "now",
  startChoice: "",
  chat: null,
  openDescriptions: new Set(),
  chatQueue: null,
  chatThread: null,
  chatReturn: "home",
  alertsReturn: "home",
  chatDraft: "",
  chatStick: false,
  /** Open @ autocomplete in the composer: { start, query, index }. */
  chatMention: null,
  /** Message id whose quick-reaction bar is open. */
  chatReactFor: null,
  /** Pill whose names are showing after a long-press: { id, emoji }. */
  chatWho: null,
  /** Message the composer is replying to: { id, name, text, mine, color }. */
  chatReplyTo: null,
  /** The open GIF sheet: { reply, from, status, gifs, message }. Null when closed. It counts as an overlay for Back. */
  chatGif: null,
  chatSummary: { circle: { unread: 0, muted: false }, events: [], unreadByCircle: {} },
  past: false,
  pastDays: null,
  circleId: localStorage.getItem(CIRCLE_KEY) || "",
  circleMenu: false,
  cardMenu: null,
  /** In toggle the person just tapped: { key, on, startedAt, until }. Drives the one-off pop. */
  inPop: null,
  eventDetail: null,
  arrivalPick: null,
  shareCircles: null,
  newCircleName: "",
  whatsNew: null,
  whatsNewView: null,
  whatsNewChecked: false,
  feedbackDraft: "",
  feedbackError: "",
  feedbackBusy: false,
  /** Calendar feed on the You tab: { loaded, active, createdAt, url, webcalUrl, busy }. url is set only right after making one. */
  calendarFeed: null,
  /** Calendar availability on the You tab: syncStatus from the server plus { loaded, busy, draft, error }. */
  calendarSync: null,
  /** "See what friends see" on the Availability & calendar screen: { open, loaded, data, error, busy }. data is the preview from the server. */
  busyPreview: null,
  /** Assistant tokens on the You tab: { loaded, failed, tokens, busy, draft, secret }. secret is set only right after making one. */
  agentTokens: null,
  /** Open bills on the You tab: { loaded, loading, failed, stale, at, owe, owed, totals }. Null until first asked. */
  bills: null,
  /** Open You sub-screen: null (the menu) or one of YOU_SECTIONS ids. */
  youSection: null,
  /** Busy people at a later time on the create sheet: { at, people: [{ id, state, until }] }. */
  busyAt: null,
  /** The "I'm in" tap waiting on the owner's own calendar for that day. */
  calendarCheckBusy: "",
  feedbackSent: false,
};

export const FINDING_PLACE = "Finding address…";

function readEventsView() {
  try {
    return localStorage.getItem(EVENTS_VIEW_KEY) === "map" ? "map" : "calendar";
  } catch {
    return "calendar";
  }
}

export function emptyWhere() {
  return { mode: "none", place: "", lat: null, lng: null, precise: false };
}

export function emptyWhereSession() {
  return {
    where: emptyWhere(),
    whereOpen: false,
    whereQuery: "",
    whereAutofill: false,
    whereResults: [],
    whereSearching: false,
    whereStatus: "",
    whereHint: "",
    whereMap: false,
    whereArea: "",
    whereFallback: "",
  };
}
