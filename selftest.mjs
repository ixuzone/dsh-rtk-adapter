import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import * as plugin from './index.js';

const cwd = process.cwd();
const tools = [];
const listeners = [];
let section;
let lastSpec;
let spawns = 0;
let versionSpawns = 0;
let currentCwd = cwd;
let behavior;

function reset(next = {}) {
	behavior = {
		code: 3,
		stdout: '',
		lossy: false,
		missing: false,
		spawnError: undefined,
		doneError: undefined,
		ensureError: undefined,
		waitForAbort: false,
		terminateCalls: 0,
		binName: 'rtk',
		version: 'rtk 1.0.1',
		versionCode: 0,
		versionDelayMs: 0,
		...next
	};
	lastSpec = undefined;
	spawns = 0;
	versionSpawns = 0;
}

const versionHandle = () => {
	const done = behavior.versionDelayMs > 0
		? new Promise((settle) => setTimeout(() => settle({ exitCode: behavior.versionCode }), behavior.versionDelayMs))
		: Promise.resolve({ exitCode: behavior.versionCode });
	return {
		done,
		collected: {
			stdout: { readFrom: () => ({ text: behavior.version, lossy: false }) },
			stderr: { readFrom: () => ({ text: '', lossy: false }) }
		},
		terminate() {}
	};
};

function makeCtx() {
	return {
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
		on(event, handler) {
			listeners.push({ event, handler });
			return () => {};
		},
		effect(fn) { return fn(); },
		subprocess: {
			resolveExecutable: async () => {
				if (behavior.missing) throw new Error('rtk not installed');
				return behavior.binName;
			},
			spawn(spec) {
				if (spec.argv[1] === '--version') {
					versionSpawns += 1;
					return versionHandle();
				}
				lastSpec = spec;
				spawns += 1;
				if (behavior.spawnError) throw behavior.spawnError;
				const handle = {
					done: behavior.doneError
						? Promise.reject(behavior.doneError)
						: Promise.resolve({ exitCode: behavior.code }),
					collected: {
						stdout: { readFrom: () => ({ text: behavior.stdout, lossy: behavior.lossy }) },
						stderr: { readFrom: () => ({ text: '', lossy: false }) }
					},
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
}

reset();
const ctx = makeCtx();
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
assert.equal(plugin.name, 'dsh-rtk-adapter');
assert(!plugin.inject.includes('shell'));
assert.equal(section.name, 'rtk:guidance');
assert.equal(section.order, 1000);
assert.match(section.text({}), /rtk_rewrite/);
ctx.tools.get = (name) => name === 'rtk_rewrite' ? {} : undefined;
assert.equal(section.text({}), '', 'guidance hidden when bash is not visible');
ctx.tools.get = () => ({});
assert.match(section.text({}), /rtk_rewrite/);
delete ctx.tools.get;
assert.match(tool.output.render({}, { command: 'rtk git status', rewritten: true, denial: undefined })[0].text, /Suggested command/);
assert.match(tool.output.render({}, { command: 'git status', rewritten: false, denial: undefined })[0].text, /No rtk rewrite/);
assert.match(tool.output.render({}, { command: 'git status', rewritten: false, denial: 'rtk denied this command' })[0].text, /^rtk denied this command \(not executed\)/);
assert.equal(listeners.length, 0, 'no enforcement listener unless configured');

// Probe: `rtk --version` once, then exactly `rtk rewrite -- <command>`, never a shell.
reset({ code: 3, stdout: 'rtk git status\n' });
assert.deepEqual(await call('git status'), { command: 'rtk git status', rewritten: true });
assert.deepEqual(lastSpec.argv, ['rtk', 'rewrite', '--', 'git status']);
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
assert.equal(versionSpawns, 1, 'the version gate runs once');
assert.equal(behavior.terminateCalls, 1, 'the handle is released after settlement');
reset({ code: 3, stdout: 'rtk git status\n' });
await call('git status');
assert.equal(versionSpawns, 0, 'a definitive version answer is cached');

// rtk 1.x only: an older rtk never yields a rewrite or a denial, and the
// definitive "unsupported" answer is cached.
reset({ binName: 'rtk-legacy', version: 'rtk 0.20.0', code: 2, stdout: '' });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(spawns, 0, 'an unsupported rtk is never probed for a rewrite');
assert.equal(versionSpawns, 1);
reset({ binName: 'rtk-legacy', version: 'rtk 0.20.0', code: 2, stdout: '' });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(versionSpawns, 0, 'the unsupported answer is cached');

// A future major version is outside the supported range.
reset({ binName: 'rtk-v2', version: 'rtk 2.0.0', code: 3, stdout: 'rtk git status\n' });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(spawns, 0);

// An indeterminate version probe (failure, timeout, unparsable) is never
// cached: the next call probes again instead of disabling the plugin.
reset({ binName: 'rtk-flaky', versionCode: 1 });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(versionSpawns, 1);
assert.equal(spawns, 0);
reset({ binName: 'rtk-flaky', version: 'rtk 1.0.1', code: 3, stdout: 'rtk git status\n' });
assert.deepEqual(await call('git status'), { command: 'rtk git status', rewritten: true });
assert.equal(versionSpawns, 1, 'a failed probe is retried');
assert.equal(spawns, 1);

reset({ binName: 'rtk-garbled', version: 'not a version', code: 0 });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
reset({ binName: 'rtk-garbled', version: 'not a version', code: 0 });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
assert.equal(versionSpawns, 1, 'unparsable output is retried, not cached');

// A caller's cancellation during the version probe must not poison the
// process-wide answer.
reset({ binName: 'rtk-slowver', versionDelayMs: 80, code: 3, stdout: 'rtk git status\n' });
const versionCancel = new AbortController();
const pendingVersion = call('git status', { signal: versionCancel.signal });
setTimeout(() => versionCancel.abort(new Error('test user cancelled')), 25);
await assert.rejects(pendingVersion, /test user cancelled/);
reset({ binName: 'rtk-slowver', code: 3, stdout: 'rtk git status\n' });
assert.deepEqual(await call('git status'), { command: 'rtk git status', rewritten: true });
assert.equal(versionSpawns, 0, 'the definitive answer survived the cancellation');

// Exit 0 also carries a rewrite (allow-covered calls).
reset({ code: 0, stdout: 'rtk git status\n' });
assert.deepEqual(await call('git status'), { command: 'rtk git status', rewritten: true });

// Exit 1 is "nothing to rewrite".
reset({ code: 1 });
assert.deepEqual(await call('echo hi'), { command: 'echo hi', rewritten: false });

// Exit 2 is a policy denial with a fixed reason; stderr is never trusted.
reset({ code: 2 });
assert.deepEqual(await call('rm -rf /tmp/x'), {
	command: 'rm -rf /tmp/x',
	rewritten: false,
	denial: 'rtk denied this command'
});

// Degenerate probe output never becomes a command.
reset({ code: 3, stdout: '' });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
reset({ code: 3, stdout: 'rtk git status\n', lossy: true });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
reset({ code: 3, stdout: 'rtk git status\n' });
assert.deepEqual(await call('rtk git status'), { command: 'rtk git status', rewritten: false });

// A legitimate multi-line rewrite is preserved.
reset({ code: 3, stdout: 'rtk git status\n rtk git log --oneline\n' });
assert.deepEqual(await call('git status\n git log --oneline'), {
	command: 'rtk git status\n rtk git log --oneline',
	rewritten: true
});

// Unknown exit codes and failures fall back without spawning twice.
reset({ code: 101, stdout: 'garbage' });
assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
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
	reset({ code: 3, stdout: 'rtk git status\n' });
	assert.deepEqual(await call('git status'), { command: 'git status', rewritten: false });
	assert.equal(spawns, 0);
} finally {
	delete process.env.RTK_DISABLED;
}

// workdir resolution: relative against the session directory, absolute unchanged, trimmed.
currentCwd = resolve(cwd, 'session');
reset({ code: 3, stdout: 'rtk git status\n' });
await call('git status', { workdir: ' sub ' });
assert.equal(lastSpec.cwd, resolve(currentCwd, 'sub'));
reset({ code: 3, stdout: 'rtk git status\n' });
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

// Enforcement channel: only an rtk deny becomes a DSH denial.
const enforceCtx = makeCtx();
listeners.length = 0;
plugin.apply(enforceCtx, { enforce: true });
assert.equal(listeners.length, 1);
assert.equal(listeners[0].event, 'tools/pre-execute');
const guard = listeners[0].handler;
const bashExec = (command, workdir) => ({
	name: 'bash',
	arguments: workdir === undefined ? { command } : { command, workdir },
	agent: {},
	signal: AbortSignal.timeout(60000)
});
let nextCalls = 0;
const next = async () => { nextCalls += 1; return { kind: 'allow' }; };

reset({ code: 2 });
assert.deepEqual(await guard(bashExec('rm -rf /'), next), { kind: 'deny', reason: 'rtk denied this command' });
assert.equal(nextCalls, 0, 'a denied call never reaches the next policy');

reset({ code: 1 });
assert.deepEqual(await guard(bashExec('echo hi'), next), { kind: 'allow' });
assert.equal(nextCalls, 1);

reset({ code: 3, stdout: 'rtk git status\n' });
assert.deepEqual(await guard(bashExec('git status'), next), { kind: 'allow' });
assert.equal(nextCalls, 2);

// The guard passes the bash call's workdir through verbatim: DSH does not
// trim it, so neither may the enforcement probe.
currentCwd = resolve(cwd, 'session');
reset({ code: 1 });
await guard(bashExec('git status', ' sub '), next);
assert.equal(lastSpec.cwd, resolve(currentCwd, ' sub '));
reset({ code: 1 });
await guard(bashExec('git status', 'sub'), next);
assert.equal(lastSpec.cwd, resolve(currentCwd, 'sub'));
currentCwd = cwd;

reset({ code: 2 });
assert.deepEqual(await guard({ name: 'read', arguments: { path: 'x' }, agent: {}, signal: AbortSignal.timeout(60000) }, next), { kind: 'allow' });
assert.equal(nextCalls, 5, 'non-bash tools are never inspected');

reset({ missing: true });
assert.deepEqual(await guard(bashExec('git status'), next), { kind: 'allow' });
assert.equal(nextCalls, 6, 'a missing rtk never blocks bash');

reset({ binName: 'rtk-legacy', version: 'rtk 0.20.0', code: 2 });
assert.deepEqual(await guard(bashExec('rm -rf /'), next), { kind: 'allow' });
assert.equal(nextCalls, 7, 'an unsupported rtk never blocks bash');

// A downstream policy failure must not cause a second `next()` call.
let failures = 0;
const failingNext = async () => { failures += 1; throw new Error('downstream failed'); };
reset({ code: 1 });
await assert.rejects(guard(bashExec('git status'), failingNext), /downstream failed/);
assert.equal(failures, 1, 'next() is invoked exactly once');
assert.equal(nextCalls, 7);

console.log('PASS: rtk 1.x version gate (definitive cached, indeterminate retried, cancellation-safe), `rtk rewrite` exit 0/1/2/3 mapping, fixed policy denial, degenerate output, multiline rewrite, fallbacks, RTK_DISABLED, workdir, cancellation, validation, optional enforcement, single next(), no shell execution');
