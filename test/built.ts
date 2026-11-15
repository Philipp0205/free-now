import fs from "node:fs";

/** The client `npm run build` writes. Tests that read the built worker or bundle need it. */
export const CLIENT = new URL("../dist/client/", import.meta.url);

export function readBuilt(file: string): string {
  if (!fs.existsSync(new URL(file, CLIENT))) throw new Error(`dist/client/${file} is missing. Run npm run build first.`);
  return fs.readFileSync(new URL(file, CLIENT), "utf8");
}

/** The index.html the server answers `/` with: the built one when dist/client exists, else the source. */
export function servedIndex(): string {
  const built = new URL("index.html", CLIENT);
  return fs.readFileSync(fs.existsSync(built) ? built : new URL("../public/index.html", import.meta.url), "utf8");
}

/** Every URL the built service worker precaches, as paths from the site root ("/" for the app shell). */
export function builtPrecache(): string[] {
  const sw = readBuilt("sw.js");
  const urls = [...sw.matchAll(/"url":"([^"]+)"/g)].map((match) => match[1]);
  if (urls.length === 0) throw new Error("no precache manifest found in dist/client/sw.js");
  return urls.map((url) => (url.startsWith("/") ? url : `/${url}`));
}
