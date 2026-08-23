import type { Square } from '../board/types.ts';

/** The serialized contract shared with the Python Move Interpretation corpus. */
export const MOVE_INTERPRETATION_SCHEMA = 'move-interpretation/v2' as const;

const pieces = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'] as const;
const promotionPieces = ['queen', 'rook', 'bishop', 'knight'] as const;

export type Piece = (typeof pieces)[number];
export type PromotionPiece = (typeof promotionPieces)[number];
export type CaptureConstraint = 'required' | 'unspecified';

export type SourceConstraint =
	| Readonly<{ kind: 'square'; square: Square }>
	| Readonly<{ kind: 'file'; file: Square[0] }>
	| Readonly<{ kind: 'rank'; rank: Square[1] }>;

export type OrdinaryMoveIntent = Readonly<{
	schema: typeof MOVE_INTERPRETATION_SCHEMA;
	kind: 'move';
	piece: Piece | null;
	destination: Square | null;
	source: SourceConstraint | null;
	capture: CaptureConstraint;
	promotion: PromotionPiece | null;
	special: 'en_passant' | null;
}>;

export type CastlingMoveIntent = Readonly<{
	schema: typeof MOVE_INTERPRETATION_SCHEMA;
	kind: 'castle';
	side: 'king_side' | 'queen_side';
}>;

export type RecaptureMoveIntent = Readonly<{
	schema: typeof MOVE_INTERPRETATION_SCHEMA;
	kind: 'recapture';
	piece: Piece | null;
	destination: Square | null;
	source: SourceConstraint | null;
	promotion: PromotionPiece | null;
}>;

export type UnknownMoveInterpretation = Readonly<{
	schema: typeof MOVE_INTERPRETATION_SCHEMA;
	kind: 'unknown';
}>;

export type MoveInterpretation =
	| OrdinaryMoveIntent
	| CastlingMoveIntent
	| RecaptureMoveIntent
	| UnknownMoveInterpretation;

/** A fail-closed adapter error. It must never be converted to semantic UNKNOWN. */
export class MoveInterpretationValidationError extends Error {
	readonly name = 'MoveInterpretationValidationError';
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(issues.join(', '));
		this.issues = issues;
	}
}

type RecordValue = Record<string, unknown>;

const squarePattern = /^[a-h][1-8]$/;
const compactPieceNames: Readonly<Record<string, Piece>> = {
	P: 'pawn',
	N: 'knight',
	B: 'bishop',
	R: 'rook',
	Q: 'queen',
	K: 'king'
};

/**
 * Validate the normalized JSON form. Unknown fields and impossible combinations
 * remain adapter failures so model abstention stays measurable as UNKNOWN.
 */
export function loadMoveInterpretation(input: unknown): MoveInterpretation {
	const value = requireRecord(input, 'interpretation_must_be_object');
	if (value.schema !== MOVE_INTERPRETATION_SCHEMA) fail('invalid_interpretation_schema');

	switch (value.kind) {
		case 'move':
			return loadOrdinaryMove(value);
		case 'castle':
			return loadCastlingMove(value);
		case 'recapture':
			return loadRecaptureMove(value);
		case 'unknown':
			assertExactKeys(value, ['schema', 'kind'], 'unknown');
			return Object.freeze({ schema: MOVE_INTERPRETATION_SCHEMA, kind: 'unknown' });
		default:
			return fail('invalid_interpretation_kind');
	}
}

/**
 * Parse the one compact spelling emitted by the v2 Move Interpreter. The value
 * is deliberately not trimmed: whitespace or prose is malformed output.
 */
export function parseCompactMoveInterpretation(input: unknown): MoveInterpretation {
	if (typeof input !== 'string') fail('compact_must_be_string');
	if (input === 'UNKNOWN') {
		return Object.freeze({ schema: MOVE_INTERPRETATION_SCHEMA, kind: 'unknown' });
	}
	if (input === 'O-O') {
		return Object.freeze({
			schema: MOVE_INTERPRETATION_SCHEMA,
			kind: 'castle',
			side: 'king_side'
		});
	}
	if (input === 'O-O-O') {
		return Object.freeze({
			schema: MOVE_INTERPRETATION_SCHEMA,
			kind: 'castle',
			side: 'queen_side'
		});
	}

	const parts = input.split('|');
	if (parts.length !== 9 || (parts[0] !== 'M' && parts[0] !== 'R')) {
		fail('invalid_compact_format');
	}
	if (parts.slice(1).some((part) => part.length === 0)) fail('invalid_compact_empty_field');

	const [prefix, compactPiece, destination, sourceSquare, sourceFile, sourceRank, capture, promotion, special] =
		parts as [string, string, string, string, string, string, string, string, string];
	if (!(compactPiece in compactPieceNames) && compactPiece !== '-') fail('invalid_compact_piece');
	if (!['Q', 'R', 'B', 'N', '-'].includes(promotion)) fail('invalid_compact_promotion');
	if (capture !== 'x' && capture !== '-') fail('invalid_compact_capture');
	if (special !== 'ep' && special !== '-') fail('invalid_compact_special');

	const sourceValues = [sourceSquare !== '-', sourceFile !== '-', sourceRank !== '-'];
	if (sourceValues.filter(Boolean).length > 1) fail('multiple_compact_source_constraints');
	if (prefix === 'R' && capture !== '-') fail('recapture_capture_is_implied');
	if (prefix === 'R' && special !== '-') fail('recapture_cannot_have_special');

	const source =
		sourceSquare !== '-'
			? loadSourceConstraint({ kind: 'square', square: sourceSquare })
			: sourceFile !== '-'
				? loadSourceConstraint({ kind: 'file', file: sourceFile })
				: sourceRank !== '-'
					? loadSourceConstraint({ kind: 'rank', rank: sourceRank })
					: null;
	const common = {
		schema: MOVE_INTERPRETATION_SCHEMA,
		piece: compactPiece === '-' ? null : compactPieceNames[compactPiece] ?? null,
		destination: destination === '-' ? null : loadSquare(destination, 'invalid_destination'),
		source,
		promotion: promotion === '-' ? null : compactPieceNames[promotion] as PromotionPiece
	};

	if (prefix === 'R') return loadMoveInterpretation({ ...common, kind: 'recapture' });
	return loadMoveInterpretation({
		...common,
		kind: 'move',
		capture: capture === 'x' ? 'required' : 'unspecified',
		special: special === 'ep' ? 'en_passant' : null
	});
}

/** Return the canonical compact spelling shared by the TypeScript and Python adapters. */
export function serializeCompactMoveInterpretation(input: unknown): string {
	const interpretation = loadMoveInterpretation(input);
	if (interpretation.kind === 'unknown') return 'UNKNOWN';
	if (interpretation.kind === 'castle') {
		return interpretation.side === 'king_side' ? 'O-O' : 'O-O-O';
	}

	const sourceSquare = interpretation.source?.kind === 'square' ? interpretation.source.square : '-';
	const sourceFile = interpretation.source?.kind === 'file' ? interpretation.source.file : '-';
	const sourceRank = interpretation.source?.kind === 'rank' ? interpretation.source.rank : '-';
	const piece = interpretation.piece === null ? '-' : pieceCode(interpretation.piece);
	const promotion = interpretation.promotion === null ? '-' : pieceCode(interpretation.promotion);
	const prefix = interpretation.kind === 'move' ? 'M' : 'R';
	const capture = interpretation.kind === 'move' && interpretation.capture === 'required' ? 'x' : '-';
	const special = interpretation.kind === 'move' && interpretation.special === 'en_passant' ? 'ep' : '-';
	return [
		prefix,
		piece,
		interpretation.destination ?? '-',
		sourceSquare,
		sourceFile,
		sourceRank,
		capture,
		promotion,
		special
	].join('|');
}

function loadOrdinaryMove(value: RecordValue): OrdinaryMoveIntent {
	assertExactKeys(
		value,
		['schema', 'kind', 'piece', 'destination', 'source', 'capture', 'promotion', 'special'],
		'move'
	);
	const piece = loadNullablePiece(value.piece, 'piece');
	const destination = loadNullableSquare(value.destination, 'destination');
	const source = value.source === null ? null : loadSourceConstraint(value.source);
	const capture = loadCapture(value.capture);
	const promotion = loadNullablePromotion(value.promotion);
	const special = loadNullableSpecial(value.special);

	if (
		piece === null &&
		destination === null &&
		source === null &&
		promotion === null &&
		special === null &&
		capture !== 'required'
	) {
		fail('empty_move');
	}
	if (special === 'en_passant') {
		if (piece !== 'pawn') fail('en_passant_requires_pawn');
		if (capture !== 'required') fail('en_passant_requires_capture');
		if (promotion !== null) fail('en_passant_cannot_promote');
	}

	return Object.freeze({
		schema: MOVE_INTERPRETATION_SCHEMA,
		kind: 'move',
		piece,
		destination,
		source,
		capture,
		promotion,
		special
	});
}

function loadCastlingMove(value: RecordValue): CastlingMoveIntent {
	assertExactKeys(value, ['schema', 'kind', 'side'], 'castle');
	if (value.side !== 'king_side' && value.side !== 'queen_side') fail('invalid_castle_side');
	return Object.freeze({
		schema: MOVE_INTERPRETATION_SCHEMA,
		kind: 'castle',
		side: value.side
	});
}

function loadRecaptureMove(value: RecordValue): RecaptureMoveIntent {
	assertExactKeys(value, ['schema', 'kind', 'piece', 'destination', 'source', 'promotion'], 'recapture');
	return Object.freeze({
		schema: MOVE_INTERPRETATION_SCHEMA,
		kind: 'recapture',
		piece: loadNullablePiece(value.piece, 'piece'),
		destination: loadNullableSquare(value.destination, 'destination'),
		source: value.source === null ? null : loadSourceConstraint(value.source),
		promotion: loadNullablePromotion(value.promotion)
	});
}

function loadSourceConstraint(input: unknown): SourceConstraint {
	const value = requireRecord(input, 'source_constraint_must_be_object');
	switch (value.kind) {
		case 'square':
			assertExactKeys(value, ['kind', 'square'], 'source_constraint');
			return Object.freeze({ kind: 'square', square: loadSquare(value.square, 'invalid_source_square') });
		case 'file':
			assertExactKeys(value, ['kind', 'file'], 'source_constraint');
			if (typeof value.file !== 'string' || !/^[a-h]$/.test(value.file)) {
				fail('invalid_source_file');
			}
			return Object.freeze({ kind: 'file', file: value.file as Square[0] });
		case 'rank':
			assertExactKeys(value, ['kind', 'rank'], 'source_constraint');
			if (typeof value.rank !== 'string' || !/^[1-8]$/.test(value.rank)) {
				fail('invalid_source_rank');
			}
			return Object.freeze({ kind: 'rank', rank: value.rank as Square[1] });
		default:
			return fail('invalid_source_constraint_kind');
	}
}

function loadNullablePiece(value: unknown, field: string): Piece | null {
	if (value === null) return null;
	if (typeof value !== 'string' || !pieces.includes(value as Piece)) fail(`invalid_${field}`);
	return value as Piece;
}

function loadNullablePromotion(value: unknown): PromotionPiece | null {
	if (value === null) return null;
	if (typeof value !== 'string' || !promotionPieces.includes(value as PromotionPiece)) {
		fail('invalid_promotion');
	}
	return value as PromotionPiece;
}

function loadNullableSquare(value: unknown, field: string): Square | null {
	if (value === null) return null;
	return loadSquare(value, `invalid_${field}`);
}

function loadNullableSpecial(value: unknown): 'en_passant' | null {
	if (value === null) return null;
	if (value !== 'en_passant') fail('invalid_special');
	return value;
}

function loadCapture(value: unknown): CaptureConstraint {
	if (value !== 'required' && value !== 'unspecified') fail('invalid_capture');
	return value;
}

function loadSquare(value: unknown, issue: string): Square {
	if (typeof value !== 'string' || !squarePattern.test(value)) fail(issue);
	return value as Square;
}

function assertExactKeys(value: RecordValue, expected: readonly string[], location: string): void {
	const actual = Object.keys(value);
	const unknown = actual.filter((key) => !expected.includes(key));
	const missing = expected.filter((key) => !Object.hasOwn(value, key));
	if (unknown.length > 0 || missing.length > 0) {
		fail(
			...unknown.map((key) => `${location}_unknown_field:${key}`),
			...missing.map((key) => `${location}_missing_field:${key}`)
		);
	}
}

function requireRecord(value: unknown, issue: string): RecordValue {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(issue);
	return value as RecordValue;
}

function pieceCode(piece: Piece | PromotionPiece): string {
	for (const [code, value] of Object.entries(compactPieceNames)) {
		if (value === piece) return code;
	}
	throw new Error('A validated piece must have a compact code.');
}

function fail(...issues: string[]): never {
	throw new MoveInterpretationValidationError(issues);
}
