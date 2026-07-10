// Dev orchestrator: starts the API server (port 4114) and the vite dev
// server (port 5173, proxying /api -> 4114) with one `bun run dev`.

const root = new URL("..", import.meta.url).pathname;

const children = [
  Bun.spawn(["bun", "src/server/index.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  }),
  Bun.spawn(["bunx", "vite", "--port", "5173"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  }),
];

function shutdown() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // already dead
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// If either process exits, tear the other down too.
await Promise.race(children.map((c) => c.exited));
shutdown();
