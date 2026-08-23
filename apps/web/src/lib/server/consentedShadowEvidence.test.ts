import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CONSENTED_SHADOW_EVIDENCE_RETENTION_SECONDS,
	createConsentedShadowEvidenceStore
} from './consentedShadowEvidence.ts';
import type { ConsentedShadowEvidence } from './voiceTurn.ts';

function evidence(): ConsentedShadowEvidence {
	return Object.freeze({
		evidenceId: 'shadow-evidence-123',
		policyVersion: 'hosted-shadow-v1',
		finalizedTranscript: 'pawn to e4',
		authoritative: Object.freeze({
			authority: 'hosted',
			releaseId: 'gpt-4o-mini',
			releaseIdentity: 'move-intent-v2-hosted-v1',
			outcome: Object.freeze({
				schema: 'voice-turn-outcome/v1',
				contextId: 'voice-turn-1',
				kind: 'resolved',
				move: Object.freeze({ from: 'e2', to: 'e4' })
			})
		}),
		shadow: Object.freeze({
			authority: 'slm',
			releaseId: 'qwen-move-intent-v2',
			releaseIdentity: 'a'.repeat(64),
			outcome: Object.freeze({
				schema: 'voice-turn-outcome/v1',
				contextId: 'voice-turn-1',
				kind: 'unknown'
			})
		})
	});
}

function memoryRedis() {
	const values = new Map<string, string>();
	const commands: Array<readonly (string | number)[]> = [];
	const command = async <T>(args: readonly (string | number)[]): Promise<T> => {
		commands.push(args);
		switch (args[0]) {
			case 'SET': {
				const key = String(args[1]);
				if (values.has(key)) return null as T;
				values.set(key, String(args[2]));
				return 'OK' as T;
			}
			case 'GET': return (values.get(String(args[1])) ?? null) as T;
			case 'DEL': return (values.delete(String(args[1])) ? 1 : 0) as T;
			default: throw new Error('unexpected Redis command');
		}
	};
	return { command, commands, values };
}

test('consented shadow evidence stores both outcomes with a fixed retention and deletion path', async () => {
	const redis = memoryRedis();
	const store = createConsentedShadowEvidenceStore({
		command: redis.command,
		now: () => new Date('2026-08-22T12:00:00.000Z')
	});

	assert.equal(await store.save(evidence()), true);
	const write = redis.commands[0];
	assert.deepEqual(write?.slice(0, 4), [
		'SET',
		'shadow-evidence:v1:shadow-evidence-123',
		write?.[2],
		'EX'
	]);
	assert.equal(write?.[4], CONSENTED_SHADOW_EVIDENCE_RETENTION_SECONDS);
	assert.equal(write?.[5], 'NX');

	const stored = await store.read('shadow-evidence-123');
	assert.equal(stored?.finalizedTranscript, 'pawn to e4');
	assert.equal(stored?.consent, 'per-turn-shadow-evidence/v1');
	assert.equal(stored?.authoritative.authority, 'hosted');
	assert.equal(stored?.shadow.authority, 'slm');
	assert.equal(JSON.stringify(stored).includes('resolverContext'), false);
	assert.equal(JSON.stringify(stored).includes('fen'), false);
	assert.equal(JSON.stringify(stored).includes('compact'), false);

	assert.equal(await store.delete('shadow-evidence-123'), true);
	assert.equal(await store.read('shadow-evidence-123'), null);
});

test('expired, invalid, or unavailable evidence fails closed', async () => {
	const redis = memoryRedis();
	const store = createConsentedShadowEvidenceStore({ command: redis.command });
	assert.equal(await store.save(evidence()), true);
	const key = 'shadow-evidence:v1:shadow-evidence-123';
	const tampered = JSON.parse(redis.values.get(key) ?? '{}') as Record<string, unknown>;
	tampered.authoritative = {
		...(tampered.authoritative as Record<string, unknown>),
		resolverContext: 'must never be returned'
	};
	redis.values.set(key, JSON.stringify(tampered));
	assert.equal(await store.read('shadow-evidence-123'), null);
	redis.values.clear(); // Redis TTL expiry is represented as a missing key.
	assert.equal(await store.read('shadow-evidence-123'), null);
	assert.equal(await store.read('not-valid'), null);

	const unavailable = createConsentedShadowEvidenceStore({
		command: async () => { throw new Error('offline'); }
	});
	assert.equal(await unavailable.save(evidence()), false);
	assert.equal(await unavailable.delete('shadow-evidence-123'), false);
});
