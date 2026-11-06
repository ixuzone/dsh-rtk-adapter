import { isAbsolute, resolve } from 'node:path';

const BIN = process.env.RTK_BIN || 'rtk';
const MAX_REWRITE_BYTES = 64 * 1024;
const REWRITE_TIMEOUT_MS = 5000;
const VERSION_TIMEOUT_MS = 1500;
const SUPPORTED_MAJOR_VERSION = 1;
const DENIAL_MESSAGE = 'rtk denied this command';
const GUIDANCE = 'For noisy shell output, you can call `rtk_rewrite` to obtain an rtk-filtered command, then execute that command with `bash`. The rewrite tool does not execute anything. Use the original command with `bash` when exact or machine-readable output is needed, or when the rewrite tool leaves it unchanged. All shell execution, approvals and background jobs remain with `bash`.';

/**
 * Definitive `rtk --version` answers only: `true` for a supported major,
 * `false` for a parsed but unsupported one. A probe that times out, fails to
 * spawn, or returns unparsable output is indeterminate and is never cached —
 * otherwise one transient failure would disable the plugin for the whole
 * process, and one cancelled first call could silently turn enforcement off.
 */
const support = new Map();
const pendingVersions = new Map();

function cancellation(signal) {
	const reason = signal.reason;
	return reason instanceof Error ? reason : new Error('rtk_rewrite cancelled', { cause: reason });
}

/** Keep the guidance out of assemblies where the tools it names are restricted away. */
function visible(ctx, tool, scope) {
	try {
		return scope === undefined ? ctx.tools.get(tool) !== undefined : ctx.tools.get(tool, scope) !== undefined;
	} catch {
		return true;
	}
}

/** The session directory, or the Harness process directory for programmatic callers. */
async function sessionDirectory(ctx, exec) {
	if (exec.agent === undefined) return process.cwd();
	return await ctx.workingDirectory.ensure(exec.agent, exec.signal);
}

/** Directory rtk inspects: an explicit workdir wins; relative paths resolve against the session. */
async function resolveCwd(ctx, exec, workdir) {
	if (workdir === undefined) return await sessionDirectory(ctx, exec);
	if (isAbsolute(workdir)) return workdir;
	return resolve(await sessionDirectory(ctx, exec), workdir);
}

/**
 * This plugin targets rtk 1.x only. Older rtk has no `rewrite` subcommand and
 * reports that as exit 2 + an "unrecognized subcommand" message, which would
 * otherwise be indistinguishable from an rtk policy denial.
 *
 * The probe owns its own deadline and never inherits a caller's signal: the
 * answer is process-wide, so one caller's cancellation must not decide it.
 * @returns {Promise<boolean>} whether the resolved executable is a supported rtk.
 * @throws when the version cannot be determined; callers must treat that as indeterminate.
 */
async function supportedVersion(ctx, executable) {
	const known = support.get(executable);
	if (known !== undefined) return known;
	let inflight = pendingVersions.get(executable);
	if (inflight === undefined) {
		inflight = probeVersion(ctx, executable).then((supported) => {
			support.set(executable, supported);
			pendingVersions.delete(executable);
			return supported;
		}, (error) => {
			pendingVersions.delete(executable);
			throw error;
		});
		pendingVersions.set(executable, inflight);
	}
	return await inflight;
}

async function probeVersion(ctx, executable) {
	const handle = ctx.subprocess.spawn({
		argv: [executable, '--version'],
		cwd: process.cwd(),
		stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: 'ignore' },
		graceMs: 500,
		signal: AbortSignal.timeout(VERSION_TIMEOUT_MS)
	});
	try {
		const outcome = await handle.done;
		if (outcome.exitCode !== 0) throw new Error(`rtk --version exited with ${outcome.exitCode}`);
		const output = handle.collected.stdout?.readFrom(0);
		if (!output || output.lossy) throw new Error('rtk --version output was incomplete');
		const match = /rtk\s+(\d+)\.(\d+)/i.exec(output.text);
		if (match === null) throw new Error('unrecognized rtk --version output');
		return Number(match[1]) === SUPPORTED_MAJOR_VERSION;
	} finally {
		try {
			handle.terminate?.();
		} catch {
			// The provider may already have torn down its managed range.
		}
	}
}

/**
 * Ask rtk for the rewrite of one command without running it.
 *
 * `rtk rewrite` documents four exit codes: 0 and 3 both carry a rewrite on
 * stdout (3 only defers approval to the host), 1 means there is nothing to
 * rewrite, and 2 means rtk denied the command. The deny reason is not read
 * from stderr: rtk also writes diagnostics there, and an older rtk reports its
 * own missing subcommand as exit 2. Only the exit code classifies the result.
 *
 * @returns {Promise<{kind: 'rewritten', command: string} | {kind: 'denied'} | {kind: 'unchanged'} | {kind: 'unavailable'} | {kind: 'unsupported'} | {kind: 'cancelled'}>}
 */
async function inspect(ctx, command, exec, workdir) {
	if (process.env.RTK_DISABLED === '1') return { kind: 'unchanged' };
	let cwd;
	try {
		cwd = await resolveCwd(ctx, exec, workdir);
	} catch {
		return exec.signal.aborted ? { kind: 'cancelled' } : { kind: 'unchanged' };
	}
	let executable;
	try {
		executable = await ctx.subprocess.resolveExecutable(BIN, undefined, exec.signal);
	} catch {
		return exec.signal.aborted ? { kind: 'cancelled' } : { kind: 'unavailable' };
	}
	let supported;
	try {
		supported = await supportedVersion(ctx, executable);
	} catch {
		return exec.signal.aborted ? { kind: 'cancelled' } : { kind: 'unavailable' };
	}
	if (!supported) return exec.signal.aborted ? { kind: 'cancelled' } : { kind: 'unsupported' };
	const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(REWRITE_TIMEOUT_MS)]);
	let handle;
	try {
		handle = ctx.subprocess.spawn({
			// `--` keeps a leading `-h`, `--help`, or `--version` from being read
			// as an rtk option; without it rtk prints its own help and exits 0.
			argv: [executable, 'rewrite', '--', command],
			cwd,
			stdio: {
				stdin: 'ignore',
				stdout: { maxBytes: MAX_REWRITE_BYTES },
				stderr: 'ignore'
			},
			graceMs: 1000,
			signal
		});
		const outcome = await handle.done;
		if (exec.signal.aborted) return { kind: 'cancelled' };
		if (signal.aborted) return { kind: 'unchanged' };
		if (outcome.exitCode === 2) return { kind: 'denied' };
		if (outcome.exitCode !== 0 && outcome.exitCode !== 3) return { kind: 'unchanged' };
		const output = handle.collected.stdout?.readFrom(0);
		// A truncated tail is never a command.
		if (!output || output.lossy) return { kind: 'unchanged' };
		const text = output.text.trimEnd();
		if (!text) return { kind: 'unchanged' };
		// rtk may echo an already-rtk command back under 0 or 3.
		if (text.trim() === command.trim()) return { kind: 'unchanged' };
		return { kind: 'rewritten', command: text };
	} catch {
		return exec.signal.aborted ? { kind: 'cancelled' } : { kind: 'unchanged' };
	} finally {
		try {
			handle?.terminate?.();
		} catch {
			// The provider may already have torn down its managed range.
		}
	}
}

export const name = 'dsh-rtk-adapter';
export const inject = ['tools', 'systemPrompt', 'subprocess', 'workingDirectory'];

export function apply(ctx, config = {}) {
	// Enforcement is opt-in: only an explicit config or environment request
	// turns rtk's own deny decision into a bash-call denial.
	const enforce = config?.enforce === true || process.env.RTK_ENFORCE === '1';

	ctx.systemPrompt.section({
		name: 'rtk:guidance',
		order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
		text: (context) => visible(ctx, 'rtk_rewrite', context.scope) && visible(ctx, 'bash', context.scope)
			? GUIDANCE
			: ''
	});

	ctx.tools.register({
		name: 'rtk_rewrite',
		description: 'Suggest an rtk-filtered shell command without executing it. Run the returned command with `bash` if the compressed output is appropriate; use the original command for exact output. If rtk is unavailable, denies the command, or its response is incomplete, the original command is returned.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['command'],
			properties: {
				command: { type: 'string', description: 'Shell command to check with rtk. It is not executed by this tool.' },
				workdir: { type: 'string', description: 'Directory for rtk to inspect. Relative paths use the session working directory.' }
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['command', 'rewritten'],
				properties: {
					command: { type: 'string' },
					rewritten: { type: 'boolean' },
					denial: { type: 'string', description: 'Set when rtk denied the command (exit code 2).' }
				}
			},
			render: (_args, result) => {
				if (result.denial !== undefined) {
					return [{ type: 'text', text: `${result.denial} (not executed).\nThe original command was not run; a later \`bash\` call is still governed by DSH approvals.` }];
				}
				return [{ type: 'text', text: result.rewritten
					? `Suggested command (not executed): ${result.command}`
					: `No rtk rewrite (or rtk unavailable); original command (not executed): ${result.command}` }];
			}
		},
		async execute(args, exec) {
			if (typeof args?.command !== 'string' || args.command.trim().length === 0) {
				throw new Error('invalid command: expected a non-empty string');
			}
			if (args.workdir !== undefined && (typeof args.workdir !== 'string' || !args.workdir.trim())) {
				throw new Error('invalid workdir: expected a non-empty string');
			}
			const original = { command: args.command, rewritten: false };
			const result = await inspect(ctx, args.command, exec, args.workdir?.trim());
			if (result.kind === 'cancelled') throw cancellation(exec.signal);
			if (result.kind === 'denied') return { ...original, denial: DENIAL_MESSAGE };
			if (result.kind === 'rewritten') return { command: result.command, rewritten: true };
			return original;
		}
	});

	if (!enforce) return;

	// Optional enforcement channel: rtk's own deny decision (exit code 2)
	// becomes a DSH pre-execute denial. Everything else — no rewrite, a plain
	// rewrite, a timeout, a missing or unsupported rtk — delegates untouched.
	ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
		if (exec.name !== 'bash') return next();
		const command = exec.arguments?.command;
		if (typeof command !== 'string' || command.trim().length === 0) return next();
		// Pass the caller's workdir through verbatim: DSH resolves it without
		// trimming, so trimming here would inspect a different directory.
		const workdirArg = exec.arguments?.workdir;
		const workdir = typeof workdirArg === 'string' ? workdirArg : undefined;
		let result;
		try {
			result = await inspect(ctx, command, exec, workdir);
		} catch {
			// Enforcement must never make a bash call fail for its own reasons.
			return next();
		}
		if (result.kind === 'denied') return { kind: 'deny', reason: DENIAL_MESSAGE };
		return next();
	}));
}
