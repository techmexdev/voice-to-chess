<svelte:head>
	<title>Privacy | Blindfold Chess</title>
	<meta name="description" content="How Blindfold Chess handles microphone audio and anonymous usage data." />
</svelte:head>

<main class="min-h-screen bg-[var(--page)] px-5 py-12 text-[var(--text)] sm:px-8">
	<article class="mx-auto max-w-2xl">
		<a href="/board" class="text-[13px] text-[var(--accent)] underline-offset-4 hover:underline">← Back to the board</a>
		<h1 class="mt-8 font-display text-4xl">Privacy</h1>
		<p class="mt-3 text-[13px] text-[var(--text-faint)]">Last updated August 22, 2026</p>

		<div class="mt-8 space-y-8 text-[15px] leading-7 text-[var(--text-muted)]">
			<section>
				<h2 class="text-xl text-[var(--text)]">Microphone and voice moves</h2>
				<p class="mt-2">The microphone runs only while you hold the voice button. When you release it, the recording goes to OpenAI for transcription. The server then sends the finalized transcript, and no chess position, legal-move list, FEN, SAN, or move history, to the active Move Interpreter. The initial active interpreter is OpenAI gpt-4o-mini. A private Qwen service may receive the same transcript only when it is enabled as the active interpreter or optional shadow evaluator. This app does not save recordings.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Optional shadow-review consent</h2>
				<p class="mt-2">Ordinary voice turns do not retain transcripts or model-comparison content. Before a voice turn, you can separately choose to retain that turn for SLM shadow review. When a shadow interpreter runs, that choice keeps the finalized transcript, the two host-owned outcomes, and the two non-secret release identities for up to 30 days. It does not grant consent to train a model. You can ask for deletion through the contact route below.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Spoken announcements</h2>
				<p class="mt-2">Move announcements use an AI-generated OpenAI voice. If that service is unavailable or its public limit has been reached, your browser may read the announcement instead.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Anonymous limits and measurements</h2>
				<p class="mt-2">Cloudflare Turnstile checks that a person is starting the game. A seven-day cookie remembers that check. Short-lived, keyed hashes help enforce daily voice limits without storing a raw IP address.</p>
				<p class="mt-3">We keep daily totals for transcription, interpretation, resolver, feedback, quota, shadow, response-time, and accepted or rejected voice outcomes for up to 90 days. For release troubleshooting, we also keep a short-lived record with a random one-time voice-turn ID, the selected policy and release identities, an outcome class, and bounded phase timings. Neither record contains audio, transcripts, compact model output, chess positions, move history, or a persistent visitor ID.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Children</h2>
				<p class="mt-2">Blindfold Chess is not directed to children under 13. Do not submit personal information in a voice move.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Questions</h2>
				<p class="mt-2">Open an issue in the <a class="text-[var(--accent)] underline" href="https://github.com/techmexdev/voice-to-chess/issues">public source repository</a> for privacy questions or deletion requests. The app does not have user accounts or saved games.</p>
			</section>
		</div>
	</article>
</main>
