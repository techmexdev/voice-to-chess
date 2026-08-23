import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { failedVoiceTurnOutcome, type VoiceTurnOutcome } from '$lib/game/VoiceTurn';
import { InterpreterPolicyError, readServerInterpreterPolicy } from '$lib/server/interpreterPolicy';
import {
	BoundedShadowRunner,
	SlmMoveInterpreterConfigurationError,
	completeVoiceTurn,
	createVoiceTurnInterpreters,
	SpokenMoveInputError
} from '$lib/server/voiceTurn';
import { VoiceTurnRequestError, readVoiceTurnRequest } from '$lib/server/voiceTurnRequest';
import { reserveVoiceMove, releaseVoiceLock } from '$lib/server/quotas';
import { recordMetric, redisCommand } from '$lib/server/redis';
import { saveConsentedShadowEvidence } from '$lib/server/consentedShadowEvidence';
import { readAccessPass } from '$lib/server/security/accessPass';
import { dailyIpHash, hasExpectedOrigin } from '$lib/server/security/requestSecurity';
import { createVoiceTelemetry } from '$lib/server/voiceTelemetry';
import { saveVoiceOperationalEvidence } from '$lib/server/voiceOperationalEvidence';

// One process-local gate prevents optional shadow traffic from accumulating in
// a server worker. It has no quota, Game Session, feedback, or TTS dependency.
const shadowRunner = new BoundedShadowRunner();

export const POST: RequestHandler = async (event) => {
	const { request, fetch } = event;
	if (!hasExpectedOrigin(event)) return json({ error: 'The request origin is invalid.' }, { status: 403 });
	const pass = readAccessPass(event.cookies);
	if (!pass) return json({ error: 'Voice access expired. Start a new game to continue.' }, { status: 401 });
	if (!env.OPENAI_API_KEY) return json({ error: 'Speech input is not configured.' }, { status: 503 });
	const telemetry = createVoiceTelemetry(recordMetric);

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'The audio request could not be read.' }, { status: 400 });
	}

	let voiceRequest: ReturnType<typeof readVoiceTurnRequest>;
	try {
		voiceRequest = readVoiceTurnRequest(form);
	} catch (error) {
		if (error instanceof VoiceTurnRequestError) return json({ error: error.message }, { status: error.status });
		console.error(error);
		return json({ error: 'The voice resolver context could not be read.' }, { status: 400 });
	}

	let policy: ReturnType<typeof readServerInterpreterPolicy>;
	let interpreters: ReturnType<typeof createVoiceTurnInterpreters>;
	try {
		policy = readServerInterpreterPolicy(env);
		interpreters = createVoiceTurnInterpreters({
			policy,
			apiKey: env.OPENAI_API_KEY,
			slmEndpoint: env.SLM_INTERPRETER_URL,
			slmBearerToken: env.SLM_INTERPRETER_TOKEN,
			fetcher: fetch
		});
	} catch (error) {
		if (error instanceof InterpreterPolicyError || error instanceof SlmMoveInterpreterConfigurationError) {
			console.error(error.message);
			return json({ error: 'Voice interpretation is not configured.' }, { status: 503 });
		}
		console.error(error);
		return json({ error: 'Voice interpretation is not configured.' }, { status: 503 });
	}
	const saveOperationalEvidence = (outcome: VoiceTurnOutcome): void => {
		void saveVoiceOperationalEvidence({
			voiceTurnId: voiceRequest.requestId,
			policy,
			outcome,
			phaseSummary: telemetry.snapshot()
		}, redisCommand);
	};

	let reservation: Awaited<ReturnType<typeof reserveVoiceMove>>;
	const quotaStartedAt = Date.now();
	try {
		reservation = await reserveVoiceMove({
			sessionId: pass.sessionId,
			ipHash: dailyIpHash(event),
			gameId: voiceRequest.gameId,
			requestId: voiceRequest.requestId
		});
	} catch (error) {
		telemetry.record({
			phase: 'quota',
			status: 'unavailable',
			elapsedMs: Date.now() - quotaStartedAt
		});
		console.error(error);
		saveOperationalEvidence(failedVoiceTurnOutcome(
			voiceRequest.resolverContext.context.contextId,
			'quota'
		));
		return json({ error: 'Voice limits are temporarily unavailable. Use typed or board moves.' }, { status: 503 });
	}
	telemetry.record({
		phase: 'quota',
		status: reservation.allowed ? 'allowed' : 'rejected',
		elapsedMs: Date.now() - quotaStartedAt
	});
	if (!reservation.allowed) {
		void recordMetric(`voice_failure_quota_${reservation.reason}`);
		const outcome = failedVoiceTurnOutcome(voiceRequest.resolverContext.context.contextId, 'quota');
		saveOperationalEvidence(outcome);
		return json(
			{
				transcript: null,
				outcome,
				error: quotaMessage(reservation.reason),
				remainingGames: reservation.remainingGames
			},
			{ status: reservation.reason === 'duplicate' || reservation.reason === 'busy' ? 409 : 429 }
		);
	}

	const voiceTurnStartedAt = Date.now();
	try {
		const result = await completeVoiceTurn({
			audio: voiceRequest.audio,
			resolverContext: voiceRequest.resolverContext,
			apiKey: env.OPENAI_API_KEY,
			policy,
			interpreters,
			shadowRunner,
			diagnosticConsent: voiceRequest.diagnosticConsent,
			diagnosticEvidenceId: voiceRequest.requestId,
			onConsentedShadowEvidence: voiceRequest.diagnosticConsent
				? async (evidence) => { await saveConsentedShadowEvidence(evidence, redisCommand); }
				: undefined,
			telemetry,
			fetcher: fetch
		});
		void recordMetric(`voice_${result.outcome.kind}`);
		if (result.outcome.kind === 'failure') {
			void recordMetric(`voice_failure_${result.outcome.failure}`);
		}
		saveOperationalEvidence(result.outcome);
		return json({ ...result, remainingGames: reservation.remainingGames });
	} catch (error) {
		const contextId = voiceRequest.resolverContext.context.contextId;
		if (error instanceof SpokenMoveInputError) {
			void recordMetric('voice_failure_provider_input');
			const outcome = failedVoiceTurnOutcome(contextId, 'provider');
			saveOperationalEvidence(outcome);
			return json(
				{
					transcript: null,
					outcome,
					error: error.message,
					remainingGames: reservation.remainingGames
				},
				{ status: 400 }
			);
		}
		console.error(error);
		void recordMetric('voice_failure_internal');
		const outcome = failedVoiceTurnOutcome(contextId, 'internal');
		saveOperationalEvidence(outcome);
		return json(
			{
				transcript: null,
				outcome,
				error: 'The spoken move could not be processed. Please try again.',
				remainingGames: reservation.remainingGames
			},
			{ status: 502 }
		);
	} finally {
		void recordMetric('voice_latency_ms_sum', Date.now() - voiceTurnStartedAt);
		void recordMetric('voice_latency_count');
		try {
			await releaseVoiceLock(pass.sessionId, voiceRequest.requestId);
		} catch (error) {
			console.error(error);
		}
	}
};

function quotaMessage(reason: string): string {
	switch (reason) {
		case 'pace': return 'Please wait two seconds before the next voice move.';
		case 'minute': return 'Voice input is moving too quickly. Try again in a minute.';
		case 'games': return 'No voice games remain today. Typed and board play are still available.';
		case 'day': return 'This device has reached today\'s voice limit.';
		case 'global_day': return 'Today\'s public voice limit has been reached.';
		case 'global_month': return 'This month\'s public voice budget has been reached.';
		case 'busy': return 'The previous voice move is still processing.';
		case 'duplicate': return 'This voice move was already submitted.';
		default: return 'Voice input is temporarily limited.';
	}
}
