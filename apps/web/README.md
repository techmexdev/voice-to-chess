# Blindfold Chess

Blindfold Chess is a same-device chess app for two people. Either player, or both players, can play blindfolded. Moves can be entered on the board, typed as SAN or coordinates, or spoken in English.

This MVP keeps the game in the browser. It does not have accounts, saved games, or online multiplayer. Blindfold mode is cooperative: anyone with access to the browser's developer tools can inspect the local game state.

## Voice pipeline

The browser records one utterance of up to 15 seconds. The server sends it to OpenAI `gpt-transcribe`, then gives the finalized transcript only to the server-selected Move Interpreter. `gpt-4o-mini` is the default authority; a private Qwen service can be enabled only by server policy as a shadow or approved authority. No interpreter receives FEN, legal moves, SAN, move history, or resolver candidates. The host Move Resolver uses `chess.js` before the Game Session commits a Resolved Move identity.

Move announcements use `gpt-4o-mini-tts-2025-12-15` with the Alloy voice. Browser speech is the fallback when cloud speech is unavailable or capped. Cloudflare Turnstile issues a seven-day anonymous access pass, and Redis enforces the public voice limits before any paid provider call.

The server records 90-day aggregate counts and latency totals. It does not write audio, transcripts, compact model output, chess positions, SAN history, or raw IP addresses to analytics. A player can explicitly opt one voice turn into optional SLM shadow review; that separate record contains the finalized transcript, both host outcomes, and release identities for up to 30 days and is not training consent.

## Local development

From the repository root:

```sh
pnpm install
pnpm web:dev
```

Copy the variable names from `apps/web/environment.example` into the repository-root `.env`. Generate new random values of at least 32 characters for `ACCESS_COOKIE_SECRET` and `IP_HASH_SECRET`. Never commit `.env`.

For local development, `OPENAI_API_KEY` is the only required credential for voice input. The app grants local access without Turnstile and uses process-local quotas when Redis credentials are absent. Configure the existing Upstash Redis variables to exercise the shared quota path locally. Production still requires Turnstile, signing secrets, and Redis.

Run the release checks with:

```sh
pnpm --filter @blindfold-chess/web test
pnpm web:check
pnpm web:build
```

## Deployment

The app uses `@sveltejs/adapter-vercel` on Node 24. On Vercel, set the project root directory to `apps/web`, add every variable listed in `environment.example`, and use the default SvelteKit build command. Use one regional Upstash Redis database. The paid voice routes fail closed if Redis is unavailable.

Use the [voice-runtime rollout runbook](../../deployment/voice-runtime-rollout.md) for separate staging and production configuration, the authenticated release-preflight receipt, private SLM endpoint requirements, smoke testing, promotion, and rollback. Keep `gpt-4o-mini` authoritative until its required promotion record is complete.

The default limits are three counted voice games per pass in a rolling UTC day, 20 voice requests per minute, 250 per pass/IP per day, 1,000 globally per day, and 22,400 globally per month. A game counts after its tenth paid voice request. Each seven-day pass has five short-game exemptions.

Provider-side spend controls are still required. Use a dedicated OpenAI project and key, restrict the key to the APIs and models used here, and set the project limit below the total budget to leave room for delayed usage reporting.

## License

Blindfold Chess is GPL-3.0-or-later because it bundles [Chessground 10.1.1](https://github.com/lichess-org/chessground/tree/v10.1.1). See the repository `LICENSE` and `apps/web/NOTICE` files.
