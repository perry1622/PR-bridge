import { createBridgeServer } from "./bridge-core.mjs";
const port = Number(process.env.FIGMA_BRIDGE_PORT || 38471);
const server = createBridgeServer();
server.on("error", async error => {
  if (error.code === "EADDRINUSE") {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const health = await response.json();
      if (health.service === "PR-bridge" && health.protocol === 2) {
        console.log(`PR-bridge already running on ${port}; reusing shared service.`);
        return;
      }
    } catch {}
  }
  console.error(`PR-bridge cannot start on ${port}: ${error.message}. Existing services were not stopped.`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => console.log(`PR-bridge listening on http://127.0.0.1:${port}`));
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
