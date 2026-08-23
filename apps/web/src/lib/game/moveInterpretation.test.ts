import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
	MOVE_INTERPRETATION_SCHEMA,
	MoveInterpretationValidationError,
	loadMoveInterpretation,
	parseCompactMoveInterpretation,
	serializeCompactMoveInterpretation
} from '../move-intent/move-interpretation.ts';

type ConformanceCase = Readonly<{
	name: string;
	compact: string;
	canonical?: string;
	invalid?: boolean;
}>;

const conformanceFixture = JSON.parse(readFileSync(
	new URL('../../../../../tests/fixtures/move_interpretation_conformance_v2.json', import.meta.url),
	'utf8'
)) as Readonly<{ schema: string; cases: readonly ConformanceCase[] }>;

test('the v2 Move Interpretation Adapter normalizes every compact form', () => {
	assert.deepEqual(parseCompactMoveInterpretation('UNKNOWN'), {
		schema: MOVE_INTERPRETATION_SCHEMA,
		kind: 'unknown'
	});
	assert.deepEqual(parseCompactMoveInterpretation('O-O'), {
		schema: MOVE_INTERPRETATION_SCHEMA,
		kind: 'castle',
		side: 'king_side'
	});
	assert.deepEqual(parseCompactMoveInterpretation('O-O-O'), {
		schema: MOVE_INTERPRETATION_SCHEMA,
		kind: 'castle',
		side: 'queen_side'
	});
	assert.deepEqual(parseCompactMoveInterpretation('M|N|d5|-|b|-|x|-|-'), {
		schema: MOVE_INTERPRETATION_SCHEMA,
		kind: 'move',
		piece: 'knight',
		destination: 'd5',
		source: { kind: 'file', file: 'b' },
		capture: 'required',
		promotion: null,
		special: null
	});
	assert.deepEqual(parseCompactMoveInterpretation('R|K|-|-|-|-|-|-|-'), {
		schema: MOVE_INTERPRETATION_SCHEMA,
		kind: 'recapture',
		piece: 'king',
		destination: null,
		source: null,
		promotion: null
	});
});

test('the adapter round trips canonical output and rejects noncanonical framing', () => {
	const compact = 'M|P|d6|e5|-|-|x|-|ep';
	const interpretation = parseCompactMoveInterpretation(compact);

	assert.equal(serializeCompactMoveInterpretation(interpretation), compact);
	assert.throws(
		() => parseCompactMoveInterpretation(` ${compact}`),
		MoveInterpretationValidationError
	);
	assert.throws(
		() => parseCompactMoveInterpretation('M|N|d5|b4|b|-|-|-|-'),
		/multiple_compact_source_constraints/
	);
	assert.throws(
		() => parseCompactMoveInterpretation('M|N|d6|e5|-|-|x|-|ep'),
		/en_passant_requires_pawn/
	);
});

test('UNKNOWN remains semantic while malformed normalized values fail closed', () => {
	assert.equal(parseCompactMoveInterpretation('UNKNOWN').kind, 'unknown');
	assert.throws(
		() => parseCompactMoveInterpretation('I think knight d5'),
		MoveInterpretationValidationError
	);
	assert.throws(
		() =>
			loadMoveInterpretation({
				schema: MOVE_INTERPRETATION_SCHEMA,
				kind: 'move',
				piece: 'knight',
				destination: 'f3',
				source: null,
				capture: 'unspecified',
				promotion: null,
				special: null,
				san: 'Nf3'
			}),
		/move_unknown_field:san/
	);
});

test('the shared Python and TypeScript compact conformance fixture stays compatible', () => {
	assert.equal(conformanceFixture.schema, 'move-interpretation-conformance/v1');
	for (const fixture of conformanceFixture.cases) {
		if (fixture.invalid) {
			assert.throws(
				() => parseCompactMoveInterpretation(fixture.compact),
				MoveInterpretationValidationError,
				fixture.name
			);
			continue;
		}
		assert.equal(
			serializeCompactMoveInterpretation(parseCompactMoveInterpretation(fixture.compact)),
			fixture.canonical,
			fixture.name
		);
	}
});
