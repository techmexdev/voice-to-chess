import {
	SERVER_INTERPRETER_POLICY_SCHEMA,
	readServerInterpreterPolicy,
	type InterpreterDeployment,
	type InterpreterPolicy
} from './interpreterPolicy.ts';
import {
	MOVE_INTERPRETER_BEHAVIOR_CONTRACT,
	type InterpreterReleaseIdentity
} from './moveInterpreter.ts';

export const VOICE_RUNTIME_PREFLIGHT_SCHEMA = 'voice-runtime-preflight/v1' as const;

export type PreflightCheckName = 'policy' | 'topology' | 'server_secrets' | 'slm_readiness' | 'quota';
export type PreflightCheckStatus = 'passed' | 'failed' | 'not_required';

export type ReleasePreflightCheck = Readonly<{
	name: PreflightCheckName;
	status: PreflightCheckStatus;
	message: string;
}>;

export type PublicPolicyIdentity = Readonly<{
	version: string;
	behaviorContract: typeof MOVE_INTERPRETER_BEHAVIOR_CONTRACT;
	authoritative: PublicDeploymentIdentity;
	shadow: PublicDeploymentIdentity | null;
}>;

export type PublicDeploymentIdentity = Readonly<{
	authority: 'hosted' | 'slm';
	releaseId: string;
	releaseIdentity: string;
}>;

/** Safe deployment facts needed to verify the gateway can reach its dependencies. */
export type PublicRuntimeTopology = Readonly<{
	gatewayRegion: string;
	redisRegion: string;
	slm: Readonly<{
		region: string;
		gpuClass: string;
		minimumWarmReplicas: number;
	}> | null;
}>;

export type ReleasePreflight = Readonly<{
	schema: typeof VOICE_RUNTIME_PREFLIGHT_SCHEMA;
	status: 'ready' | 'blocked';
	policy: PublicPolicyIdentity | null;
	topology: PublicRuntimeTopology | null;
	checks: readonly ReleasePreflightCheck[];
}>;

export type SlmReadinessInput = Readonly<{
	endpoint: string;
	bearerToken: string;
	expectedRelease: InterpreterReleaseIdentity;
	fetcher: typeof fetch;
}>;

export type RedisCommand = <T>(command: readonly (string | number)[]) => Promise<T>;

export type ReleasePreflightInput = Readonly<{
	environment: Readonly<Record<string, string | undefined>>;
	policy?: InterpreterPolicy;
	fetcher?: typeof fetch;
	checkQuota?: () => Promise<void>;
	checkSlmReadiness?: (input: SlmReadinessInput) => Promise<void>;
}>;

/**
 * Run non-content checks before a policy is deployed. Its receipt is safe to
 * show an operator: it reports only public policy identities and fixed failure
 * messages, never a URL, token, API key, transcript, or response body.
 */
export async function runReleasePreflight(input: ReleasePreflightInput): Promise<ReleasePreflight> {
	const checks: ReleasePreflightCheck[] = [];
	let policy: InterpreterPolicy | null = null;
	let topology: PublicRuntimeTopology | null = null;

	try {
		policy = input.policy ?? readServerInterpreterPolicy(input.environment);
		validatePolicyIdentity(policy, input.environment);
		checks.push(passed('policy', 'The server interpreter policy is valid.'));
	} catch {
		policy = null;
		checks.push(failed('policy', 'The server interpreter policy is invalid.'));
	}

	const requiresHosted = policy !== null && deploymentsFor(policy).some(
		(deployment) => deployment.authority === 'hosted'
	);
	const slmDeployment = policy === null
		? null
		: deploymentsFor(policy).find((deployment) => deployment.authority === 'slm') ?? null;
	if (policy === null) {
		checks.push(failed('topology', 'The runtime topology cannot be evaluated until the policy is valid.'));
	} else {
		try {
			topology = readRuntimeTopology(input.environment, slmDeployment !== null);
			checks.push(passed('topology', 'Gateway, Redis, and selected SLM placement are configured.'));
		} catch {
			topology = null;
			checks.push(failed('topology', 'Gateway, Redis, or selected SLM placement is not configured.'));
		}
	}
	const secretsReady = checkServerSecrets(input.environment, requiresHosted, slmDeployment !== null);
	checks.push(secretsReady
		? passed('server_secrets', 'Required credentials are configured server-side.')
		: failed('server_secrets', 'A required credential is missing or publicly configured.'));

	if (slmDeployment === null) {
		checks.push(notRequired('slm_readiness', 'No SLM release is selected by this policy.'));
	} else if (!secretsReady) {
		checks.push(failed('slm_readiness', 'The private SLM readiness check could not run.'));
	} else {
		try {
			await (input.checkSlmReadiness ?? checkPrivateSlmReadiness)({
				endpoint: input.environment.SLM_INTERPRETER_URL ?? '',
				bearerToken: input.environment.SLM_INTERPRETER_TOKEN ?? '',
				expectedRelease: slmDeployment.release,
				fetcher: input.fetcher ?? fetch
			});
			checks.push(passed('slm_readiness', 'The private SLM release is ready and matches policy.'));
		} catch {
			checks.push(failed('slm_readiness', 'The private SLM release is unavailable or does not match policy.'));
		}
	}

	try {
		await (input.checkQuota ?? unavailableQuota)();
		checks.push(passed('quota', 'The Redis quota service is available.'));
	} catch {
		checks.push(failed('quota', 'The Redis quota service is unavailable.'));
	}

	return Object.freeze({
		schema: VOICE_RUNTIME_PREFLIGHT_SCHEMA,
		status: checks.every((check) => check.status !== 'failed') ? 'ready' : 'blocked',
		policy: policy ? publicPolicyIdentity(policy) : null,
		topology,
		checks: Object.freeze(checks)
	});
}

/** A private, authenticated, non-content readiness call for the fixed SLM service. */
export async function checkPrivateSlmReadiness(input: SlmReadinessInput): Promise<void> {
	const endpoint = readinessEndpoint(input.endpoint);
	let response: Response;
	try {
		response = await input.fetcher(endpoint, {
			method: 'GET',
			headers: { Authorization: `Bearer ${input.bearerToken}` },
			signal: AbortSignal.timeout(4_000)
		});
	} catch {
		throw new Error('readiness unavailable');
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error('readiness unreadable');
	}
	if (!response.ok || !matchesReadiness(payload, input.expectedRelease)) {
		throw new Error('readiness invalid');
	}
}

export async function checkRedisQuotaAvailability(command: RedisCommand): Promise<void> {
	const response = await command<string>(['PING']);
	if (response !== 'PONG') throw new Error('quota unavailable');
}

export function publicPolicyIdentity(policy: InterpreterPolicy): PublicPolicyIdentity {
	return Object.freeze({
		version: policy.version,
		behaviorContract: policy.behaviorContract,
		authoritative: publicDeploymentIdentity(policy.authoritative),
		shadow: policy.shadow ? publicDeploymentIdentity(policy.shadow) : null
	});
}

function readRuntimeTopology(
	environment: Readonly<Record<string, string | undefined>>,
	requiresSlm: boolean
): PublicRuntimeTopology {
	const gatewayRegion = requireTopologyValue(environment.VOICE_GATEWAY_REGION);
	const redisRegion = requireTopologyValue(environment.VOICE_REDIS_REGION);
	const slm = requiresSlm
		? Object.freeze({
			region: requireTopologyValue(environment.SLM_INTERPRETER_REGION),
			gpuClass: requireTopologyValue(environment.SLM_INTERPRETER_GPU_CLASS),
			minimumWarmReplicas: requireWarmReplicaCount(environment.SLM_INTERPRETER_MIN_WARM_REPLICAS)
		})
		: null;
	return Object.freeze({ gatewayRegion, redisRegion, slm });
}

function validatePolicyIdentity(
	policy: InterpreterPolicy,
	environment: Readonly<Record<string, string | undefined>>
): void {
	if (
		policy.schema !== SERVER_INTERPRETER_POLICY_SCHEMA ||
		policy.behaviorContract !== MOVE_INTERPRETER_BEHAVIOR_CONTRACT ||
		!isPolicyVersion(policy.version)
	) {
		throw new Error('invalid policy');
	}
	for (const deployment of deploymentsFor(policy)) validateDeployment(deployment);

	const requestedShadow = environment.VOICE_INTERPRETER_SHADOW_AUTHORITY;
	if (requestedShadow && requestedShadow !== 'none' && policy.shadow === null) {
		throw new Error('invalid shadow policy');
	}
}

function validateDeployment(deployment: InterpreterDeployment): void {
	if (
		(deployment.authority !== 'hosted' && deployment.authority !== 'slm') ||
		!isIdentifier(deployment.release.releaseId) ||
		!isIdentifier(deployment.release.identity) ||
		!Number.isSafeInteger(deployment.timeoutMs) ||
		deployment.timeoutMs < 1 ||
		deployment.timeoutMs > 60_000
	) {
		throw new Error('invalid deployment');
	}
	if (deployment.authority === 'slm' && !/^[a-f0-9]{64}$/.test(deployment.release.identity)) {
		throw new Error('SLM identity is not immutable');
	}
}

function checkServerSecrets(
	environment: Readonly<Record<string, string | undefined>>,
	requiresHosted: boolean,
	requiresSlm: boolean
): boolean {
	if (
		hasPublicSecret(environment, 'PUBLIC_OPENAI_API_KEY') ||
		hasPublicSecret(environment, 'PUBLIC_SLM_INTERPRETER_URL') ||
		hasPublicSecret(environment, 'PUBLIC_SLM_INTERPRETER_TOKEN') ||
		hasPublicSecret(environment, 'PUBLIC_RELEASE_PREFLIGHT_OPERATOR_TOKEN')
	) {
		return false;
	}
	if (
		!hasSecret(environment.SHADOW_EVIDENCE_OPERATOR_TOKEN) ||
		!hasSecret(environment.RELEASE_PREFLIGHT_OPERATOR_TOKEN)
	) {
		return false;
	}
	if (requiresHosted && !hasSecret(environment.OPENAI_API_KEY)) return false;
	if (requiresSlm && (!hasSecret(environment.SLM_INTERPRETER_URL) || !hasSecret(environment.SLM_INTERPRETER_TOKEN))) {
		return false;
	}
	return true;
}

function hasPublicSecret(environment: Readonly<Record<string, string | undefined>>, name: string): boolean {
	return hasSecret(environment[name]);
}

function hasSecret(value: string | undefined): value is string {
	return typeof value === 'string' && value.length > 0;
}

function requireTopologyValue(value: string | undefined): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,120}$/.test(value)) {
		throw new Error('invalid runtime topology');
	}
	return value;
}

function requireWarmReplicaCount(value: string | undefined): number {
	if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value)) {
		throw new Error('invalid warm replica count');
	}
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count > 128) throw new Error('invalid warm replica count');
	return count;
}

function deploymentsFor(policy: InterpreterPolicy): readonly InterpreterDeployment[] {
	return policy.shadow ? [policy.authoritative, policy.shadow] : [policy.authoritative];
}

function publicDeploymentIdentity(deployment: InterpreterDeployment): PublicDeploymentIdentity {
	return Object.freeze({
		authority: deployment.authority,
		releaseId: deployment.release.releaseId,
		releaseIdentity: deployment.release.identity
	});
}

function readinessEndpoint(value: string): string {
	const url = new URL(value);
	if (!url.hostname || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
		throw new Error('invalid endpoint');
	}
	const pathname = url.pathname.replace(/\/$/, '').replace(/\/v1\/move-interpretations$/, '');
	url.pathname = `${pathname}/ready`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

function matchesReadiness(value: unknown, expectedRelease: InterpreterReleaseIdentity): boolean {
	if (!isRecord(value) || !isRecord(value.release)) return false;
	return (
		value.schema === 'move-interpreter-readiness/v1' &&
		value.ready === true &&
		value.behavior_contract === MOVE_INTERPRETER_BEHAVIOR_CONTRACT &&
		value.release.release_id === expectedRelease.releaseId &&
		value.release.identity_sha256 === expectedRelease.identity
	);
}

function passed(name: PreflightCheckName, message: string): ReleasePreflightCheck {
	return Object.freeze({ name, status: 'passed', message });
}

function failed(name: PreflightCheckName, message: string): ReleasePreflightCheck {
	return Object.freeze({ name, status: 'failed', message });
}

function notRequired(name: PreflightCheckName, message: string): ReleasePreflightCheck {
	return Object.freeze({ name, status: 'not_required', message });
}

function isPolicyVersion(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function unavailableQuota(): Promise<void> {
	throw new Error('quota unavailable');
}
