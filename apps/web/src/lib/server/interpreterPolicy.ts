import {
	MOVE_INTERPRETER_BEHAVIOR_CONTRACT,
	type InterpreterAuthority,
	type InterpreterReleaseIdentity
} from './moveInterpreter.ts';

export const SERVER_INTERPRETER_POLICY_SCHEMA = 'server-move-interpreter-policy/v1' as const;

export type InterpreterDeployment = Readonly<{
	authority: InterpreterAuthority;
	release: InterpreterReleaseIdentity;
	timeoutMs: number;
}>;

export type ShadowDeployment = InterpreterDeployment & Readonly<{
	maxConcurrent: number;
}>;

/** Server deployment configuration. It is deliberately never decoded from a browser request. */
export type InterpreterPolicy = Readonly<{
	schema: typeof SERVER_INTERPRETER_POLICY_SCHEMA;
	version: string;
	behaviorContract: typeof MOVE_INTERPRETER_BEHAVIOR_CONTRACT;
	authoritative: InterpreterDeployment;
	shadow: ShadowDeployment | null;
}>;

export type InterpreterPolicyInput = Readonly<{
	version: string;
	authority: InterpreterAuthority;
	authoritativeRelease: InterpreterReleaseIdentity;
	authoritativeTimeoutMs?: number;
	shadowAuthority?: InterpreterAuthority | null;
	shadowRelease?: InterpreterReleaseIdentity;
	shadowTimeoutMs?: number;
	shadowMaxConcurrent?: number;
}>;

export class InterpreterPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InterpreterPolicyError';
	}
}

/** Build a policy only after proving each deployment identity and bound. */
export function createInterpreterPolicy(input: InterpreterPolicyInput): InterpreterPolicy {
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(input.version)) {
		throw new InterpreterPolicyError('The interpreter policy version is invalid.');
	}
	const authoritative = Object.freeze({
		authority: input.authority,
		release: validateRelease(input.authoritativeRelease, input.authority),
		timeoutMs: validateDuration(input.authoritativeTimeoutMs ?? 12_000, 'authority timeout')
	});

	let shadow: ShadowDeployment | null = null;
	if (input.shadowAuthority !== undefined && input.shadowAuthority !== null) {
		if (input.shadowAuthority === input.authority) {
			throw new InterpreterPolicyError('The shadow authority must be inactive.');
		}
		if (!input.shadowRelease) {
			throw new InterpreterPolicyError('The shadow release is required.');
		}
		shadow = Object.freeze({
			authority: input.shadowAuthority,
			release: validateRelease(input.shadowRelease, input.shadowAuthority),
			timeoutMs: validateDuration(input.shadowTimeoutMs ?? 3_000, 'shadow timeout'),
			maxConcurrent: validateConcurrency(input.shadowMaxConcurrent ?? 2)
		});
	}

	return Object.freeze({
		schema: SERVER_INTERPRETER_POLICY_SCHEMA,
		version: input.version,
		behaviorContract: MOVE_INTERPRETER_BEHAVIOR_CONTRACT,
		authoritative,
		shadow
	});
}

/**
 * Read deployment configuration supplied only through server runtime variables.
 * A rollback is a deployment change from `slm` back to `hosted`; no client
 * parameter participates in this decision.
 */
export function readServerInterpreterPolicy(
	environment: Readonly<Record<string, string | undefined>>
): InterpreterPolicy {
	const authority = readAuthority(
		environment.VOICE_INTERPRETER_AUTHORITY ?? 'hosted',
		'authority'
	);
	const base = createInterpreterPolicy({
		version: environment.VOICE_INTERPRETER_POLICY_VERSION ?? 'hosted-v1',
		authority,
		authoritativeRelease: releaseFor(authority, environment),
		authoritativeTimeoutMs: readDuration(
			environment.VOICE_INTERPRETER_TIMEOUT_MS,
			12_000,
			'authority timeout'
		)
	});
	const shadowValue = environment.VOICE_INTERPRETER_SHADOW_AUTHORITY ?? 'none';
	if (shadowValue === 'none' || shadowValue === '') return base;

	// Shadow is optional research traffic. A bad optional configuration must not
	// take down the approved authoritative route; release preflight reports it.
	try {
		const shadowAuthority = readAuthority(shadowValue, 'shadow authority');
		return createInterpreterPolicy({
			version: base.version,
			authority: base.authoritative.authority,
			authoritativeRelease: base.authoritative.release,
			authoritativeTimeoutMs: base.authoritative.timeoutMs,
			shadowAuthority,
			shadowRelease: releaseFor(shadowAuthority, environment),
			shadowTimeoutMs: readDuration(
				environment.VOICE_INTERPRETER_SHADOW_TIMEOUT_MS,
				3_000,
				'shadow timeout'
			),
			shadowMaxConcurrent: readConcurrency(
				environment.VOICE_INTERPRETER_SHADOW_MAX_CONCURRENCY,
				2
			)
		});
	} catch (error) {
		if (error instanceof InterpreterPolicyError) return base;
		throw error;
	}
}

function releaseFor(
	authority: InterpreterAuthority,
	environment: Readonly<Record<string, string | undefined>>
): InterpreterReleaseIdentity {
	if (authority === 'hosted') {
		return Object.freeze({
			releaseId: environment.VOICE_HOSTED_INTERPRETER_RELEASE_ID ?? 'gpt-4o-mini',
			identity: environment.VOICE_HOSTED_INTERPRETER_PROMPT_ID ?? 'move-intent-v2-hosted-v3'
		});
	}
	return Object.freeze({
		releaseId: requireValue(environment.SLM_INTERPRETER_RELEASE_ID, 'The SLM release ID is required.'),
		identity: requireValue(
			environment.SLM_INTERPRETER_RELEASE_IDENTITY_SHA256,
			'The SLM release identity is required.'
		)
	});
}

function validateRelease(
	release: InterpreterReleaseIdentity,
	authority: InterpreterAuthority
): InterpreterReleaseIdentity {
	if (!isIdentifier(release.releaseId) || !isIdentifier(release.identity)) {
		throw new InterpreterPolicyError('The interpreter release identity is invalid.');
	}
	if (authority === 'slm' && !/^[a-f0-9]{64}$/.test(release.identity)) {
		throw new InterpreterPolicyError('The SLM release identity must be immutable.');
	}
	return Object.freeze({ releaseId: release.releaseId, identity: release.identity });
}

function readAuthority(value: string, label: string): InterpreterAuthority {
	if (value === 'hosted' || value === 'slm') return value;
	throw new InterpreterPolicyError(`The interpreter ${label} is invalid.`);
}

function readDuration(value: string | undefined, fallback: number, label: string): number {
	if (value === undefined || value === '') return fallback;
	const parsed = Number(value);
	return validateDuration(parsed, label);
}

function readConcurrency(value: string | undefined, fallback: number): number {
	if (value === undefined || value === '') return fallback;
	return validateConcurrency(Number(value));
}

function validateDuration(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
		throw new InterpreterPolicyError(`The interpreter ${label} is invalid.`);
	}
	return value;
}

function validateConcurrency(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
		throw new InterpreterPolicyError('The interpreter shadow concurrency is invalid.');
	}
	return value;
}

function requireValue(value: string | undefined, message: string): string {
	if (!value) throw new InterpreterPolicyError(message);
	return value;
}

function isIdentifier(value: string): boolean {
	return /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
}
