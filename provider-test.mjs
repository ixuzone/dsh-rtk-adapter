import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform === 'win32') {
	console.log('SKIP: the provider test uses POSIX shell fixtures');
	process.exit(0);
}
let dsh;
try {
	dsh = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim());
} catch {
	console.log('SKIP: dsh is not on PATH');
	process.exit(0);
}
const requireFromDsh = createRequire(dsh);
const load = (name) => import(pathToFileURL(requireFromDsh.resolve(`@deepseek-ai/${name}`)).href);
const [{ Context }, { LocalSubprocessRuntime }] = await Promise.all([
	load('cordis').then((module) => ({ Context: module.Context })),
	load('dsh-subprocess-local').then((module) => ({ LocalSubprocessRuntime: module.default }))
]);

const root = mkdtempSync(join(tmpdir(), 'dsh-rtk-provider-'));
const shim = (name, body) => {
	const file = join(root, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
};
const ok = shim('ok.sh', "printf 'rtk git status\\n'");
const no = shim('no.sh', "printf 'No rewrite for: %s\\n' \"$4\" >&2; exit 1");
const noisy = shim('noisy.sh', "printf 'warning: test\\n' >&2; printf 'rtk git status\\n'");
const large = shim('large.sh', "head -c 70000 /dev/zero | tr '\\0' 'x'; printf '\\n'");
const slow = shim('slow.sh', 'echo $$ > "$SHIM_PID"\nexec sleep 30');
const pluginURL = new URL('./index.js', import.meta.url).href;
let caseId = 0;

async function makeTool(bin) {
	process.env.RTK_BIN = bin;
	const app = new Context();
	await app.plugin(LocalSubprocessRuntime);
	let tool;
	app.provide('tools', { register(value) { tool = value; return () => {}; } });
	app.provide('systemPrompt', { section: () => () => {}, getSectionOrder: () => 1000 });
	app.provide('workingDirectory', { ensure: async () => process.cwd() });
	await app.plugin(await import(`${pluginURL}?provider=${++caseId}`));
	return tool;
}

async function waitForFile(file) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			readFileSync(file);
			return true;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	return false;
}

async function waitDead(pid) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

try {
	const normal = await makeTool(ok);
	assert.deepEqual(
		await normal.execute({ command: 'git status' }, { signal: new AbortController().signal }),
		{ command: 'rtk git status', rewritten: true }
	);
	const noMatch = await makeTool(no);
	assert.deepEqual(
		await noMatch.execute({ command: 'echo hi' }, { signal: new AbortController().signal }),
		{ command: 'echo hi', rewritten: false }
	);
	console.log('PASS provider: normal rewrite and no-match');

	const warning = await makeTool(noisy);
	assert.deepEqual(
		await warning.execute({ command: 'git status' }, { signal: new AbortController().signal }),
		{ command: 'rtk git status', rewritten: true }
	);
	console.log('PASS provider: stderr is ignored');

	const oversized = await makeTool(large);
	assert.deepEqual(
		await oversized.execute({ command: 'git status' }, { signal: new AbortController().signal }),
		{ command: 'git status', rewritten: false }
	);
	console.log('PASS provider: >64 KiB output falls back to the original');

	const missing = await makeTool(join(root, 'does-not-exist'));
	assert.deepEqual(
		await missing.execute({ command: 'git status' }, { signal: new AbortController().signal }),
		{ command: 'git status', rewritten: false }
	);
	console.log('PASS provider: missing executable falls back');

	process.env.SHIM_PID = join(root, 'timeout.pid');
	const timeout = await makeTool(slow);
	const started = Date.now();
	const timedOut = await timeout.execute({ command: 'git status' }, { signal: new AbortController().signal });
	const timeoutMs = Date.now() - started;
	assert.deepEqual(timedOut, { command: 'git status', rewritten: false });
	assert(timeoutMs >= 4500 && timeoutMs < 10000, `timeout took ${timeoutMs}ms`);
	const timedOutPid = Number(readFileSync(process.env.SHIM_PID, 'utf8').trim());
	assert(await waitDead(timedOutPid), 'timed-out probe must be dead');
	console.log(`PASS provider: 5s timeout (${timeoutMs}ms), probe terminated`);

	process.env.SHIM_PID = join(root, 'cancel.pid');
	const cancellable = await makeTool(slow);
	const cancellation = new AbortController();
	const pending = cancellable.execute({ command: 'git status' }, { signal: cancellation.signal });
	assert(await waitForFile(process.env.SHIM_PID), 'the cancellation probe must start');
	cancellation.abort(new Error('test user cancelled'));
	await assert.rejects(pending, /test user cancelled/);
	const cancelledPid = Number(readFileSync(process.env.SHIM_PID, 'utf8').trim());
	assert(await waitDead(cancelledPid), 'cancelled probe must be dead');
	console.log('PASS provider: cancellation propagates and terminates the probe');
} finally {
	rmSync(root, { recursive: true, force: true });
}
