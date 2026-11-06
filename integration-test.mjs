import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate user-level rtk/Claude configuration: the runner's own
// ~/.claude/settings.json must never decide this test's outcome.
const home = mkdtempSync(join(tmpdir(), 'dsh-rtk-home-'));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, '.config');

const bin = process.env.RTK_BIN ?? 'rtk';
const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) {
	console.log(`SKIP: ${bin} is not available (${version.error?.message ?? version.stderr.trim()})`);
	rmSync(home, { recursive: true, force: true });
	process.exit(0);
}
const major = /rtk\s+(\d+)\./i.exec(version.stdout ?? '')?.[1];
if (major !== '1') {
	console.log(`SKIP: ${version.stdout.trim()} is outside the supported rtk 1.x range`);
	rmSync(home, { recursive: true, force: true });
	process.exit(0);
}
console.log(`Using ${version.stdout.trim() || bin}`);

const { apply } = await import('./index.js');

function run(argv, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		let error = '';
		child.stdout.on('data', (chunk) => { output += chunk; });
		child.stderr.on('data', (chunk) => { error += chunk; });
		child.on('error', reject);
		child.on('close', (exitCode) => resolve({ exitCode, output, error }));
	});
}

const cwd = process.cwd();
let lastSpec;
const tools = [];
const ctx = {
	systemPrompt: { section() {}, getSectionOrder: () => 1000 },
	tools: { register: (tool) => { tools.push(tool); } },
	workingDirectory: { ensure: async () => cwd },
	on() { return () => {}; },
	effect(fn) { return fn(); },
	subprocess: {
		resolveExecutable: async () => bin,
		spawn(spec) {
			lastSpec = spec;
			let output = '';
			let error = '';
			return {
				done: run(spec.argv, spec.cwd).then((result) => {
					output = result.output;
					error = result.error;
					return { exitCode: result.exitCode };
				}),
				collected: {
					stdout: { readFrom: () => ({ text: output, lossy: false }) },
					stderr: { readFrom: () => ({ text: error, lossy: false }) }
				}
			};
		}
	}
};

try {
	apply(ctx);
	assert.equal(tools.length, 1);
	const tool = tools[0];
	const exec = { agent: {}, signal: AbortSignal.timeout(60000) };
	const check = (command, workdir) => tool.execute(
		workdir === undefined ? { command } : { command, workdir },
		exec
	);

	// rtk 1.x answers a rewrite with exit 3 ("use the rewrite, defer approval").
	assert.deepEqual(await check('git status'), { command: 'rtk git status', rewritten: true });
	assert.deepEqual(lastSpec.argv, [bin, 'rewrite', '--', 'git status']);
	assert.deepEqual(await check('echo hi'), { command: 'echo hi', rewritten: false });
	assert.deepEqual(await check('cat package.json', '.'), { command: 'rtk read package.json', rewritten: true });
	assert.equal(lastSpec.cwd, cwd);

	// A command already in rtk form comes back unchanged (idempotent).
	assert.deepEqual(await check('rtk git status'), { command: 'rtk git status', rewritten: false });

	// Compound commands are rewritten per segment, and a multi-line rewrite is legal.
	assert.deepEqual(await check('cd /tmp && git status'), { command: 'cd /tmp && rtk git status', rewritten: true });

	// A leading option-looking command must be checked as a command, not consumed by rtk.
	// Without `--`, rtk prints its own help with exit 0; the guard must never surface that.
	assert.deepEqual(await check('-h'), { command: '-h', rewritten: false });
	assert.deepEqual(await check('--help'), { command: '--help', rewritten: false });

	// A shell construct rtk does not rewrite stays untouched.
	assert.deepEqual(await check('git status > /tmp/rtk-test-out'), { command: 'git status > /tmp/rtk-test-out', rewritten: false });

	// A real rtk permission deny (exit 2) is a denial with a fixed reason, not stderr text.
	const denyRoot = mkdtempSync(join(tmpdir(), 'dsh-rtk-deny-'));
	try {
		mkdirSync(join(denyRoot, '.claude'), { recursive: true });
		writeFileSync(join(denyRoot, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
		assert.deepEqual(await check('rm -rf /tmp/x', denyRoot), {
			command: 'rm -rf /tmp/x',
			rewritten: false,
			denial: 'rtk denied this command'
		});
	} finally {
		rmSync(denyRoot, { recursive: true, force: true });
	}

	process.env.RTK_DISABLED = '1';
	try {
		assert.deepEqual(await check('git status'), { command: 'git status', rewritten: false });
	} finally {
		delete process.env.RTK_DISABLED;
	}

	console.log('PASS: real rtk rewrite, no-match, idempotency, compound command, workdir, -h/--help regression, permission deny, RTK_DISABLED');
} finally {
	rmSync(home, { recursive: true, force: true });
}
