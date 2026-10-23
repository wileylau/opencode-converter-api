#!/usr/bin/env node
/**
 * Dev launcher: starts `wrangler dev` on the first free port, starting at 8787
 * (or the PORT env var). wrangler itself hard-fails on a busy port, so we probe
 * with a throwaway listener first, then hand the chosen port over.
 */
import net from "node:net";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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

const ID_RE = /^[-\w.]{8,128}$/;
const PROJECT_FILE = join(process.cwd(), ".wrangler", "opencode-converter-project-id");

/** `OPENCODE_INSTALLED` overrides detection; otherwise probe PATH. */
function opencodeInstalled() {
	const forced = process.env.OPENCODE_INSTALLED;
	if (forced !== undefined) return /^(1|true|yes)$/i.test(forced.trim());
	const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { stdio: "ignore" });
	return probe.status === 0;
}

/** Read the proxy's persisted project id, creating it once. */
function ensureProjectId() {
	const configured = process.env.OPENCODE_PROJECT_ID?.trim();
	if (configured && ID_RE.test(configured)) return configured;
	try {
		const existing = readFileSync(PROJECT_FILE, "utf8").trim();
		if (ID_RE.test(existing)) return existing;
	} catch {
		/* first run */
	}
	const id = randomUUID();
	mkdirSync(dirname(PROJECT_FILE), { recursive: true });
	writeFileSync(PROJECT_FILE, `${id}\n`);
	return id;
}

const args = [wranglerBin, "dev", "--port", String(port)];
if (opencodeInstalled()) {
	const projectId = ensureProjectId();
	args.push("--var", "OPENCODE_INSTALLED:1", "--var", `OPENCODE_PROJECT_ID:${projectId}`);
	console.log(`opencode detected — proxy project ${projectId}`);
}

const child = spawn(process.execPath, args, {
	stdio: "inherit",
	env: process.env,
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
