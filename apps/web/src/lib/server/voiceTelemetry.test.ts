import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceTelemetry } from './voiceTelemetry.ts';

test('voice telemetry keeps bounded phase counters without raw content', () => {
	const metrics: Array<{ name: string; increment: number | undefined }> = [];
	const telemetry = createVoiceTelemetry((name, increment) => {
		metrics.push({ name, increment });
	});

	telemetry.record({ phase: 'transcription', status: 'ok', elapsedMs: 12, authority: 'hosted' });
	telemetry.record({ phase: 'interpretation', status: 'provider', elapsedMs: 7, authority: 'slm' });
	telemetry.record({ phase: 'resolver', status: 'resolved', elapsedMs: 1, authority: 'hosted' });
	telemetry.record({ phase: 'feedback', status: 'ok', elapsedMs: 4 });
	telemetry.record({ phase: 'quota', status: 'allowed', elapsedMs: 2 });
	telemetry.record({ phase: 'shadow', status: 'shed', authority: 'slm', shadow: true });

	const names = metrics.map((metric) => metric.name);
	for (const expected of [
		'voice_hosted_transcription_count',
		'voice_slm_interpretation_provider',
		'voice_hosted_resolver_resolved',
		'voice_feedback_ok',
		'voice_quota_allowed',
		'voice_shadow_shed'
	]) {
		assert.ok(names.includes(expected), expected);
	}
	assert.ok(names.every((name) => name.length <= 48));
	assert.ok(names.every((name) => !name.includes('pawn_to_e4')));
});

test('a metrics sink failure cannot throw from a Voice Turn observer', () => {
	const telemetry = createVoiceTelemetry(() => {
		throw new Error('metrics offline');
	});

	assert.doesNotThrow(() => telemetry.record({ phase: 'shadow', status: 'shed' }));
});
