type AnnounceableMove = {
	san: string;
};

const pieceNames: Readonly<Record<string, string>> = {
	K: 'King',
	Q: 'Queen',
	R: 'Rook',
	B: 'Bishop',
	N: 'Knight'
};

const promotionNames: Readonly<Record<string, string>> = {
	Q: 'Queen',
	R: 'Rook',
	B: 'Bishop',
	N: 'Knight'
};

/** Converts canonical SAN into a short phrase suitable for move announcements. */
export function moveAnnouncement(move: AnnounceableMove): string {
	const san = move.san.trim();
	const suffix = san.endsWith('#') ? ' Checkmate.' : san.endsWith('+') ? ' Check.' : '';
	const notation = san.replace(/[+#]+$/, '');

	if (notation === 'O-O') return `Castle kingside.${suffix}`;
	if (notation === 'O-O-O') return `Castle queenside.${suffix}`;

	const pieceMove = notation.match(/^([KQRBN])([a-h]?[1-8]?)(x?)([a-h][1-8])(?:=([QRBN]))?$/);
	if (pieceMove) {
		const [, piece, source, capture, destination, promotion] = pieceMove;
		return finishAnnouncement(
			`${pieceNames[piece]}${sourcePhrase(source)} ${capture ? 'takes' : 'to'} ${destination}`,
			promotion,
			suffix
		);
	}

	const pawnMove = notation.match(/^([a-h]?)(x?)([a-h][1-8])(?:=([QRBN]))?$/);
	if (pawnMove) {
		const [, sourceFile, capture, destination, promotion] = pawnMove;
		const action = capture ? `Pawn from ${sourceFile} takes ${destination}` : `Pawn to ${destination}`;
		return finishAnnouncement(action, promotion, suffix);
	}

	// Canonical SAN should always match one of the forms above. Keeping a safe
	// fallback means a future chess.js notation addition still gets announced.
	return `Move ${san}.`;
}

function sourcePhrase(source: string): string {
	if (!source) return '';
	if (/^[a-h]$/.test(source)) return ` from the ${source} file`;
	if (/^[1-8]$/.test(source)) return ` from rank ${source}`;
	return ` from ${source}`;
}

function finishAnnouncement(action: string, promotion: string | undefined, suffix: string): string {
	const promotionPhrase = promotion ? `, promoting to ${promotionNames[promotion]}` : '';
	return `${action}${promotionPhrase}.${suffix}`;
}
