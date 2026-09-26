#!/usr/bin/env node
/**
 * resolve-session.js — resolve a pi session NAME to its session file path.
 *
 * Usage: node resolve-session.js <name>
 *
 * Prints the matching session file path to stdout, or nothing if the argument
 * looks like a path/session-ID (pi handles those natively) or no name matches.
 *
 * Matching tiers (most recent file wins within a tier):
 *   1. exact name match (case-insensitive)
 *   2. name starts with the query
 *   3. name contains the query
 * The current project directory (--Users-jey-Development-Pi-Workspace--) is
 * scanned first and wins ties.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const arg = process.argv[2];
if (!arg) process.exit(0);

// Let pi handle paths and (partial) session IDs natively
if (arg.includes("/") || /^[0-9a-f]{8}(-[0-9a-f]{4}){0,3}(-[0-9a-f]{12})?$/i.test(arg)) {
	process.exit(0);
}

const root = path.join(os.homedir(), ".pi", "agent", "sessions");
// Sessions are stored one directory per project: cwd with "/" replaced by "-"
const PROJECT_DIR = "--" + "/Users/jey/Development/Pi Workspace".replaceAll("/", "-");

function extractName(file) {
	// Find the LAST session_info entry (renames override earlier names)
	let name;
	try {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		for (const line of lines) {
			if (!line.includes('"session_info"')) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
			} catch {
				/* skip malformed line */
			}
		}
	} catch {
		return undefined;
	}
	return name;
}

function scanAllDirs() {
	const out = [];
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const isProject = entry.name === PROJECT_DIR;
		out.push(...scanDir(path.join(root, entry.name), isProject));
	}
	return out;
}

function scanDir(dir, isProject) {
	const out = [];
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const file = path.join(dir, entry);
		const name = extractName(file);
		if (name) out.push({ file, name, mtime: fs.statSync(file).mtimeMs, isProject });
	}
	return out;
}

const candidates = scanAllDirs();

const q = arg.toLowerCase();
const tier = (name) => {
	const n = name.toLowerCase();
	if (n === q) return 3;
	if (n.startsWith(q)) return 2;
	if (n.includes(q)) return 1;
	return 0;
};

let best = null;
for (const c of candidates) {
	const t = tier(c.name);
	if (t === 0) continue;
	const score = t * 2 + (c.isProject ? 1 : 0);
	if (!best || score > best.score || (score === best.score && c.mtime > best.mtime)) {
		best = { ...c, score };
	}
}

if (best) {
	console.log(best.file);
}
