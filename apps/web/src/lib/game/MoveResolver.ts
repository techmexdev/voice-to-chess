import { Chess, type Move, type PieceSymbol } from 'chess.js';
import type { Square } from '../board/types.ts';
import type {
	MoveInterpretation,
	OrdinaryMoveIntent,
	Piece,
	PromotionPiece,
	RecaptureMoveIntent,
	SourceConstraint
} from '../move-intent/move-interpretation.ts';

export type ResolvedMoveIdentity = Readonly<{
	from: Square;
	to: Square;
	promotion?: 'q' | 'r' | 'b' | 'n';
}>;

/** The history facts required to give recapture its transcript-only meaning. */
export type ReplayableMove = Readonly<{
	from: Square;
	to: Square;
	san: string;
	wasCapture: boolean;
	wasEnPassant: boolean;
	promotion?: 'q' | 'r' | 'b' | 'n';
}>;

export type MoveResolverPosition = Readonly<{
	fen: string;
	replayableHistory: readonly ReplayableMove[];
}>;

export type ResolvedMove = Readonly<{
	kind: 'resolved';
	move: ResolvedMoveIdentity;
	san: string;
}>;

export type MoveResolution =
	| ResolvedMove
	| Readonly<{ kind: 'unknown' }>
	| Readonly<{ kind: 'illegal' }>
	| Readonly<{ kind: 'ambiguous' }>;

const pieceSymbols: Readonly<Record<Piece, PieceSymbol>> = {
	pawn: 'p',
	knight: 'n',
	bishop: 'b',
	rook: 'r',
	queen: 'q',
	king: 'k'
};

const promotionSymbols: Readonly<Record<PromotionPiece, 'q' | 'r' | 'b' | 'n'>> = {
	queen: 'q',
	rook: 'r',
	bishop: 'b',
	knight: 'n'
};

/**
 * Resolve a validated Move Interpretation against a copied chess.js position.
 * This reads verbose legal moves only; it neither mutates the caller's state
 * nor reparses model text as SAN.
 */
export function resolveMoveIntent(
	position: MoveResolverPosition,
	intent: MoveInterpretation
): MoveResolution {
	if (intent.kind === 'unknown') return unknownResolution();

	const chess = new Chess(position.fen);
	const legalMoves = chess.moves({ verbose: true });

	switch (intent.kind) {
		case 'castle':
			return selectMove(
				legalMoves.filter((candidate) =>
					intent.side === 'king_side'
						? candidate.isKingsideCastle()
						: candidate.isQueensideCastle()
				)
			);
		case 'move':
			return selectMove(
				legalMoves
					.filter((candidate) => !candidate.isKingsideCastle() && !candidate.isQueensideCastle())
					.filter((candidate) => matchesMoveConstraints(candidate, intent))
			);
		case 'recapture':
			return resolveRecapture(position, legalMoves, intent);
	}
}

/**
 * Recapture is history-sensitive: FEN alone cannot tell us whether the piece
 * on the target square made the preceding capture. A qualifying candidate must
 * capture on that predecessor's destination square.
 */
function resolveRecapture(
	position: MoveResolverPosition,
	legalMoves: readonly Move[],
	intent: RecaptureMoveIntent
): MoveResolution {
	const previousMove = position.replayableHistory[position.replayableHistory.length - 1];
	if (previousMove === undefined || !previousMove.wasCapture) return illegalResolution();

	return selectMove(
		legalMoves
			.filter((candidate) => capturesPreviousCapturer(candidate, previousMove))
			.filter((candidate) => matchesMoveConstraints(candidate, intent))
	);
}

function capturesPreviousCapturer(candidate: Move, previousMove: ReplayableMove): boolean {
	// En passant captures beside its destination, so it cannot take the prior
	// capturer on that capturer's destination square.
	return isCapture(candidate) && !candidate.isEnPassant() && candidate.to === previousMove.to;
}

function matchesMoveConstraints(
	candidate: Move,
	intent: OrdinaryMoveIntent | RecaptureMoveIntent
): boolean {
	if (intent.piece !== null && candidate.piece !== pieceSymbols[intent.piece]) return false;
	if (intent.destination !== null && candidate.to !== intent.destination) return false;
	if (!matchesSource(candidate.from, intent.source)) return false;
	if (intent.promotion !== null && candidate.promotion !== promotionSymbols[intent.promotion]) {
		return false;
	}
	if (intent.kind === 'move') {
		if (intent.capture === 'required' && !isCapture(candidate)) return false;
		if (intent.special === 'en_passant' && !candidate.isEnPassant()) return false;
	}
	return true;
}

function matchesSource(from: string, source: SourceConstraint | null): boolean {
	if (source === null) return true;
	if (source.kind === 'square') return from === source.square;
	if (source.kind === 'file') return from[0] === source.file;
	return from[1] === source.rank;
}

function isCapture(move: Move): boolean {
	return move.isCapture() || move.isEnPassant();
}

function selectMove(matches: readonly Move[]): MoveResolution {
	if (matches.length === 0) return illegalResolution();
	if (matches.length > 1) return Object.freeze({ kind: 'ambiguous' as const });
	const selected = matches[0];
	if (selected === undefined) return illegalResolution();
	const promotion = selected.promotion;
	return Object.freeze({
		kind: 'resolved' as const,
		move: Object.freeze({
			from: selected.from as Square,
			to: selected.to as Square,
			...(promotion === 'q' || promotion === 'r' || promotion === 'b' || promotion === 'n'
				? { promotion }
				: {})
		}),
		san: selected.san
	});
}

function unknownResolution(): Readonly<{ kind: 'unknown' }> {
	return Object.freeze({ kind: 'unknown' as const });
}

function illegalResolution(): Readonly<{ kind: 'illegal' }> {
	return Object.freeze({ kind: 'illegal' as const });
}
