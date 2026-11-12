import { consumeBuzz, buzzerPlaying, playBuzzer, nextBuzzIndex } from "./buzzer.js";
import { state } from "./state.js";
import { api } from "./session.js";
import { render } from "./render.js";
import { copyText, el, run } from "./lib.js";

/**
 * Plays the full-screen buzzer for a fresh Flic press in state.socials. The seen marker always
 * moves up, so a hidden page or a busy overlay skips the buzz without replaying it later. The
 * overlay lives outside the app root, and nothing here may break refresh().
 */
export function noteBuzz() {
  try {
    const buzz = consumeBuzz(state.socials, localStorage);
    if (!buzz || document.hidden || buzzerPlaying()) return;
    playBuzzer({ name: buzz.name, animation: nextBuzzIndex(localStorage) });
  } catch {
    /* the overlay is a nicety */
  }
}

/** The Test buzzer button: plays the next animation here. Nothing is sent. */
function testBuzzer() {
  try {
    if (buzzerPlaying()) return;
    playBuzzer({ name: state.me.user.name, animation: nextBuzzIndex(localStorage) });
  } catch {
    /* the overlay is a nicety */
  }
}

export function buzzNote(code) {
  const circles = state.me?.circles || [];
  const current = state.me?.circle;
  if (circles.length < 2 || !current) return null;
  const last = circles[circles.length - 1];
  const link = `${location.origin}/api/buzz/${encodeURIComponent(code)}?circle=${encodeURIComponent(current.id)}`;
  return el("div", {}, [
    el("p", {
      class: "help",
      text: `This link posts to ${current.name}. A buzz with only the code posts to ${last.name}.`,
    }),
    el("p", { class: "code-block", text: link }),
  ]);
}

export function flicPanel(code) {
  const circles = state.me?.circles || [];
  const current = state.me?.circle;
  // With more than one circle the link names the circle on screen, like buzzNote.
  const aimed = circles.length > 1 && current;
  const link = `${location.origin}/api/buzz/${encodeURIComponent(code)}${aimed ? `?circle=${encodeURIComponent(current.id)}` : ""}`;
  return el("div", { class: "panel" }, [
    el("button", {
      class: "text-btn",
      type: "button",
      text: state.showButton ? "Hide button setup" : "Set up a Flic button",
      onclick: () => {
        state.showButton = !state.showButton;
        render();
      },
    }),
    state.showButton
      ? el("div", {}, [
          el("p", {
            class: "help",
            text: aimed
              ? `One press tells ${current.name} you're free now.`
              : "One press tells your circle you're free now.",
          }),
          el("pre", { class: "curl", text: link }),
          el("ol", { class: "guide-reenable" }, [
            "In the Flic app, open your button and choose Push.",
            "Add the Internet Request action.",
            "Paste this link as the URL, set the method to POST, and save.",
            "Optional: add the same link under Hold with the method DELETE. Holding the button then ends your social.",
          ].map((line) => el("li", { text: line }))),
          el("p", {
            class: "help",
            style: "margin-top: 12px",
            text: "Keep this link private. It contains your recovery code, and anyone with it can post as you.",
          }),
          el("div", { class: "stack" }, [
            el("button", {
              class: "btn secondary",
              type: "button",
              text: "Copy link",
              onclick: () => copyText(link, "Button link copied"),
            }),
            el("button", {
              class: "btn secondary",
              type: "button",
              text: "Test buzzer",
              onclick: testBuzzer,
            }),
            el("p", { class: "help", style: "margin: 0", text: "Plays the next buzzer animation here. Nothing is sent." }),
          ]),
        ])
      : null,
  ]);
}

export async function onRotateBuzz() {
  state.confirm = {
    title: "New secret?",
    body: "The old buzzer and recovery code will stop working.",
    confirmLabel: "Regenerate",
    action: async () => {
      await run(async () => {
        const data = await api("/api/me/buzz-token", { method: "POST", body: {} });
        state.me = { ...state.me, user: { ...state.me.user, buzzToken: data.buzzToken } };
        state.error = "New secret ready";
      });
    },
  };
  render();
}
