import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { type Mailer, resendMailer } from "../app-kit/mailer.ts";

/**
 * Resend when RESEND_API_KEY and MAIL_FROM are set. MAIL_LOG_PATH (dev only) appends each mail as a
 * JSON line instead. With neither, undefined: signup and lost-code send nothing and say nothing.
 */
export function createMailer(config: Config): Mailer | undefined {
  if (config.resendApiKey && config.mailFrom) {
    return resendMailer({ apiKey: config.resendApiKey, from: config.mailFrom });
  }
  if (config.mailLogPath) {
    const file = config.mailLogPath;
    return {
      async send(message) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...message })}\n`);
      },
    };
  }
  console.warn("Email is off (no RESEND_API_KEY and MAIL_FROM): confirm and lost-code links are not sent");
  return undefined;
}
