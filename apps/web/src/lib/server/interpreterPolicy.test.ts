import assert from 'node:assert/strict';
import test from 'node:test';
import {
	InterpreterPolicyError,
	createInterpreterPolicy,
	readServerInterpreterPolicy
} from './interpreterPolicy.ts';

const SLM_IDENTITY = 'a'.repeat(64);

test('the default server policy keeps gpt-4o-mini authoritative', () => {
	const policy = readServerInterpreterPolicy({});

	assert.equal(policy.schema, 'server-move-interpreter-policy/v1');
	assert.equal(policy.version, 'hosted-v1');
	assert.equal(policy.authoritative.authority, 'hosted');
	assert.deepEqual(policy.authoritative.release, {
		releaseId: 'gpt-4o-mini',
		identity: 'move-intent-v2-hosted-v3'
	});
	assert.equal(policy.shadow, null);
});

test('a server policy promotes and rolls back authority without a browser parameter', () => {
	const slmPolicy = readServerInterpreterPolicy({
		VOICE_INTERPRETER_POLICY_VERSION: 'slm-pilot-v1',
		VOICE_INTERPRETER_AUTHORITY: 'slm',
		SLM_INTERPRETER_RELEASE_ID: 'qwen-move-intent-v2',
		SLM_INTERPRETER_RELEASE_IDENTITY_SHA256: SLM_IDENTITY
	});
	const rollback = readServerInterpreterPolicy({
		VOICE_INTERPRETER_POLICY_VERSION: 'hosted-rollback-v2',
		VOICE_INTERPRETER_AUTHORITY: 'hosted'
	});

	assert.equal(slmPolicy.authoritative.authority, 'slm');
	assert.equal(slmPolicy.authoritative.release.identity, SLM_IDENTITY);
	assert.equal(rollback.authoritative.authority, 'hosted');
	assert.equal(rollback.version, 'hosted-rollback-v2');
});

test('an invalid optional shadow configuration is shed while hosted authority remains usable', () => {
	const policy = readServerInterpreterPolicy({
		VOICE_INTERPRETER_AUTHORITY: 'hosted',
		VOICE_INTERPRETER_SHADOW_AUTHORITY: 'slm'
	});

	assert.equal(policy.authoritative.authority, 'hosted');
	assert.equal(policy.shadow, null);
});

test('an authoritative SLM cannot start without its immutable release identity', () => {
	assert.throws(
		() => readServerInterpreterPolicy({ VOICE_INTERPRETER_AUTHORITY: 'slm' }),
		InterpreterPolicyError
	);
});

test('a policy cannot make the active interpreter its own shadow', () => {
	assert.throws(
		() => createInterpreterPolicy({
			version: 'invalid-shadow-v1',
			authority: 'hosted',
			authoritativeRelease: { releaseId: 'gpt-4o-mini', identity: 'hosted-v1' },
			shadowAuthority: 'hosted',
			shadowRelease: { releaseId: 'gpt-4o-mini', identity: 'hosted-v1' }
		}),
		InterpreterPolicyError
	);
});
