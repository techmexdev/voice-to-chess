import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalVoiceQuotas, shouldUseLocalVoiceQuotas } from './localVoiceQuotas.ts';

test('local voice quotas are used only in development without complete Redis credentials', () => {
	assert.equal(shouldUseLocalVoiceQuotas({ development: true }), true);
	assert.equal(
		shouldUseLocalVoiceQuotas({
			development: true,
			redisUrl: 'http://127.0.0.1:8079',
			redisToken: 'local-token'
		}),
		false
	);
	assert.equal(shouldUseLocalVoiceQuotas({ development: false }), false);
});

test('local voice quotas let development proceed without Redis', async () => {
	const quotas = new LocalVoiceQuotas(3);
	const reservation = await quotas.reserveVoiceMove({
		sessionId: 'local-session',
		gameId: 'local-game',
		requestId: 'local-request'
	});

	assert.deepEqual(reservation, { allowed: true, reason: 'ok', remainingGames: 3 });
	assert.deepEqual(await quotas.reserveTts('local-session'), { allowed: true, reason: 'ok' });
	await quotas.releaseVoiceLock('local-session', 'local-request');
	assert.deepEqual(await quotas.finishVoiceGame('local-session', 'local-game'), {
		remainingGames: 3,
		voiceMoves: 1
	});
	assert.equal(await quotas.remainingVoiceGames('local-session'), 3);
});
