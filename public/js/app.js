import { state } from "./state.js";
import { refreshPins, rememberViewerLocation, warmMap } from "./map-card.js";
import { adoptCircle, api, clearSession, friendlyMessage, noteConnectionProblem, pollRefresh, refresh, rememberCircle, restoreCachedState, scheduleOfflineRetry } from "./session.js";
import { bindKeyboard } from "./keyboard-ui.js";
import { render } from "./render.js";
import { checkGoogleReturn, landCalendar } from "./calendar-sync.js";
import { resolveShareLink } from "./plan-share.js";
import { considerReminders, noteInviteJoin, reportDisplay } from "./push-install.js";
import { scheduleErrorClear } from "./lib.js";
import { checkForUpdate, initAppUpdates } from "./app-update.js";
import { requestReminder, stepReminder } from "./payment-reminder-ui.js";

/** The build label. Sent with feedback so a report names the build it came from. */
export const APP_VERSION = "hangry-v130";

// The kit keeps the browser bar colour equal to the page background, and follows scheme and width changes.
window.AppKit?.themeColor?.start({ media: ["(max-width: 719px)"] });

// Registers the worker, and reloads into a new build when one takes over and nothing unsent would be lost.
initAppUpdates(() => state);

boot();
setInterval(() => {
  // A later buzzer turns live, and a live one ends, without a new answer from the server.
  if (!document.hidden && state.me?.user && state.me.user.email !== null) refreshPins();
  // A payment reminder that was waiting for another sheet to close gets its turn.
  if (!document.hidden) stepReminder();
  if (!document.hidden && state.token) {
    pollRefresh().catch((error) => {
      if (error?.status === 401) return;
      noteConnectionProblem(error);
      render();
    });
  }
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  refresh().catch(() => {});
  void checkGoogleReturn();
  // Only the worker check is throttled (about once a minute). The data refresh above runs every time.
  void checkForUpdate();
  // Coming back may show the payment reminder. It skips itself inside the throttle window.
  requestReminder();
});

/* iOS Safari only applies :active press styles once the page listens for touches. Passive, so scrolling is untouched. */
document.addEventListener("touchstart", () => {}, { passive: true });

render();

async function boot() {
  try {
    state.meta = await api("/api/meta", { token: null });
    if (state.pendingCode) {
      try {
        state.invitePreview = await api(`/api/invites/${state.pendingCode}`, { token: null });
      } catch (error) {
        state.inviteError = error.status === 410 ? "expired" : "invalid";
      }
    }
    if (state.token) {
      try {
        state.me = await api("/api/me");
      } catch (error) {
        if (error.status === 404 && state.circleId) {
          rememberCircle("");
          state.me = await api("/api/me");
        } else if (error.status !== 401) throw error;
        else clearSession();
      }
    }
    if (state.me) adoptCircle(state.me);
    if (state.shareLink) await resolveShareLink();
    if (state.token && state.me && state.me.user.email !== null && state.pendingCode && !state.inviteError) {
      try {
        const joined = await api("/api/circles/join", { method: "POST", body: { code: state.pendingCode } });
        rememberCircle(joined.circle.id);
        state.me = await api("/api/me");
        history.replaceState(null, "", "/");
        state.pendingCode = "";
        noteInviteJoin();
      } catch (error) {
        state.error = error.message;
      }
    }
  } catch (error) {
    if (state.token && error.status !== 401) {
      restoreCachedState();
      noteConnectionProblem(error);
      scheduleOfflineRetry(1000);
    } else {
      state.error = friendlyMessage(error.message, error.status);
    }
  } finally {
    state.booting = false;
    if (state.me && !state.me.circle && state.circleDraft === "friends") {
      state.circleDraft = `${state.me.user.name}'s circle`;
    }
    landCalendar();
    render();
    scheduleErrorClear();
    if (!state.offline && state.me?.user?.email !== null) {
      reportDisplay();
      refresh({ initial: true }).catch(() => {});
      rememberViewerLocation();
      void considerReminders();
      // Cold start: the payment reminder waits for the bills and for any install or push step ahead of it.
      requestReminder();
      // The map and its header load in the background, so the Map tab opens without a wait.
      if (state.me?.user) warmMap();
    }
    if (state.focusSocial) history.replaceState(null, "", "/");
  }
}

bindKeyboard();
