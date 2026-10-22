import { isAbsolute, resolve } from 'node:path';

const BIN = process.env.RTK_BIN || 'rtk';
const MAX_REWRITE_BYTES = 64 * 1024;
const REWRITE_TIMEOUT_MS = 5000;
const GUIDANCE = 'For noisy shell output, you can call `rtk_rewrite` to obtain an rtk-filtered command, then execute that command with `bash`. The rewrite tool does not execute anything. Use the original command with `bash` when exact or machine-readable output is needed, or when the rewrite tool leaves it unchanged. All shell execution, approvals and background jobs remain with `bash`.';

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

export const name = 'dsh-rtk';
export const inject = ['tools', 'systemPrompt', 'subprocess', 'workingDirectory'];

export function apply(ctx) {
	ctx.systemPrompt.section({
		name: 'rtk:guidance',
		order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
		text: (context) => visible(ctx, 'rtk_rewrite', context.scope) && visible(ctx, 'bash', context.scope)
			? GUIDANCE
			: ''
	});

	ctx.tools.register({
		name: 'rtk_rewrite',
		description: 'Suggest an rtk-filtered shell command without executing it. Run the returned command with `bash` if the compressed output is appropriate; use the original command for exact output. If rtk is unavailable or its response is incomplete, the original command is returned.',
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
					rewritten: { type: 'boolean' }
				}
			},
			render: (_args, result) => [{ type: 'text', text: result.rewritten
				? `Suggested command (not executed): ${result.command}`
				: `No rtk rewrite (or rtk unavailable); original command (not executed): ${result.command}` }]
		},
		async execute(args, exec) {
			if (typeof args?.command !== 'string' || args.command.trim().length === 0) {
				throw new Error('invalid command: expected a non-empty string');
			}
			if (args.workdir !== undefined && (typeof args.workdir !== 'string' || !args.workdir.trim())) {
				throw new Error('invalid workdir: expected a non-empty string');
			}
			const original = { command: args.command, rewritten: false };
			if (process.env.RTK_DISABLED === '1') return original;
			const workdir = args.workdir?.trim();
			let sessionCwd;
			try {
				sessionCwd = exec.agent === undefined
					? undefined
					: await ctx.workingDirectory.ensure(exec.agent, exec.signal);
			} catch {
				if (exec.signal.aborted) throw cancellation(exec.signal);
				return original;
			}
			const cwd = workdir === undefined ? sessionCwd ?? process.cwd()
				: isAbsolute(workdir) ? workdir : resolve(sessionCwd ?? process.cwd(), workdir);
			let executable;
			try {
				executable = await ctx.subprocess.resolveExecutable(BIN, undefined, exec.signal);
			} catch {
				if (exec.signal.aborted) throw cancellation(exec.signal);
				return original;
			}
			const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(REWRITE_TIMEOUT_MS)]);
			let handle;
			try {
				handle = ctx.subprocess.spawn({
					argv: [executable, 'hook', 'check', '--', args.command],
					cwd,
					stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_REWRITE_BYTES }, stderr: 'ignore' },
					graceMs: 1000,
					signal
				});
				const outcome = await handle.done;
				if (exec.signal.aborted) throw cancellation(exec.signal);
				if (signal.aborted || outcome.exitCode !== 0) return original;
				const output = handle.collected.stdout?.readFrom(0);
				if (!output || output.lossy) return original;
				const rewritten = output.text.trimEnd();
				return rewritten && rewritten.trim() !== args.command.trim()
					? { command: rewritten, rewritten: true }
					: original;
			} catch {
				if (exec.signal.aborted) throw cancellation(exec.signal);
				return original;
			} finally {
				try {
					handle?.terminate?.();
				} catch {
					// The provider may already have torn down its managed range.
				}
			}
		}
	});
}
