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

// Detached Cordis instance; this test never changes the current DSH Host profile.
const app = new Context();
let lookup;
let spawn;
app.provide('subprocess', {
	resolveExecutable: (...args) => lookup(...args),
	spawn: (...args) => spawn(...args)
});
app.provide('workingDirectory', { ensure: async () => process.cwd() });
await app.plugin(SystemPrompt, {});
await app.plugin(ToolRuntime, {});
await app.plugin({ inject: ['tools'], apply(ctx) {
	ctx.tools.register({
		name: 'bash', description: 'Test-only shell placeholder',
		parameters: { type: 'object', properties: {} },
		output: { schema: { type: 'string' }, render: () => [] },
		execute: async () => { throw new Error('bash must never execute'); }
	});
} });
await app.plugin(plugin);
const tools = app.get('tools');
const assembly = await app.systemPrompt.assemble();
assert(assembly.sections.some(({ name, text }) => name === 'rtk:guidance' && text.includes('rtk_rewrite')));
const original = { command: 'git status', rewritten: false };
const input = (signal, agent) => ({
	callId: `edge-${Math.random()}`,
	name: 'rtk_rewrite',
	arguments: { command: original.command },
	...agent === undefined ? {} : { agent },
	signal
});
const call = (signal, agent) => tools.execute(input(signal, agent));

// AbortSignal.timeout() uses an unref'd timer; keep this isolated process alive until it fires.
const keepAlive = setInterval(() => {}, 1000);
try {
	// Timeout: a cooperative fake process receives the plugin's 5-second signal.
	lookup = async () => 'rtk';
	let probeStopped = false;
	spawn = ({ signal }) => ({
		done: new Promise((resolve) => {
			signal.addEventListener('abort', () => { probeStopped = true; resolve({ exitCode: null }); }, { once: true });
		}),
		collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) } }
	});
	const started = Date.now();
	const timeout = await call(new AbortController().signal);
	assert.deepEqual(timeout.value, original);
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
	lookup = (_command, _env, signal) => new Promise((_resolve, reject) => {
		signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('lookup aborted')); }, { once: true });
	});
	spawn = () => { spawnCount++; throw new Error('unreachable'); };
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
	const scoped = createScope(app, agent);
	try {
		await scoped.ctx.plugin({ inject: ['tools'], apply(ctx) {
			ctx.tools.restrict({ deny: ['rtk_rewrite'] });
		} });
		assert.equal(tools.get('rtk_rewrite', agent), undefined);
		assert(!tools.schemas(agent).some(({ name }) => name === 'rtk_rewrite'));
		const restrictedAssembly = await app.systemPrompt.assemble({ scope: agent });
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
	const bashScope = createScope(app, bashAgent);
	try {
		await bashScope.ctx.plugin({ inject: ['tools'], apply(ctx) {
			ctx.tools.restrict({ deny: ['bash'] });
		} });
		assert.equal(tools.get('bash', bashAgent), undefined);
		assert(tools.get('rtk_rewrite', bashAgent));
		const bashAssembly = await app.systemPrompt.assemble({ scope: bashAgent });
		assert(!bashAssembly.sections.some(({ name, text }) => name === 'rtk:guidance' && text.length > 0));
		lookup = async () => 'rtk';
		let lastSpec;
		spawn = (spec) => {
			lastSpec = spec;
			return {
				done: Promise.resolve({ exitCode: 0 }),
				collected: { stdout: { readFrom: () => ({ text: 'rtk git status\n', lossy: false }) } }
			};
		};
		const suggested = await call(new AbortController().signal, bashAgent);
		assert.deepEqual(suggested.value, { command: 'rtk git status', rewritten: true });
		assert.deepEqual(lastSpec.argv, ['rtk', 'hook', 'check', '--', 'git status']);
		assert(!plugin.inject.includes('shell'));
		console.log('PASS bash restriction: suggestion works, guidance hidden, shell stays unavailable');
	} finally {
		await bashScope.dispose();
	}
} finally {
	clearInterval(keepAlive);
	await app.dispose?.();
}
