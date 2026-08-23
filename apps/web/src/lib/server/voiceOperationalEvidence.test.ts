import assert from 'node:assert/strict';
import test from 'node:test';
import { createInterpreterPolicy } from './interpreterPolicy.ts';
import {
	VOICE_OPERATIONAL_EVIDENCE_RETENTION_SECONDS,
	createVoiceOperationalEvidenceStore
} from './voiceOperationalEvidence.ts';

function memoryRedis() {
	const commands: Array<readonly (string | number)[]> = [];
	const command = async <T>(args: readonly (string | number)[]): Promise<T> => {
		commands.push(args);
		return 'OK' as T;
	};
	return { command, commands };
}

test('operational evidence retains only a turn ID, model-policy identity, outcome class, and phase timings', async () => {
	const redis = memoryRedis();
	const policy = createInterpreterPolicy({
		version: 'hosted-shadow-v1',
		authority: 'hosted',
		authoritativeRelease: { releaseId: 'gpt-4o-mini', identity: 'move-intent-v2-hosted-v1' },
		shadowAuthority: 'slm',
		shadowRelease: { releaseId: 'qwen-move-intent-v2', identity: 'a'.repeat(64) }
	});
	const store = createVoiceOperationalEvidenceStore({
		command: redis.command,
		now: () => new Date('2026-08-22T12:00:00.000Z')
	});

	assert.equal(await store.save({
		voiceTurnId: 'voice-turn-123',
		policy,
		outcome: Object.freeze({
			schema: 'voice-turn-outcome/v1',
			contextId: 'resolver-context-not-retained',
			kind: 'resolved' as const,
			move: Object.freeze({ from: 'e2', to: 'e4' })
		}),
		phaseSummary: [
			{ phase: 'quota', status: 'allowed', elapsedMs: 2 },
			{ phase: 'transcription', status: 'ok', elapsedMs: 17, authority: 'hosted' },
			{ phase: 'interpretation', status: 'resolved', elapsedMs: 8, authority: 'hosted' }
		]
	}), true);

	const write = redis.commands[0];
	assert.equal(write?.[0], 'SET');
	assert.equal(write?.[1], 'voice-operational:v1:voice-turn-123');
	assert.equal(write?.[3], 'EX');
	assert.equal(write?.[4], VOICE_OPERATIONAL_EVIDENCE_RETENTION_SECONDS);
	assert.equal(write?.[5], 'NX');
	const record = JSON.parse(String(write?.[2])) as Record<string, unknown>;
	assert.deepEqual(record.outcome, { class: 'resolved' });
	assert.deepEqual(record.policy, {
		version: 'hosted-shadow-v1',
		authority: 'hosted',
		releaseId: 'gpt-4o-mini',
		releaseIdentity: 'move-intent-v2-hosted-v1',
		shadow: {
			authority: 'slm',
			releaseId: 'qwen-move-intent-v2',
			releaseIdentity: 'a'.repeat(64)
		}
	});
	const serialized = JSON.stringify(record);
	for (const forbidden of ['resolver-context-not-retained', '"from"', '"to"', 'pawn to e4', 'audio/webm', 'fen', 'compact']) {
		assert.equal(serialized.includes(forbidden), false, forbidden);
	}
});

test('operational evidence is best effort and rejects invalid turn identifiers', async () => {
	const policy = createInterpreterPolicy({
		version: 'hosted-v1',
		authority: 'hosted',
		authoritativeRelease: { releaseId: 'gpt-4o-mini', identity: 'move-intent-v2-hosted-v1' }
	});
	const store = createVoiceOperationalEvidenceStore({
		command: async () => { throw new Error('offline'); }
	});
	assert.equal(await store.save({
		voiceTurnId: 'not valid',
		policy,
		outcome: Object.freeze({
			schema: 'voice-turn-outcome/v1',
			contextId: 'context',
			kind: 'unknown' as const
		}),
		phaseSummary: []
	}), false);
});
