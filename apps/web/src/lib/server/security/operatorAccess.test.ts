import assert from 'node:assert/strict';
import test from 'node:test';
import { hasOperatorBearerToken } from './operatorAccess.ts';

test('operator evidence access needs the configured server-only bearer token', () => {
	assert.equal(hasOperatorBearerToken('Bearer review-token', 'review-token'), true);
	assert.equal(hasOperatorBearerToken('Bearer different-token', 'review-token'), false);
	assert.equal(hasOperatorBearerToken(null, 'review-token'), false);
	assert.equal(hasOperatorBearerToken('Bearer review-token', undefined), false);
});
