# Voice to Chess

Voice to Chess is a same-device chess app for two people. Either player, or both players, can play blindfolded. Moves can be entered on the board, typed as SAN or coordinates, or spoken in English.

This MVP keeps the game in the browser. It does not have accounts, saved games, or online multiplayer. Blindfold mode is cooperative: anyone with access to the browser's developer tools can inspect the local game state.

## Voice pipeline

The browser records one utterance of up to 15 seconds. The server sends it to OpenAI `gpt-transcribe`, then asks `gpt-4o-mini` to choose one move from the legal SAN list. `chess.js` checks the returned move again before the board changes.

Move announcements use `gpt-4o-mini-tts-2025-12-15` with the Alloy voice. Browser speech is the fallback when cloud speech is unavailable or capped. Cloudflare Turnstile issues a seven-day anonymous access pass, and Redis enforces the public voice limits before any paid provider call.

The server records 90-day aggregate counts and latency totals. It does not write audio, transcripts, chess positions, SAN history, or raw IP addresses to analytics.

## Local development

From the repository root:

```sh
pnpm install
pnpm web:dev
```

Copy the variable names from `apps/web/environment.example` into the repository-root `.env`. Generate new random values of at least 32 characters for `ACCESS_COOKIE_SECRET` and `IP_HASH_SECRET`. Never commit `.env`.

Run the release checks with:

```sh
pnpm --filter @voice-to-chess/web test
pnpm web:check
pnpm web:build
```

## Deployment

The app uses `@sveltejs/adapter-vercel` on Node 24. On Vercel, set the project root directory to `apps/web`, add every variable listed in `environment.example`, and use the default SvelteKit build command. Use one regional Upstash Redis database. The paid voice routes fail closed if Redis is unavailable.

The default limits are three counted voice games per pass in a rolling UTC day, 20 voice requests per minute, 250 per pass/IP per day, 1,000 globally per day, and 22,400 globally per month. A game counts after its tenth paid voice request. Each seven-day pass has five short-game exemptions.

Provider-side spend controls are still required. Use a dedicated OpenAI project and key, restrict the key to the APIs and models used here, and set the project limit below the total budget to leave room for delayed usage reporting.

## License

Voice to Chess is GPL-3.0-or-later because it bundles [Chessground 10.1.1](https://github.com/lichess-org/chessground/tree/v10.1.1). See the repository `LICENSE` and `apps/web/NOTICE` files.
