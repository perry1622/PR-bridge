import { ensureBridge } from "./ensure-bridge.mjs";
try {
  const url = process.env.FIGMA_BRIDGE_URL || "http://127.0.0.1:38471";
  await ensureBridge(url);
  console.log(`PR-bridge ready: ${url}. Multiple Agents share this background service.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
