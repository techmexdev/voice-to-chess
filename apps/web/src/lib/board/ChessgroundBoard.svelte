<script lang="ts">
	import { onMount } from 'svelte';
	import '@lichess-org/chessground/assets/chessground.base.css';
	import '@lichess-org/chessground/assets/chessground.brown.css';
	import '@lichess-org/chessground/assets/chessground.cburnett.css';
	import type { Api } from '@lichess-org/chessground/api';
	import type { Config } from '@lichess-org/chessground/config';
	import type { Key } from '@lichess-org/chessground/types';
	import type { BoardMoveRequest, BoardSeatView, Square } from './types';

	type Props = {
		view: BoardSeatView;
		onMove: (request: BoardMoveRequest) => void;
	};

	let { view, onMove }: Props = $props();
	let boardRoot: HTMLElement;
	let chessground: Api | undefined;

	function legalDestinationsFor(currentView: BoardSeatView): Map<Key, Key[]> {
		return new Map(
			[...currentView.legalDestinations].map(([from, destinations]) => [
				from as Key,
				[...destinations] as Key[]
			])
		);
	}

	function configFor(currentView: BoardSeatView): Config {
		return {
			fen: currentView.fen,
			orientation: currentView.orientation,
			turnColor: currentView.turn,
			check: currentView.check,
			lastMove: currentView.lastMove ? [...currentView.lastMove] : undefined,
			autoCastle: true,
			// The local browser harness dispatches synthetic pointer events. Production
			// keeps Chessground's default trusted-event check.
			trustAllEvents: import.meta.env.DEV,
			coordinates: true,
			highlight: {
				lastMove: true,
				check: true
			},
			animation: {
				enabled: true,
				duration: 180
			},
			// Chessground binds its input listeners only at mount time. Keep the board
			// mountable, then lock it with movable/selectable state when input is off.
			viewOnly: false,
			movable: {
				color: currentView.inputEnabled ? currentView.turn : undefined,
				free: false,
				dests: legalDestinationsFor(currentView),
				showDests: currentView.inputEnabled,
				events: {
					after: (from, to) => onMove({ from: from as Square, to: to as Square })
				}
			},
			premovable: {
				enabled: false
			},
			predroppable: {
				enabled: false
			},
			draggable: {
				enabled: false
			},
			selectable: {
				enabled: currentView.inputEnabled
			},
			drawable: {
				enabled: false
			}
		};
	}

	function committedView(currentView: BoardSeatView): BoardSeatView {
		return {
			fen: currentView.fen,
			orientation: currentView.orientation,
			turn: currentView.turn,
			lastMove: currentView.lastMove,
			check: currentView.check,
			legalDestinations: currentView.legalDestinations,
			inputEnabled: currentView.inputEnabled
		};
	}

	onMount(() => {
		let destroyed = false;

		void import('@lichess-org/chessground').then(({ Chessground }) => {
			if (destroyed) return;
			chessground = Chessground(boardRoot, configFor(committedView(view)));
		});

		return () => {
			destroyed = true;
			chessground?.destroy();
		};
	});

	$effect(() => {
		const nextView = {
			fen: view.fen,
			orientation: view.orientation,
			turn: view.turn,
			lastMove: view.lastMove,
			check: view.check,
			legalDestinations: view.legalDestinations,
			inputEnabled: view.inputEnabled
		} satisfies BoardSeatView;

		chessground?.set(configFor(nextView));
	});
</script>

<div
	bind:this={boardRoot}
	class="chessground-board"
	role="application"
	aria-label="Board Seat chessboard"
	aria-busy={!view.inputEnabled}
></div>

<style>
	.chessground-board {
		width: 100%;
		aspect-ratio: 1;
		border-radius: 0.4rem;
		overflow: hidden;
		box-shadow: 0 1.5rem 3rem var(--board-shadow);
	}
</style>
