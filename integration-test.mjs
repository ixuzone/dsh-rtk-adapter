import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';

const bin = process.env.RTK_BIN ?? 'rtk';
const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) {
	console.log(`SKIP: ${bin} is not available (${version.error?.message ?? version.stderr.trim()})`);
	process.exit(0);
}
console.log(`Using ${version.stdout.trim() || bin}`);

const { apply } = await import('./index.js');

function run(argv, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
		let output = '';
		child.stdout.on('data', (chunk) => { output += chunk; });
		child.on('error', reject);
		child.on('close', (exitCode) => resolve({ exitCode, output }));
	});
}

const cwd = process.cwd();
let lastSpec;
const tools = [];
const ctx = {
	systemPrompt: { section() {}, getSectionOrder: () => 1000 },
	tools: { register: (tool) => { tools.push(tool); } },
	workingDirectory: { ensure: async () => cwd },
	subprocess: {
		resolveExecutable: async () => bin,
		spawn(spec) {
			lastSpec = spec;
			let output = '';
			return {
				done: run(spec.argv, spec.cwd).then((result) => {
					output = result.output;
					return { exitCode: result.exitCode };
				}),
				collected: { stdout: { readFrom: () => ({ text: output, lossy: false }) } }
			};
		}
	}
};
apply(ctx);
assert.equal(tools.length, 1);
const tool = tools[0];
const exec = { agent: {}, signal: AbortSignal.timeout(60000) };
const check = (command, workdir) => tool.execute(
	workdir === undefined ? { command } : { command, workdir },
	exec
);

assert.deepEqual(await check('git status'), { command: 'rtk git status', rewritten: true });
assert.deepEqual(lastSpec.argv, [bin, 'hook', 'check', '--', 'git status']);
assert.deepEqual(await check('echo hi'), { command: 'echo hi', rewritten: false });
assert.deepEqual(await check('cat package.json', '.'), { command: 'rtk read package.json', rewritten: true });
assert.equal(lastSpec.cwd, cwd);

// A leading option-looking command must be checked as a command, not consumed by rtk.
assert.deepEqual(await check('-h'), { command: '-h', rewritten: false });
assert.deepEqual(await check('--help'), { command: '--help', rewritten: false });

process.env.RTK_DISABLED = '1';
try {
	assert.deepEqual(await check('git status'), { command: 'git status', rewritten: false });
} finally {
	delete process.env.RTK_DISABLED;
}

console.log('PASS: real rtk rewrite, no-match, workdir, -h/--help regression, RTK_DISABLED');
