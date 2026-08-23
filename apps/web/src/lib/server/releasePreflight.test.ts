import assert from 'node:assert/strict';
import test from 'node:test';
import { createInterpreterPolicy } from './interpreterPolicy.ts';
import {
	checkPrivateSlmReadiness,
	runReleasePreflight
} from './releasePreflight.ts';

const SLM_IDENTITY = 'b'.repeat(64);

function shadowPolicy() {
	return createInterpreterPolicy({
		version: 'hosted-shadow-v1',
		authority: 'hosted',
		authoritativeRelease: { releaseId: 'gpt-4o-mini', identity: 'move-intent-v2-hosted-v1' },
		shadowAuthority: 'slm',
		shadowRelease: { releaseId: 'qwen-move-intent-v2', identity: SLM_IDENTITY }
	});
}

function environment() {
	return {
		OPENAI_API_KEY: 'server-openai-secret',
		SLM_INTERPRETER_URL: 'https://private.example/inference',
		SLM_INTERPRETER_TOKEN: 'server-slm-secret',
		VOICE_GATEWAY_REGION: 'iad1',
		VOICE_REDIS_REGION: 'iad1',
		SLM_INTERPRETER_REGION: 'us-east-1',
		SLM_INTERPRETER_GPU_CLASS: 'NVIDIA-L4',
		SLM_INTERPRETER_MIN_WARM_REPLICAS: '1',
		SHADOW_EVIDENCE_OPERATOR_TOKEN: 'server-evidence-review-secret',
		RELEASE_PREFLIGHT_OPERATOR_TOKEN: 'server-preflight-secret'
	};
}

test('preflight accepts a server-only policy, matching private release, and available quota', async () => {
	const result = await runReleasePreflight({
		environment: environment(),
		policy: shadowPolicy(),
		checkSlmReadiness: async ({ expectedRelease }) => {
			assert.equal(expectedRelease.identity, SLM_IDENTITY);
		},
		checkQuota: async () => {}
	});

	assert.equal(result.status, 'ready');
	assert.deepEqual(result.checks.map((check) => check.status), ['passed', 'passed', 'passed', 'passed', 'passed']);
	assert.equal(result.policy?.authoritative.authority, 'hosted');
	assert.deepEqual(result.topology, {
		gatewayRegion: 'iad1',
		redisRegion: 'iad1',
		slm: { region: 'us-east-1', gpuClass: 'NVIDIA-L4', minimumWarmReplicas: 1 }
	});
	assert.equal(JSON.stringify(result).includes('server-openai-secret'), false);
	assert.equal(JSON.stringify(result).includes('server-slm-secret'), false);
	assert.equal(JSON.stringify(result).includes('server-evidence-review-secret'), false);
	assert.equal(JSON.stringify(result).includes('server-preflight-secret'), false);
	assert.equal(JSON.stringify(result).includes('private.example'), false);
});

test('preflight blocks missing or malformed placement identities before promotion', async () => {
	for (const environmentOverride of [
		{ SLM_INTERPRETER_REGION: '' },
		{ SLM_INTERPRETER_GPU_CLASS: 'untrusted value' },
		{ SLM_INTERPRETER_MIN_WARM_REPLICAS: '0' },
		{ VOICE_GATEWAY_REGION: '' },
		{ VOICE_REDIS_REGION: 'west coast' }
	]) {
		const result = await runReleasePreflight({
			environment: { ...environment(), ...environmentOverride },
			policy: shadowPolicy(),
			checkSlmReadiness: async () => {},
			checkQuota: async () => {}
		});
		assert.equal(result.status, 'blocked');
		assert.equal(result.topology, null);
		assert.equal(result.checks.find((check) => check.name === 'topology')?.status, 'failed');
		assert.equal(JSON.stringify(result).includes('untrusted value'), false);
	}
});

test('preflight blocks missing secrets or unavailable quota with safe failures', async () => {
	const result = await runReleasePreflight({
		environment: { ...environment(), SLM_INTERPRETER_TOKEN: '' },
		policy: shadowPolicy(),
		checkQuota: async () => { throw new Error('redis endpoint https://secret.example failed'); }
	});

	assert.equal(result.status, 'blocked');
	assert.equal(result.checks.find((check) => check.name === 'server_secrets')?.status, 'failed');
	assert.equal(result.checks.find((check) => check.name === 'slm_readiness')?.status, 'failed');
	assert.equal(result.checks.find((check) => check.name === 'quota')?.status, 'failed');
	assert.equal(JSON.stringify(result).includes('secret.example'), false);
});

test('preflight blocks an endpoint or token configured for the browser', async () => {
	const result = await runReleasePreflight({
		environment: { ...environment(), PUBLIC_SLM_INTERPRETER_URL: 'https://browser.example' },
		policy: shadowPolicy(),
		checkQuota: async () => {}
	});

	assert.equal(result.status, 'blocked');
	assert.equal(result.checks.find((check) => check.name === 'server_secrets')?.status, 'failed');
	assert.equal(JSON.stringify(result).includes('browser.example'), false);
});

test('preflight requires a server-only operator bearer before a release can be ready', async () => {
	const result = await runReleasePreflight({
		environment: { ...environment(), RELEASE_PREFLIGHT_OPERATOR_TOKEN: '' },
		policy: shadowPolicy(),
		checkQuota: async () => {}
	});

	assert.equal(result.status, 'blocked');
	assert.equal(result.checks.find((check) => check.name === 'server_secrets')?.status, 'failed');
});

test('private readiness rejects a mismatched immutable release without a content request', async () => {
	let method = '';
	let body: BodyInit | null | undefined;
	await assert.rejects(
		() => checkPrivateSlmReadiness({
			endpoint: 'https://private.example/v1/move-interpretations',
			bearerToken: 'server-slm-secret',
			expectedRelease: { releaseId: 'qwen-move-intent-v2', identity: SLM_IDENTITY },
			fetcher: async (_input, init) => {
				method = init?.method ?? '';
				body = init?.body;
				return Response.json({
					schema: 'move-interpreter-readiness/v1',
					ready: true,
					behavior_contract: 'move-intent-behavior/v2',
					release: { release_id: 'qwen-move-intent-v2', identity_sha256: 'c'.repeat(64) }
				});
			}
		})
	);
	assert.equal(method, 'GET');
	assert.equal(body, undefined);
});
