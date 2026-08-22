export type BoardColor = 'white' | 'black';

export type Square = `${'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h'}${
	| '1'
	| '2'
	| '3'
	| '4'
	| '5'
	| '6'
	| '7'
	| '8'}`;

export type BoardMoveRequest = {
	from: Square;
	to: Square;
	promotion?: 'q' | 'r' | 'b' | 'n';
};

export type BoardSeatView = {
	fen: string;
	orientation: BoardColor;
	turn: BoardColor;
	lastMove?: readonly [Square, Square];
	check?: BoardColor;
	legalDestinations: ReadonlyMap<Square, readonly Square[]>;
	inputEnabled: boolean;
};
