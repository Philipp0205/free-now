import { generateVapidKeys } from "./push.js";

const keys = generateVapidKeys();
console.log("Add these to the environment (Railway variables, or a local .env):");
console.log("");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
console.log("");
console.log("VAPID_SUBJECT must be a mailto: or https: URL. It is sent to push services with each notification.");
