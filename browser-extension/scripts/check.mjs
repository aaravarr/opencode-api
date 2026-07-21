import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = [
  "background.js",
  "google-login.js",
  "popup.js",
  "options.js",
  "lib/config.js",
  "lib/connector.js",
  "lib/state.js",
];

JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
for (const file of scripts) {
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(`../${file}`, import.meta.url))], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Browser extension manifest and scripts are valid.");
