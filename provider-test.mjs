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
	writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'rtk 1.0.1\\n'; exit 0; fi\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
};
// rtk 1.x: 3 = rewrite, defer approval; 0 = rewrite, allow-covered.
const ok = shim('ok.sh', "printf 'rtk git status\\n'; exit 3");
const allow = shim('allow.sh', "printf 'rtk git status\\n'; exit 0");
const no = shim('no.sh', 'exit 1');
const deny = shim('deny.sh', "printf 'diagnostic noise\\n' >&2; exit 2");
const denySilent = shim('deny-silent.sh', 'exit 2');
const noisy = shim('noisy.sh', "printf 'warning: test\\n' >&2; printf 'rtk git status\\n'; exit 3");
const large = shim('large.sh', "head -c 70000 /dev/zero | tr '\\0' 'x'; printf '\\n'; exit 3");
const slow = shim('slow.sh', 'echo $$ > "$SHIM_PID"\nexec sleep 30');
const legacy = (() => {
	const file = join(root, 'legacy.sh');
	writeFileSync(file, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'rtk 0.20.0\\n'; exit 0; fi\nexit 2\n");
	chmodSync(file, 0o755);
	return file;
})();
const pluginURL = new URL('./index.js', import.meta.url).href;
let caseId = 0;

/**
 * One shared subprocess runtime for every case: each `LocalSubprocessRuntime`
 * instance registers process-level exit listeners, so building one per case
 * leaks them. The plugin module captures `RTK_BIN` at import, so each case
 * still gets a fresh plugin copy through the cache-busting query.
 */
let app;
let currentTool;

async function toolFor(bin) {
	process.env.RTK_BIN = bin;
	if (app === undefined) {
		app = new Context();
		await app.plugin(LocalSubprocessRuntime);
		app.provide('tools', { register(value) { currentTool = value; return () => {}; } });
		app.provide('systemPrompt', { section: () => () => {}, getSectionOrder: () => 1000 });
		app.provide('workingDirectory', { ensure: async () => process.cwd() });
	}
	await app.plugin(await import(`${pluginURL}?provider=${++caseId}`));
	return currentTool;
}

const runTool = async (bin, command) => {
	const tool = await toolFor(bin);
	return await tool.execute({ command }, { signal: new AbortController().signal });
};

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
	assert.deepEqual(await runTool(ok, 'git status'), { command: 'rtk git status', rewritten: true });
	console.log('PASS provider: exit 3 rewrite');

	assert.deepEqual(await runTool(allow, 'git status'), { command: 'rtk git status', rewritten: true });
	console.log('PASS provider: exit 0 rewrite (allow-covered semantics)');

	assert.deepEqual(await runTool(no, 'echo hi'), { command: 'echo hi', rewritten: false });
	console.log('PASS provider: exit 1 no-match');

	// Exit 2 is a denial on its own; the stderr text is never the reason.
	assert.deepEqual(await runTool(deny, 'rm -rf /tmp/x'), {
		command: 'rm -rf /tmp/x',
		rewritten: false,
		denial: 'rtk denied this command'
	});
	console.log('PASS provider: exit 2 is a policy denial (fixed reason, stderr ignored)');

	assert.deepEqual(await runTool(denySilent, 'rm -rf /tmp/x'), {
		command: 'rm -rf /tmp/x',
		rewritten: false,
		denial: 'rtk denied this command'
	});
	console.log('PASS provider: exit 2 without stderr still denies');

	assert.deepEqual(await runTool(noisy, 'git status'), { command: 'rtk git status', rewritten: true });
	console.log('PASS provider: stderr noise is ignored for rewrites');

	assert.deepEqual(await runTool(large, 'git status'), { command: 'git status', rewritten: false });
	console.log('PASS provider: >64 KiB output falls back to the original');

	assert.deepEqual(await runTool(join(root, 'does-not-exist'), 'git status'), {
		command: 'git status',
		rewritten: false
	});
	console.log('PASS provider: missing executable falls back');

	// rtk 1.x only: an older binary exits 2 for `rewrite` (unknown subcommand)
	// but must never be reported as a policy denial.
	assert.deepEqual(await runTool(legacy, 'git status'), { command: 'git status', rewritten: false });
	console.log('PASS provider: rtk < 1 is unsupported, never a denial');

	process.env.SHIM_PID = join(root, 'timeout.pid');
	const started = Date.now();
	const timedOut = await runTool(slow, 'git status');
	const timeoutMs = Date.now() - started;
	assert.deepEqual(timedOut, { command: 'git status', rewritten: false });
	assert(timeoutMs >= 4500 && timeoutMs < 10000, `timeout took ${timeoutMs}ms`);
	const timedOutPid = Number(readFileSync(process.env.SHIM_PID, 'utf8').trim());
	assert(await waitDead(timedOutPid), 'timed-out probe must be dead');
	console.log(`PASS provider: 5s timeout (${timeoutMs}ms), probe terminated`);

	process.env.SHIM_PID = join(root, 'cancel.pid');
	const cancelTool = await toolFor(slow);
	const cancellation = new AbortController();
	const pending = cancelTool.execute({ command: 'git status' }, { signal: cancellation.signal });
	assert(await waitForFile(process.env.SHIM_PID), 'the cancellation probe must start');
	cancellation.abort(new Error('test user cancelled'));
	await assert.rejects(pending, /test user cancelled/);
	const cancelledPid = Number(readFileSync(process.env.SHIM_PID, 'utf8').trim());
	assert(await waitDead(cancelledPid), 'cancelled probe must be dead');
	console.log('PASS provider: cancellation propagates and terminates the probe');
} finally {
	await app?.dispose?.();
	rmSync(root, { recursive: true, force: true });
}
