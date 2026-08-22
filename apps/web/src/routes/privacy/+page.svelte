<svelte:head>
	<title>Privacy | Voice to Chess</title>
	<meta name="description" content="How Voice to Chess handles microphone audio and anonymous usage data." />
</svelte:head>

<main class="min-h-screen bg-[var(--page)] px-5 py-12 text-[var(--text)] sm:px-8">
	<article class="mx-auto max-w-2xl">
		<a href="/board" class="text-[13px] text-[var(--accent)] underline-offset-4 hover:underline">← Back to the board</a>
		<h1 class="mt-8 font-display text-4xl">Privacy</h1>
		<p class="mt-3 text-[13px] text-[var(--text-faint)]">Last updated August 22, 2026</p>

		<div class="mt-8 space-y-8 text-[15px] leading-7 text-[var(--text-muted)]">
			<section>
				<h2 class="text-xl text-[var(--text)]">Microphone and voice moves</h2>
				<p class="mt-2">The microphone runs only while you hold the voice button. When you release it, the recording and the current chess position are sent to OpenAI to transcribe and interpret one move. This app does not save the recording or transcript.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Spoken announcements</h2>
				<p class="mt-2">Move announcements use an AI-generated OpenAI voice. If that service is unavailable or its public limit has been reached, your browser may read the announcement instead.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Anonymous limits and measurements</h2>
				<p class="mt-2">Cloudflare Turnstile checks that a person is starting the game. A seven-day cookie remembers that check. Short-lived, keyed hashes help enforce daily voice limits without storing a raw IP address.</p>
				<p class="mt-3">We keep daily totals for starts, finishes, provider errors, response times, and accepted or rejected voice moves for up to 90 days. Those totals do not contain audio, transcripts, chess positions, move history, or a persistent visitor ID.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Children</h2>
				<p class="mt-2">Voice to Chess is not directed to children under 13. Do not submit personal information in a voice move.</p>
			</section>

			<section>
				<h2 class="text-xl text-[var(--text)]">Questions</h2>
				<p class="mt-2">Open an issue in the <a class="text-[var(--accent)] underline" href="https://github.com/techmexdev/voice-to-chess/issues">public source repository</a> for privacy questions or deletion requests. The app does not have user accounts or saved games.</p>
			</section>
		</div>
	</article>
</main>
