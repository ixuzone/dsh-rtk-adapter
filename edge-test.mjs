import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as plugin from './index.js';

// Resolve DSH packages from the installed CLI, not this standalone package.
const dsh = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim());
const requireFromDsh = createRequire(dsh);
const load = (name) => import(pathToFileURL(requireFromDsh.resolve(`@deepseek-ai/${name}`)).href);
const [{ Context }, { SystemPrompt }, { ToolRuntime }, { createScope }] = await Promise.all([
	load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-scope')
]);

/**
 * DSH 0.2.2 batches raw calls behind a mounted tool executor and returns
 * `{ results: [{ callId, result }] }`; 0.2.1 executes one call input and
 * returns that call's result directly. `setExecutor` is the discriminator:
 * only the batched registry has it.
 */
const isBatched = (tools) => typeof tools.setExecutor === 'function';

async function invoke(tools, input) {
	if (!isBatched(tools)) return await tools.execute(input);
	const { results } = await tools.execute({
		calls: [{ id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
		...input.agent === undefined ? {} : { agent: input.agent },
		signal: input.signal
	});
	return results[0].result;
}

/**
 * Build a detached Cordis instance: real ToolRuntime and system prompt, a
 * test-only bash placeholder, and the plugin under test with optional config.
 */
async function makeApp({ spawn, lookup, config } = {}) {
	const app = new Context();
	app.provide('subprocess', {
		resolveExecutable: (...args) => lookup(...args),
		spawn: (...args) => spawn(...args)
	});
	app.provide('workingDirectory', { ensure: async () => process.cwd() });
	await app.plugin(SystemPrompt, {});
	await app.plugin(ToolRuntime, {});
	// 0.2.2 no longer executes calls itself: it requires a mounted executor and
	// ships the native one. 0.2.1 has neither, so mount only when the registry
	// exposes `setExecutor`.
	if (isBatched(app.get('tools'))) await app.plugin(await load('dsh-tool-executor-native'), {});
	const bash = { calls: 0 };
	await app.plugin({ inject: ['tools'], apply(ctx) {
		ctx.tools.register({
			name: 'bash', description: 'Test-only shell placeholder',
			parameters: { type: 'object', properties: {} },
			output: { schema: { type: 'string' }, render: () => [] },
			execute: async () => { bash.calls += 1; return 'ran'; }
		});
	} });
	await app.plugin(plugin, config);
	return { app, bash, tools: app.get('tools') };
}

const callInput = (signal, agent, args = { command: 'git status' }) => ({
	callId: `edge-${Math.random()}`,
	name: 'rtk_rewrite',
	arguments: args,
	...agent === undefined ? {} : { agent },
	signal
});

// --- Main app: timeout, cancellation, restrictions ---------------------------

let lookupImpl = async () => 'rtk';
let spawnImpl = () => ({ done: Promise.resolve({ exitCode: 1 }), collected: {} });
const versionHandle = () => ({
	done: Promise.resolve({ exitCode: 0 }),
	collected: {
		stdout: { readFrom: () => ({ text: 'rtk 1.0.1', lossy: false }) },
		stderr: { readFrom: () => ({ text: '', lossy: false }) }
	}
});
const spawnWithVersion = (impl) => (spec) => spec.argv[1] === '--version' ? versionHandle() : impl(spec);
const main = await makeApp({ spawn: spawnWithVersion((...args) => spawnImpl(...args)), lookup: (...args) => lookupImpl(...args) });
const assembly = await main.app.systemPrompt.assemble();
assert(assembly.sections.some(({ name, text }) => name === 'rtk:guidance' && text.includes('rtk_rewrite')));
const call = (signal, agent) => invoke(main.tools, callInput(signal, agent));

// AbortSignal.timeout() uses an unref'd timer; keep this isolated process alive until it fires.
const keepAlive = setInterval(() => {}, 1000);
try {
	// Timeout: a cooperative fake process receives the plugin's 5-second signal.
	lookupImpl = async () => 'rtk';
	let probeStopped = false;
	spawnImpl = ({ signal }) => ({
		done: new Promise((resolve) => {
			signal.addEventListener('abort', () => { probeStopped = true; resolve({ exitCode: null }); }, { once: true });
		}),
		collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } }
	});
	const started = Date.now();
	const timeout = await call(new AbortController().signal);
	assert.deepEqual(timeout.value, { command: 'git status', rewritten: false });
	assert(probeStopped);
	assert(Date.now() - started >= 4500 && Date.now() - started < 9000);
	console.log('PASS timeout: probe stopped and original returned');

	// User cancellation during a running probe must propagate and stop the process.
	probeStopped = false;
	const cancellation = new AbortController();
	const pending = call(cancellation.signal);
	setTimeout(() => cancellation.abort(new Error('test user cancelled')), 25);
	const cancelled = await pending;
	assert(probeStopped);
	assert.equal(cancelled.isError, true);
	assert.match(cancelled.error.message, /abort|cancel/i);
	console.log('PASS cancellation during probe: stopped and not reported as success');

	// User cancellation during executable lookup must never spawn the probe.
	let sawAbort = false;
	let spawnCount = 0;
	lookupImpl = (_command, _env, signal) => new Promise((_resolve, reject) => {
		signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('lookup aborted')); }, { once: true });
	});
	spawnImpl = () => { spawnCount++; throw new Error('unreachable'); };
	const lookupAbort = new AbortController();
	const pendingLookup = call(lookupAbort.signal);
	setTimeout(() => lookupAbort.abort(new Error('test lookup cancelled')), 25);
	const lookupResult = await pendingLookup;
	assert(sawAbort);
	assert.equal(spawnCount, 0);
	assert.equal(lookupResult.isError, true);
	console.log('PASS cancellation during lookup: stopped before spawn');

	// DSH's actual scoped registry restriction excludes this tool from lookup and dispatch.
	const agent = { id: 'restricted-agent' };
	const scoped = createScope(main.app, agent);
	try {
		await scoped.ctx.plugin({ inject: ['tools'], apply(ctx) {
			ctx.tools.restrict({ deny: ['rtk_rewrite'] });
		} });
		assert.equal(main.tools.get('rtk_rewrite', agent), undefined);
		assert(!main.tools.schemas(agent).some(({ name }) => name === 'rtk_rewrite'));
		const restrictedAssembly = await main.app.systemPrompt.assemble({ scope: agent });
		assert(!restrictedAssembly.sections.some(({ name, text }) => name === 'rtk:guidance' && text.length > 0));
		const denied = await call(new AbortController().signal, agent);
		assert.equal(denied.isError, true);
		assert.match(denied.error.message, /unknown tool/i);
		assert.equal(spawnCount, 0);
		console.log('PASS restricted agent: tool invisible, guidance hidden, undispatchable');
	} finally {
		await scoped.dispose();
	}

	// Restricting bash alone still allows suggestions, never shell execution.
	const bashAgent = { id: 'bash-denied-agent' };
	const bashScope = createScope(main.app, bashAgent);
	try {
		await bashScope.ctx.plugin({ inject: ['tools'], apply(ctx) {
			ctx.tools.restrict({ deny: ['bash'] });
		} });
		assert.equal(main.tools.get('bash', bashAgent), undefined);
		assert(main.tools.get('rtk_rewrite', bashAgent));
		const bashAssembly = await main.app.systemPrompt.assemble({ scope: bashAgent });
		assert(!bashAssembly.sections.some(({ name, text }) => name === 'rtk:guidance' && text.length > 0));
		lookupImpl = async () => 'rtk';
		let lastSpec;
		spawnImpl = (spec) => {
			lastSpec = spec;
			return {
				done: Promise.resolve({ exitCode: 3 }),
				collected: {
					stdout: { readFrom: () => ({ text: 'rtk git status\n', lossy: false }) },
					stderr: { readFrom: () => ({ text: '', lossy: false }) }
				}
			};
		};
		const suggested = await call(new AbortController().signal, bashAgent);
		assert.deepEqual(suggested.value, { command: 'rtk git status', rewritten: true });
		assert.deepEqual(lastSpec.argv, ['rtk', 'rewrite', '--', 'git status']);
		assert(!plugin.inject.includes('shell'));
		console.log('PASS bash restriction: suggestion works, guidance hidden, shell stays unavailable');
	} finally {
		await bashScope.dispose();
	}
} finally {
	clearInterval(keepAlive);
	await main.app.dispose?.();
}

// --- Enforcement channel: real pre-execute waterfall -------------------------

let enforceSpawn;
const enforced = await makeApp({
	lookup: async () => 'rtk',
	spawn: spawnWithVersion((...args) => enforceSpawn(...args)),
	config: { enforce: true }
});
const bashCall = (command) => invoke(enforced.tools, {
	callId: `edge-${Math.random()}`,
	name: 'bash',
	arguments: { command },
	agent: { id: 'enforced-agent' },
	signal: new AbortController().signal
});

// An rtk policy denial blocks the bash call before its body runs; stderr is
// never used as the reason.
enforceSpawn = () => ({
	done: Promise.resolve({ exitCode: 2 }),
	collected: {
		stdout: { readFrom: () => ({ text: '', lossy: false }) },
		stderr: { readFrom: () => ({ text: 'pipeline rule: blocked\n', lossy: false }) }
	}
});
const denied = await bashCall('rm -rf /tmp/x');
assert.equal(denied.isError, true);
assert.match(denied.error.message, /rtk denied this command/);
assert.equal(enforced.bash.calls, 0, 'a denied bash call never executes');

// Anything that is not an rtk denial reaches the bash body.
enforceSpawn = () => ({
	done: Promise.resolve({ exitCode: 1 }),
	collected: {
		stdout: { readFrom: () => ({ text: '', lossy: false }) },
		stderr: { readFrom: () => ({ text: '', lossy: false }) }
	}
});
const allowed = await bashCall('git status');
assert.equal(allowed.isError, false);
assert.equal(enforced.bash.calls, 1);
console.log('PASS enforcement: rtk deny blocks bash, ordinary calls pass through');

await enforced.app.dispose?.();
console.log('PASS edge: timeout, cancellation, restrictions, enforcement waterfall');
