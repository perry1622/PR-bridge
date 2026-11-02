import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function ensureBridge(bridgeUrl) {
  const url = new URL(bridgeUrl);
  async function check() {
    let response;
    try { response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(700) }); }
    catch { return false; }
    let health;
    try { health = await response.json(); } catch { throw new Error("Bridge port is occupied by a different service."); }
    if (!response.ok || health.service !== "PR-bridge" || health.protocol !== 2) {
      throw new Error("Bridge port is occupied by an old or different service. Stop that service manually before starting PR-bridge.");
    }
    return true;
  }
  if (await check()) return;
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Cannot auto-start a non-local bridge.");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./bridge-server.mjs", import.meta.url))], {
    detached: true, windowsHide: true, stdio: "ignore",
    env: { ...process.env, FIGMA_BRIDGE_PORT: url.port || "80" },
  });
  let launchError;
  child.on("error", error => { launchError = error; });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (launchError) throw launchError;
    await delay(100);
    if (await check()) return;
  }
  throw new Error("PR-bridge did not start. Run start-bridge.ps1 to see diagnostics.");
}
