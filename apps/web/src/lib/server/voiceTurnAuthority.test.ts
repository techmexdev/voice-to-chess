import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSession } from '../game/GameSession.ts';
import { replayVoiceResolverContext } from '../game/VoiceResolverContext.ts';
import {
	createInterpreterPolicy,
	type InterpreterPolicy
} from './interpreterPolicy.ts';
import {
	type InterpreterAuthority,
	type InterpreterReleaseIdentity,
	type MoveInterpreter,
	type MoveInterpreterRequest,
	MoveInterpreterProviderError
} from './moveInterpreter.ts';
import {
	BoundedShadowRunner,
	completeVoiceTurn,
	type ConsentedShadowEvidence,
	type ShadowCompletion,
	type ShadowRunner
} from './voiceTurn.ts';
import { createMoveInterpreterRequest } from './moveInterpreter.ts';
import { createVoiceTelemetry } from './voiceTelemetry.ts';

const HOSTED_RELEASE = Object.freeze({ releaseId: 'gpt-4o-mini', identity: 'hosted-v1' });
const SLM_RELEASE = Object.freeze({ releaseId: 'qwen-move-intent-v2', identity: 'd'.repeat(64) });

function policy(options: {
	authority?: InterpreterAuthority;
	shadow?: InterpreterAuthority | null;
	authoritativeTimeoutMs?: number;
	shadowTimeoutMs?: number;
	shadowMaxConcurrent?: number;
	version?: string;
} = {}): InterpreterPolicy {
	const authority = options.authority ?? 'hosted';
	const shadow = options.shadow ?? null;
	return createInterpreterPolicy({
		version: options.version ?? 'authority-v1',
		authority,
		authoritativeRelease: authority === 'hosted' ? HOSTED_RELEASE : SLM_RELEASE,
		authoritativeTimeoutMs: options.authoritativeTimeoutMs ?? 100,
		shadowAuthority: shadow,
		shadowRelease: shadow === 'hosted' ? HOSTED_RELEASE : shadow === 'slm' ? SLM_RELEASE : undefined,
		shadowTimeoutMs: options.shadowTimeoutMs ?? 20,
		shadowMaxConcurrent: options.shadowMaxConcurrent ?? 1
	});
}

function interpreter(
	authority: InterpreterAuthority,
	compact: string | (() => Promise<string>),
	release: InterpreterReleaseIdentity = authority === 'hosted' ? HOSTED_RELEASE : SLM_RELEASE
): MoveInterpreter {
	return Object.freeze({
		authority,
		release,
		async interpret(request: MoveInterpreterRequest) {
			assert.deepEqual(Object.keys(request).sort(), ['behaviorContract', 'finalizedTranscript', 'schema']);
			assert.equal(request.finalizedTranscript, 'pawn to e4');
			const value = typeof compact === 'string' ? compact : await compact();
			return Object.freeze({ compact: value, release });
		}
	});
}

function context() {
	const session = new GameSession();
	return { session, resolverContext: replayVoiceResolverContext(session.createVoiceResolverContext()) };
}

function audio(): File {
	return new File(['audio'], 'spoken-move.webm', { type: 'audio/webm' });
}

async function run(
	input: Omit<Parameters<typeof completeVoiceTurn>[0], 'audio' | 'apiKey' | 'fetcher'>
) {
	return completeVoiceTurn({
		...input,
		audio: audio(),
		apiKey: 'test-key',
		fetcher: async (request) => {
			assert.equal(String(request).endsWith('/audio/transcriptions'), true);
			return Response.json({ text: 'pawn to e4' });
		}
	});
}

test('an SLM disagreement stays in shadow and cannot change the authoritative result or Game Session', async () => {
	const { session, resolverContext } = context();
	const before = session.snapshot();
	const completions: ShadowCompletion[] = [];
	const runner = new BoundedShadowRunner();
	const result = await run({
		resolverContext,
		policy: policy({ shadow: 'slm' }),
		interpreters: {
			hosted: interpreter('hosted', 'M|P|e4|-|-|-|-|-|-'),
			slm: interpreter('slm', 'M|P|e3|-|-|-|-|-|-')
		},
		shadowRunner: runner,
		onShadowCompletion: (completion) => {
			completions.push(completion);
		}
	});

	assert.deepEqual(result.outcome, {
		schema: 'voice-turn-outcome/v1',
		contextId: resolverContext.context.contextId,
		kind: 'resolved',
		move: { from: 'e2', to: 'e4' }
	});
	assert.deepEqual(session.snapshot(), before);
	await runner.drain();
	assert.equal(completions.length, 1);
	assert.deepEqual(completions[0]?.outcome, {
		schema: 'voice-turn-outcome/v1',
		contextId: resolverContext.context.contextId,
		kind: 'resolved',
		move: { from: 'e2', to: 'e3' }
	});
});

test('a malformed or timed-out shadow is non-authoritative', async () => {
	for (const [name, compact, expectedFailure] of [
		['malformed', async () => 'not compact', 'adapter'],
		['timeout', () => new Promise<string>(() => {}), 'timeout']
	] as const) {
		const { session, resolverContext } = context();
		const before = session.snapshot();
		const completions: ShadowCompletion[] = [];
		const runner = new BoundedShadowRunner();
		const result = await run({
			resolverContext,
			policy: policy({ shadow: 'slm', shadowTimeoutMs: 5 }),
			interpreters: {
				hosted: interpreter('hosted', 'M|P|e4|-|-|-|-|-|-'),
				slm: interpreter('slm', compact)
			},
			shadowRunner: runner,
			onShadowCompletion: (completion) => {
				completions.push(completion);
			}
		});

		assert.equal(result.outcome.kind, 'resolved', name);
		assert.deepEqual(session.snapshot(), before, name);
		await runner.drain();
		assert.equal(completions[0]?.outcome.kind, 'failure', name);
		if (completions[0]?.outcome.kind === 'failure') {
			assert.equal(completions[0].outcome.failure, expectedFailure, name);
		}
	}
});

test('a malformed, provider-failed, or timed-out authority never falls back to its shadow', async () => {
	for (const [name, hosted] of [
		['malformed', interpreter('hosted', 'not compact')],
		['provider', interpreter('hosted', async () => { throw new MoveInterpreterProviderError('offline'); })],
		['timeout', interpreter('hosted', async () => { throw new MoveInterpreterProviderError('slow', 'timeout'); })]
	] as const) {
		const { session, resolverContext } = context();
		const before = session.snapshot();
		const runner = new BoundedShadowRunner();
		const result = await run({
			resolverContext,
			policy: policy({ shadow: 'slm' }),
			interpreters: {
				hosted,
				slm: interpreter('slm', 'M|P|e4|-|-|-|-|-|-')
			},
			shadowRunner: runner
		});

		assert.equal(result.outcome.kind, 'failure', name);
		if (result.outcome.kind === 'failure') {
			assert.equal(result.outcome.failure, name === 'malformed' ? 'adapter' : name, name);
		}
		assert.deepEqual(session.snapshot(), before, name);
		await runner.drain();
	}
});

test('missing or shed shadow work cannot alter the authoritative result', async () => {
	for (const [name, shadowRunner] of [
		['missing', undefined],
		['shed', { schedule: () => false } satisfies ShadowRunner]
	] as const) {
		const { session, resolverContext } = context();
		const before = session.snapshot();
		const result = await run({
			resolverContext,
			policy: policy({ shadow: 'slm' }),
			interpreters: { hosted: interpreter('hosted', 'M|P|e4|-|-|-|-|-|-') },
			shadowRunner
		});

		assert.equal(result.outcome.kind, 'resolved', name);
		assert.deepEqual(session.snapshot(), before, name);
	}
});

test('only explicit per-turn diagnostic consent receives the transcript and both release outcomes', async () => {
	for (const diagnosticConsent of [false, true]) {
		const { resolverContext } = context();
		const evidence: ConsentedShadowEvidence[] = [];
		const runner = new BoundedShadowRunner();
		const result = await run({
			resolverContext,
			policy: policy({ shadow: 'slm' }),
			interpreters: {
				hosted: interpreter('hosted', 'M|P|e4|-|-|-|-|-|-'),
				slm: interpreter('slm', 'M|P|e3|-|-|-|-|-|-')
			},
			shadowRunner: runner,
			diagnosticConsent,
			diagnosticEvidenceId: 'shadow-evidence-123',
			onConsentedShadowEvidence: (value) => { evidence.push(value); }
		});

		assert.equal(result.outcome.kind, 'resolved');
		await runner.drain();
		assert.equal(evidence.length, diagnosticConsent ? 1 : 0);
		if (diagnosticConsent) {
			assert.equal(evidence[0]?.finalizedTranscript, 'pawn to e4');
			assert.equal(evidence[0]?.authoritative.authority, 'hosted');
			assert.equal(evidence[0]?.shadow.authority, 'slm');
		}
	}
});

test('a saturated shadow runner records shedding before waiting on player work', async () => {
	const { resolverContext } = context();
	const activePolicy = policy({ shadow: 'slm', shadowTimeoutMs: 100 });
	if (!activePolicy.shadow) throw new Error('Expected a shadow deployment.');
	const metrics: string[] = [];
	const telemetry = createVoiceTelemetry((name) => { metrics.push(name); });
	let releaseHeldShadow: ((value: string) => void) | undefined;
	const heldShadow = interpreter('slm', () => new Promise<string>((resolve) => {
		releaseHeldShadow = resolve;
	}));
	const runner = new BoundedShadowRunner();
	const shadowRun = {
		policyVersion: activePolicy.version,
		deployment: activePolicy.shadow,
		interpreter: heldShadow,
		request: createMoveInterpreterRequest('pawn to e4'),
		resolverContext,
		telemetry
	};

	assert.equal(runner.schedule(shadowRun), true);
	assert.equal(runner.schedule(shadowRun), false);
	assert.ok(metrics.includes('voice_shadow_shed'));
	releaseHeldShadow?.('M|P|e3|-|-|-|-|-|-');
	await runner.drain();
});

test('a manual policy rollback changes the next authoritative interpreter without changing Game Session state', async () => {
	const { session, resolverContext } = context();
	const before = session.snapshot();
	const interpreters = {
		hosted: interpreter('hosted', 'M|P|e4|-|-|-|-|-|-'),
		slm: interpreter('slm', 'M|P|e3|-|-|-|-|-|-')
	};

	const slmResult = await run({
		resolverContext,
		policy: policy({ authority: 'slm', version: 'slm-pilot-v1' }),
		interpreters
	});
	const rollbackResult = await run({
		resolverContext,
		policy: policy({ authority: 'hosted', version: 'hosted-rollback-v2' }),
		interpreters
	});

	assert.deepEqual(slmResult.outcome.kind, 'resolved');
	assert.deepEqual(rollbackResult.outcome, {
		schema: 'voice-turn-outcome/v1',
		contextId: resolverContext.context.contextId,
		kind: 'resolved',
		move: { from: 'e2', to: 'e4' }
	});
	assert.deepEqual(session.snapshot(), before);
});
