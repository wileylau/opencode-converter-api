#!/usr/bin/env node
/**
 * Dev launcher: starts `wrangler dev` on the first free port, starting at 8787
 * (or the PORT env var). wrangler itself hard-fails on a busy port, so we probe
 * with a throwaway listener first, then hand the chosen port over.
 */
import net from "node:net";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const START_PORT = Number(process.env.PORT) || 8787;
const MAX_TRIES = 10;

function isFree(port) {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));
		probe.once("listening", () => probe.close(() => resolve(true)));
		probe.listen(port, "127.0.0.1");
	});
}

let port = null;
for (let p = START_PORT; p < START_PORT + MAX_TRIES; p++) {
	if (await isFree(p)) {
		port = p;
		break;
	}
}

if (port === null) {
	console.error(`✘ No free port found in ${START_PORT}–${START_PORT + MAX_TRIES - 1}. Free one up or set PORT=<port>.`);
	process.exit(1);
}

if (port !== START_PORT) {
	console.log(`ℹ Port ${START_PORT} is in use — starting on http://localhost:${port} instead.`);
}

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");

const child = spawn(process.execPath, [wranglerBin, "dev", "--port", String(port)], {
	stdio: "inherit",
	env: process.env,
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
