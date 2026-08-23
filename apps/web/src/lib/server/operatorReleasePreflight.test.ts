import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createOperatorReleasePreflightHandler
} from './operatorReleasePreflight.ts';
import { VOICE_RUNTIME_PREFLIGHT_SCHEMA, type ReleasePreflight } from './releasePreflight.ts';

function readyReceipt(): ReleasePreflight {
	return Object.freeze({
		schema: VOICE_RUNTIME_PREFLIGHT_SCHEMA,
		status: 'ready',
		policy: Object.freeze({
			version: 'hosted-staging-v1',
			behaviorContract: 'move-intent-behavior/v2',
			authoritative: Object.freeze({
				authority: 'hosted',
				releaseId: 'gpt-4o-mini',
				releaseIdentity: 'move-intent-v2-hosted-v1'
			}),
			shadow: null
		}),
		topology: Object.freeze({
			gatewayRegion: 'iad1',
			redisRegion: 'iad1',
			slm: null
		}),
		checks: Object.freeze([])
	});
}

test('the operator preflight endpoint requires its dedicated bearer before running checks', async () => {
	let calls = 0;
	const handler = createOperatorReleasePreflightHandler({
		operatorToken: 'preflight-token',
		run: async () => {
			calls += 1;
			return readyReceipt();
		}
	});

	const denied = await handler(new Request('https://app.example/api/operator/release-preflight'));
	assert.equal(denied.status, 404);
	assert.equal(denied.headers.get('cache-control'), 'no-store');
	assert.equal(calls, 0);

	const allowed = await handler(new Request('https://app.example/api/operator/release-preflight', {
		headers: { Authorization: 'Bearer preflight-token' }
	}));
	assert.equal(allowed.status, 200);
	assert.equal(allowed.headers.get('cache-control'), 'no-store');
	assert.equal((await allowed.json() as ReleasePreflight).status, 'ready');
	assert.equal(calls, 1);
});

test('an unexpected preflight error returns a safe blocked receipt', async () => {
	const handler = createOperatorReleasePreflightHandler({
		operatorToken: 'preflight-token',
		run: async () => { throw new Error('SLM token super-secret failed'); }
	});

	const response = await handler(new Request('https://app.example/api/operator/release-preflight', {
		headers: { Authorization: 'Bearer preflight-token' }
	}));
	const receipt = await response.json() as ReleasePreflight;

	assert.equal(response.status, 503);
	assert.equal(receipt.status, 'blocked');
	assert.equal(receipt.checks[0]?.message, 'The release preflight could not run.');
	assert.equal(JSON.stringify(receipt).includes('super-secret'), false);
	assert.equal(JSON.stringify(receipt).includes('SLM token'), false);
});
