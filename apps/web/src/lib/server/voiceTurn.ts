import {
	failedVoiceTurnOutcome,
	voiceTurnOutcomeFromResolution,
	type VoiceTurnFailure,
	type VoiceTurnOutcome,
	type VoiceTurnResponse
} from '../game/VoiceTurn.ts';
import { resolveMoveIntent } from '../game/MoveResolver.ts';
import type { ReplayedVoiceResolverContext } from '../game/VoiceResolverContext.ts';
import {
	MoveInterpretationValidationError,
	parseCompactMoveInterpretation
} from '../move-intent/move-interpretation.ts';
import { createHostedMoveInterpreter } from './hostedMoveInterpreter.ts';
import {
	createInterpreterPolicy,
	type InterpreterPolicy,
	type InterpreterDeployment
} from './interpreterPolicy.ts';
import {
	createMoveInterpreterRequest,
	type InterpreterAuthority,
	type MoveInterpreter,
	type MoveInterpreterRequest,
	type MoveInterpreterResult,
	MoveInterpreterProviderError
} from './moveInterpreter.ts';
import {
	SlmMoveInterpreterConfigurationError,
	createSlmMoveInterpreter
} from './slmMoveInterpreter.ts';
import {
	SpokenMoveInputError,
	SpokenMoveProviderError,
	transcribeAudio
} from './openai/spokenMove.ts';
import {
	telemetryStatusForOutcome,
	type VoiceTelemetry,
	type VoiceTelemetryEvent
} from './voiceTelemetry.ts';

export type HostedVoiceTurnInput = Readonly<{
	audio: File;
	resolverContext: ReplayedVoiceResolverContext;
	apiKey: string;
	fetcher?: typeof fetch;
}>;

export type VoiceTurnInterpreters = Readonly<Partial<Record<InterpreterAuthority, MoveInterpreter>>>;

export type CompleteVoiceTurnInput = Readonly<{
	audio: File;
	resolverContext: ReplayedVoiceResolverContext;
	apiKey: string;
	policy: InterpreterPolicy;
	interpreters: VoiceTurnInterpreters;
	shadowRunner?: ShadowRunner;
	onShadowCompletion?: ShadowCompletionObserver;
	diagnosticConsent?: boolean;
	diagnosticEvidenceId?: string;
	onConsentedShadowEvidence?: ConsentedShadowEvidenceObserver;
	telemetry?: VoiceTelemetry;
	fetcher?: typeof fetch;
}>;

export type ShadowCompletion = Readonly<{
	policyVersion: string;
	authority: InterpreterAuthority;
	releaseId: string;
	releaseIdentity: string;
	outcome: VoiceTurnOutcome;
}>;

export type ShadowCompletionObserver = (completion: ShadowCompletion) => void | Promise<void>;

export type InterpreterOutcomeEvidence = Readonly<{
	authority: InterpreterAuthority;
	releaseId: string;
	releaseIdentity: string;
	outcome: VoiceTurnOutcome;
}>;

/** Raw content reaches this background observer only after per-turn consent. */
export type ConsentedShadowEvidence = Readonly<{
	evidenceId: string;
	policyVersion: string;
	finalizedTranscript: string;
	authoritative: InterpreterOutcomeEvidence;
	shadow: InterpreterOutcomeEvidence;
}>;

export type ConsentedShadowEvidenceObserver = (
	evidence: ConsentedShadowEvidence
) => void | Promise<void>;

export type ShadowRun = Readonly<{
	policyVersion: string;
	deployment: InterpreterDeployment & Readonly<{ maxConcurrent: number }>;
	interpreter: MoveInterpreter;
	request: MoveInterpreterRequest;
	resolverContext: ReplayedVoiceResolverContext;
	onCompletion?: ShadowCompletionObserver;
	consentedEvidence?: Omit<ConsentedShadowEvidence, 'shadow'>;
	onConsentedEvidence?: ConsentedShadowEvidenceObserver;
	telemetry?: VoiceTelemetry;
}>;

/**
 * A process-local pressure gate for non-authoritative shadow work. It never
 * waits in a player turn: a saturated slot sheds the shadow invocation first.
 */
export interface ShadowRunner {
	schedule(run: ShadowRun): boolean;
}

export class BoundedShadowRunner implements ShadowRunner {
	#active = 0;
	readonly #pending = new Set<Promise<void>>();

	schedule(run: ShadowRun): boolean {
		if (this.#active >= run.deployment.maxConcurrent) {
			recordTelemetry(run.telemetry, {
				phase: 'shadow',
				status: 'shed',
				authority: run.deployment.authority,
				shadow: true
			});
			return false;
		}
		this.#active += 1;
		recordTelemetry(run.telemetry, {
			phase: 'shadow',
			status: 'scheduled',
			authority: run.deployment.authority,
			shadow: true
		});

		let task: Promise<void>;
		task = this.run(run)
			.catch(() => {
				// Shadow infrastructure is intentionally unable to affect the player turn.
			})
			.finally(() => {
				this.#active -= 1;
				this.#pending.delete(task);
			});
		this.#pending.add(task);
		void task;
		return true;
	}

	/** Test-only synchronization; production never waits for shadow work. */
	async drain(): Promise<void> {
		await Promise.all([...this.#pending]);
	}

	private async run(run: ShadowRun): Promise<void> {
		const startedAt = Date.now();
		const outcome = await outcomeFromInterpreter(
			run.interpreter,
			run.request,
			run.resolverContext,
			run.deployment.timeoutMs,
			{
				authority: run.deployment.authority,
				shadow: true,
				telemetry: run.telemetry
			}
		);
		recordTelemetry(run.telemetry, {
			phase: 'shadow',
			status: telemetryStatusForOutcome(outcome),
			elapsedMs: Date.now() - startedAt,
			authority: run.deployment.authority,
			shadow: true
		});

		const shadow: InterpreterOutcomeEvidence = Object.freeze({
			authority: run.deployment.authority,
			releaseId: run.deployment.release.releaseId,
			releaseIdentity: run.deployment.release.identity,
			outcome
		});
		if (run.onCompletion) {
			try {
				await run.onCompletion(
					Object.freeze({
						policyVersion: run.policyVersion,
						authority: run.deployment.authority,
						releaseId: run.deployment.release.releaseId,
						releaseIdentity: run.deployment.release.identity,
						outcome
					})
				);
			} catch {
				// Diagnostic hooks are non-authoritative and must remain best effort.
			}
		}
		if (run.consentedEvidence && run.onConsentedEvidence) {
			try {
				await run.onConsentedEvidence(
					Object.freeze({ ...run.consentedEvidence, shadow })
				);
			} catch {
				// Diagnostic hooks are non-authoritative and must remain best effort.
			}
		}
	}
}

export type ProductionVoiceTurnInterpreterInput = Readonly<{
	policy: InterpreterPolicy;
	apiKey: string;
	slmEndpoint?: string;
	slmBearerToken?: string;
	fetcher?: typeof fetch;
}>;

/** Construct only the authorities selected by the server deployment policy. */
export function createVoiceTurnInterpreters(
	input: ProductionVoiceTurnInterpreterInput
): VoiceTurnInterpreters {
	const interpreters: Partial<Record<InterpreterAuthority, MoveInterpreter>> = {};
	addInterpreter(interpreters, input.policy.authoritative, input);
	if (input.policy.shadow && !interpreters[input.policy.shadow.authority]) {
		try {
			addInterpreter(interpreters, input.policy.shadow, input);
		} catch (error) {
			if (!(error instanceof SlmMoveInterpreterConfigurationError)) throw error;
			// An optional shadow endpoint is intentionally shed when misconfigured.
		}
	}

	return Object.freeze(interpreters);
}

/**
 * The live Voice Turn coordinator. It selects exactly one authoritative
 * interpreter, runs the shared Move Interpretation Adapter and Move Resolver,
 * then optionally schedules a separate bounded shadow call after that result.
 */
export async function completeVoiceTurn(input: CompleteVoiceTurnInput): Promise<VoiceTurnResponse> {
	const { audio, resolverContext, apiKey, fetcher = fetch } = input;
	const contextId = resolverContext.context.contextId;

	let transcript: string;
	const transcriptionStartedAt = Date.now();
	try {
		transcript = await transcribeAudio(audio, apiKey, fetcher);
	} catch (error) {
		if (error instanceof SpokenMoveProviderError) {
			recordTelemetry(input.telemetry, {
				phase: 'transcription',
				status: error.failure,
				elapsedMs: Date.now() - transcriptionStartedAt,
				authority: input.policy.authoritative.authority
			});
			return failureResponse(contextId, null, error.failure);
		}
		throw error;
	}
	recordTelemetry(input.telemetry, {
		phase: 'transcription',
		status: 'ok',
		elapsedMs: Date.now() - transcriptionStartedAt,
		authority: input.policy.authoritative.authority
	});

	const request = createMoveInterpreterRequest(transcript);
	const authoritativeInterpreter = input.interpreters[input.policy.authoritative.authority];
	if (!authoritativeInterpreter) {
		throw new VoiceTurnConfigurationError('The authoritative Move Interpreter is unavailable.');
	}

	const outcome = await outcomeFromInterpreter(
		authoritativeInterpreter,
		request,
		resolverContext,
		input.policy.authoritative.timeoutMs,
		{
			authority: input.policy.authoritative.authority,
			shadow: false,
			telemetry: input.telemetry
		}
	);

	const shadow = input.policy.shadow;
	if (shadow) {
		const shadowInterpreter = input.interpreters[shadow.authority];
		if (shadowInterpreter && input.shadowRunner) {
			const authoritative: InterpreterOutcomeEvidence = Object.freeze({
				authority: input.policy.authoritative.authority,
				releaseId: input.policy.authoritative.release.releaseId,
				releaseIdentity: input.policy.authoritative.release.identity,
				outcome
			});
			// Scheduling happens after authoritative resolution and is never awaited.
			try {
				input.shadowRunner.schedule({
					policyVersion: input.policy.version,
					deployment: shadow,
					interpreter: shadowInterpreter,
					request,
					resolverContext,
					onCompletion: input.onShadowCompletion,
					consentedEvidence: input.diagnosticConsent === true && input.diagnosticEvidenceId
						? Object.freeze({
							evidenceId: input.diagnosticEvidenceId,
							policyVersion: input.policy.version,
							finalizedTranscript: transcript,
							authoritative
						})
						: undefined,
					onConsentedEvidence: input.onConsentedShadowEvidence,
					telemetry: input.telemetry
				});
			} catch {
				// A failed optional scheduler cannot change an authoritative outcome.
			}
		} else {
			recordTelemetry(input.telemetry, {
				phase: 'shadow',
				status: 'unavailable',
				authority: shadow.authority,
				shadow: true
			});
		}
	}

	return Object.freeze({ transcript, outcome });
}

/**
 * Compatibility wrapper for the ticket-02 hosted path. Production routes use
 * `completeVoiceTurn` with a server policy, while this preserves the same
 * transcript-only acceptance seam for callers that explicitly choose hosted.
 */
export async function completeHostedVoiceTurn(
	input: HostedVoiceTurnInput
): Promise<VoiceTurnResponse> {
	const policy = createInterpreterPolicy({
		version: 'hosted-v1',
		authority: 'hosted',
		authoritativeRelease: {
			releaseId: 'gpt-4o-mini',
			identity: 'move-intent-v2-hosted-v3'
		}
	});
	return completeVoiceTurn({
		...input,
		policy,
		interpreters: createVoiceTurnInterpreters({
			policy,
			apiKey: input.apiKey,
			fetcher: input.fetcher
		})
	});
}

export class VoiceTurnConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VoiceTurnConfigurationError';
	}
}

function addInterpreter(
	interpreters: Partial<Record<InterpreterAuthority, MoveInterpreter>>,
	deployment: InterpreterDeployment,
	input: ProductionVoiceTurnInterpreterInput
): void {
	if (deployment.authority === 'hosted') {
		interpreters.hosted = createHostedMoveInterpreter({
			apiKey: input.apiKey,
			release: deployment.release,
			fetcher: input.fetcher
		});
		return;
	}
	interpreters.slm = createSlmMoveInterpreter({
		endpoint: input.slmEndpoint ?? '',
		bearerToken: input.slmBearerToken ?? '',
		release: deployment.release,
		fetcher: input.fetcher
	});
}

async function outcomeFromInterpreter(
	interpreter: MoveInterpreter,
	request: MoveInterpreterRequest,
	resolverContext: ReplayedVoiceResolverContext,
	timeoutMs: number,
	telemetryContext: Readonly<{
		authority: InterpreterAuthority;
		shadow: boolean;
		telemetry?: VoiceTelemetry;
	}>
): Promise<VoiceTurnOutcome> {
	const contextId = resolverContext.context.contextId;
	let result: MoveInterpreterResult;
	const interpretationStartedAt = Date.now();
	try {
		result = await invokeWithDeadline(interpreter, request, timeoutMs);
	} catch (error) {
		if (error instanceof MoveInterpreterProviderError) {
			recordTelemetry(telemetryContext.telemetry, {
				phase: 'interpretation',
				status: error.failure,
				elapsedMs: Date.now() - interpretationStartedAt,
				authority: telemetryContext.authority,
				shadow: telemetryContext.shadow
			});
			return failedVoiceTurnOutcome(contextId, error.failure);
		}
		throw error;
	}
	recordTelemetry(telemetryContext.telemetry, {
		phase: 'interpretation',
		status: 'ok',
		elapsedMs: Date.now() - interpretationStartedAt,
		authority: telemetryContext.authority,
		shadow: telemetryContext.shadow
	});

	const resolverStartedAt = Date.now();
	try {
		const interpretation = parseCompactMoveInterpretation(result.compact);
		const resolution = resolveMoveIntent(resolverContext.position, interpretation);
		const outcome = voiceTurnOutcomeFromResolution(contextId, resolution);
		recordTelemetry(telemetryContext.telemetry, {
			phase: 'resolver',
			status: telemetryStatusForOutcome(outcome),
			elapsedMs: Date.now() - resolverStartedAt,
			authority: telemetryContext.authority,
			shadow: telemetryContext.shadow
		});
		return outcome;
	} catch (error) {
		if (error instanceof MoveInterpretationValidationError) {
			recordTelemetry(telemetryContext.telemetry, {
				phase: 'resolver',
				status: 'adapter',
				elapsedMs: Date.now() - resolverStartedAt,
				authority: telemetryContext.authority,
				shadow: telemetryContext.shadow
			});
			return failedVoiceTurnOutcome(contextId, 'adapter');
		}
		throw error;
	}
}

async function invokeWithDeadline(
	interpreter: MoveInterpreter,
	request: MoveInterpreterRequest,
	timeoutMs: number
): Promise<MoveInterpreterResult> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new MoveInterpreterProviderError('The Move Interpreter timed out.', 'timeout'));
		}, timeoutMs);
	});

	try {
		return await Promise.race([
			interpreter.interpret(request, { signal: controller.signal }),
			deadline
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function failureResponse(
	contextId: string,
	transcript: string | null,
	failure: Extract<VoiceTurnFailure, 'provider' | 'timeout' | 'adapter'>
): VoiceTurnResponse {
	return Object.freeze({ transcript, outcome: failedVoiceTurnOutcome(contextId, failure) });
}

function recordTelemetry(telemetry: VoiceTelemetry | undefined, event: VoiceTelemetryEvent): void {
	try {
		telemetry?.record(event);
	} catch {
		// Metrics cannot alter a player-facing Voice Turn.
	}
}

export { SlmMoveInterpreterConfigurationError, SpokenMoveInputError };
