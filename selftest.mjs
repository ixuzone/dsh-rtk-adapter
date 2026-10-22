import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import * as plugin from './index.js';

const cwd = process.cwd();
const tools = [];
let section;
let lastSpec;
let spawns = 0;
let currentCwd = cwd;
let behavior;

function reset(next = {}) {
	behavior = {
		code: 0,
		stdout: '',
		lossy: false,
		missing: false,
		spawnError: undefined,
		doneError: undefined,
		ensureError: undefined,
		waitForAbort: false,
		terminateCalls: 0,
		...next
	};
	lastSpec = undefined;
	spawns = 0;
}

reset();
const ctx = {
	systemPrompt: {
		section(value) { section = value; },
		getSectionOrder: () => 1000
	},
	tools: {
		register(tool) { tools.push(tool); }
	},
	workingDirectory: {
		ensure: async () => {
			if (behavior.ensureError) throw behavior.ensureError;
			return currentCwd;
		}
	},
	subprocess: {
		resolveExecutable: async () => {
			if (behavior.missing) throw new Error('rtk not installed');
			return 'rtk';
		},
		spawn(spec) {
			lastSpec = spec;
			spawns += 1;
			if (behavior.spawnError) throw behavior.spawnError;
			const handle = {
				done: behavior.doneError
					? Promise.reject(behavior.doneError)
					: Promise.resolve({ exitCode: behavior.code }),
				collected: { stdout: { readFrom: () => ({ text: behavior.stdout, lossy: behavior.lossy }) } },
				terminate() { behavior.terminateCalls += 1; }
			};
			if (behavior.waitForAbort) {
				handle.done = new Promise((resolveDone) => {
					if (spec.signal.aborted) resolveDone({ exitCode: null });
					else spec.signal.addEventListener('abort', () => resolveDone({ exitCode: null }), { once: true });
				});
			}
			return handle;
		}
	}
};

plugin.apply(ctx);
assert.equal(tools.length, 1);
const tool = tools[0];
const exec = () => ({ agent: {}, signal: AbortSignal.timeout(60000) });
const call = (command, { workdir, signal } = {}) => tool.execute(
	workdir === undefined ? { command } : { command, workdir },
	{ agent: {}, signal: signal ?? AbortSignal.timeout(60000) }
);

// Tool contract and guidance registration.
assert.equal(tool.name, 'rtk_rewrite');
assert.equal(typeof tool.execute, 'function');
assert(!plugin.inject.includes('shell'));
assert.equal(section.name, 'rtk:guidance');
assert.equal(section.order, 1000);
assert.match(section.text({}), /rtk_rewrite/);
ctx.tools.get = (name) => name === 'rtk_rewrite' ? {} : undefined;
assert.equal(section.text({}), '', 'guidance hidden when bash is not visible');
ctx.tools.get = () => ({});
assert.match(section.text({}), /rtk_rewrite/);
delete ctx.tools.get;
assert.match(tool.output.render({}, { command: 'rtk git status', rewritten: true })[0].text, /Suggested command/);
assert.match(tool.output.render({}, { command: 'git status', rewritten: false })[0].text, /No rtk rewrite/);

// Rewrite: the probe is exactly `rtk hook check -- <command>`, never a shell.
reset({ code: 0, stdout: 'rtk git status\n' });
assert.deepEqual(await call('git status'), { command: 'rtk git status', rewritten: true });
assert.deepEqual(lastSpec.argv, ['rtk', 'hook', 'check', '--', 'git status']);
assert.equal(lastSpec.cwd, cwd);
assert.deepEqual(lastSpec.stdio, {
	stdin: 'ignore',
	stdout: { maxBytes: 65536 },
	stderr: 'ignore'
});
assert.equal(lastSpec.graceMs, 1000);
assert(lastSpec.signal instanceof AbortSignal);
assert.equal(lastSpec.shell, undefined);
assert.equal(spawns, 1);
assert.equal(behavior.terminateCalls, 1, 'the handle is released after settlement');

// No rewrite and lossy output both return the original command.
reset({ code: 1, stdout: '' });
assert.deepEqual(await call('echo hi'), { command: 'echo hi', rewritten: false });
reset({ code: 0, stdout: 'rtk git status\n', lossy: true });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });

// rtk missing and probe failures fall back without spawning.
reset({ missing: true });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(spawns, 0);
reset({ spawnError: new Error('spawn failed') });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(spawns, 1);
reset({ doneError: new Error('probe failed') });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(behavior.terminateCalls, 1, 'a failing handle is terminated');

// The kill switch must avoid the probe entirely.
process.env.RTK_DISABLED = '1';
try {
	reset({ code: 0, stdout: 'rtk git status\n' });
	assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
	assert.equal(spawns, 0);
} finally {
	delete process.env.RTK_DISABLED;
}

// workdir resolution: relative against the session directory, absolute unchanged, trimmed.
currentCwd = resolve(cwd, 'session');
reset({ code: 0, stdout: 'rtk git status\n' });
await call('git status', { workdir: ' sub ' });
assert.equal(lastSpec.cwd, resolve(currentCwd, 'sub'));
reset({ code: 0, stdout: 'rtk git status\n' });
await call('git status', { workdir: '/tmp' });
assert.equal(lastSpec.cwd, '/tmp');
currentCwd = cwd;

// A broken working directory must degrade instead of failing the call.
reset({ ensureError: new Error('cwd unavailable') });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(spawns, 0);

// Cancellation propagates and releases the handle.
reset({ waitForAbort: true });
const cancellation = new AbortController();
const pending = call('git status', { signal: cancellation.signal });
setTimeout(() => cancellation.abort(new Error('test user cancelled')), 25);
await assert.rejects(pending, /test user cancelled/);
assert.equal(spawns, 1);
assert.equal(behavior.terminateCalls, 1, 'cancelled probe is terminated');

// Argument validation.
await assert.rejects(call('  '), /invalid command/);
await assert.rejects(call(undefined), /invalid command/);
await assert.rejects(tool.execute(null, exec()), /invalid command/);
await assert.rejects(tool.execute({ command: 'git status', workdir: 123 }, exec()), /invalid workdir/);
await assert.rejects(tool.execute({ command: 'git status', workdir: '   ' }, exec()), /invalid workdir/);

console.log('PASS: rewrite, no-match, lossy fallback, missing rtk, spawn/done fallback, RTK_DISABLED, workdir, ensure fallback, cancellation, validation, no shell execution');
