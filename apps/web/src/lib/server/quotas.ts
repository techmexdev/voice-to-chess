import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { LocalVoiceQuotas, shouldUseLocalVoiceQuotas } from '$lib/server/localVoiceQuotas';
import { redisCommand } from '$lib/server/redis';

const VOICE_RESERVATION_SCRIPT = `
local prior = redis.call('GET', KEYS[8])
if prior then return {0, 'duplicate', 0} end
if redis.call('EXISTS', KEYS[10]) == 1 then return {0, 'busy', 0} end
local fast = tonumber(redis.call('GET', KEYS[1]) or '0')
local minute = tonumber(redis.call('GET', KEYS[2]) or '0')
local sessionDay = tonumber(redis.call('GET', KEYS[3]) or '0')
local ipDay = tonumber(redis.call('GET', KEYS[4]) or '0')
local globalDay = tonumber(redis.call('GET', KEYS[5]) or '0')
local globalMonth = tonumber(redis.call('GET', KEYS[6]) or '0')
local gameMoves = tonumber(redis.call('HGET', KEYS[7], 'moves') or '0')
redis.call('ZREMRANGEBYSCORE', KEYS[9], '-inf', tonumber(ARGV[9]) - 86400)
local games = tonumber(redis.call('ZCARD', KEYS[9]) or '0')
if gameMoves == 0 and games >= tonumber(ARGV[7]) then return {0, 'games', 0} end
if gameMoves == tonumber(ARGV[6]) - 1 and games >= tonumber(ARGV[7]) then return {0, 'games', 0} end
if fast >= tonumber(ARGV[1]) then return {0, 'pace', math.max(0, tonumber(ARGV[7]) - games)} end
if minute >= tonumber(ARGV[2]) then return {0, 'minute', math.max(0, tonumber(ARGV[7]) - games)} end
if sessionDay >= tonumber(ARGV[3]) or ipDay >= tonumber(ARGV[3]) then return {0, 'day', math.max(0, tonumber(ARGV[7]) - games)} end
if globalDay >= tonumber(ARGV[4]) then return {0, 'global_day', math.max(0, tonumber(ARGV[7]) - games)} end
if globalMonth >= tonumber(ARGV[5]) then return {0, 'global_month', math.max(0, tonumber(ARGV[7]) - games)} end
redis.call('SET', KEYS[1], fast + 1, 'EX', 2)
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 60)
redis.call('INCR', KEYS[3]); redis.call('EXPIRE', KEYS[3], 172800)
redis.call('INCR', KEYS[4]); redis.call('EXPIRE', KEYS[4], 172800)
redis.call('INCR', KEYS[5]); redis.call('EXPIRE', KEYS[5], 172800)
redis.call('INCR', KEYS[6]); redis.call('EXPIRE', KEYS[6], 2678400)
local nextMoves = redis.call('HINCRBY', KEYS[7], 'moves', 1); redis.call('EXPIRE', KEYS[7], 691200)
if nextMoves == tonumber(ARGV[6]) and redis.call('HGET', KEYS[7], 'counted') ~= '1' then
  if games >= tonumber(ARGV[7]) then return {0, 'games', 0} end
  redis.call('ZADD', KEYS[9], ARGV[9], ARGV[10]); redis.call('EXPIRE', KEYS[9], 172800); games = games + 1; redis.call('HSET', KEYS[7], 'counted', '1')
end
redis.call('SET', KEYS[8], 'reserved', 'EX', 86400)
redis.call('SET', KEYS[10], ARGV[8], 'EX', 45)
return {1, 'ok', math.max(0, tonumber(ARGV[7]) - games)}
`;

const END_GAME_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[4]) - 86400)
if redis.call('HGET', KEYS[1], 'ended') == '1' then
  local games = tonumber(redis.call('ZCARD', KEYS[2]) or '0'); return {math.max(0, tonumber(ARGV[2]) - games), 0}
end
local moves = tonumber(redis.call('HGET', KEYS[1], 'moves') or '0')
local counted = redis.call('HGET', KEYS[1], 'counted') == '1'
local games = tonumber(redis.call('ZCARD', KEYS[2]) or '0')
if moves > 0 and not counted and moves < tonumber(ARGV[1]) then
  local exemptions = tonumber(redis.call('GET', KEYS[3]) or '0')
  if exemptions < tonumber(ARGV[3]) then
    redis.call('INCR', KEYS[3]); redis.call('EXPIRE', KEYS[3], 691200)
  elseif games < tonumber(ARGV[2]) then
    redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5]); redis.call('EXPIRE', KEYS[2], 172800); games = games + 1; redis.call('HSET', KEYS[1], 'counted', '1')
  end
end
redis.call('HSET', KEYS[1], 'ended', '1'); redis.call('EXPIRE', KEYS[1], 691200)
return {math.max(0, tonumber(ARGV[2]) - games), moves}
`;

const TTS_RESERVATION_SCRIPT = `
local minute = tonumber(redis.call('GET', KEYS[1]) or '0')
local day = tonumber(redis.call('GET', KEYS[2]) or '0')
local month = tonumber(redis.call('GET', KEYS[3]) or '0')
if minute >= tonumber(ARGV[1]) then return {0, 'minute'} end
if day >= tonumber(ARGV[2]) then return {0, 'global_day'} end
if month >= tonumber(ARGV[3]) then return {0, 'global_month'} end
redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], 60)
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 172800)
redis.call('INCR', KEYS[3]); redis.call('EXPIRE', KEYS[3], 2678400)
return {1, 'ok'}
`;

type QuotaResult = { allowed: boolean; reason: string; remainingGames: number };

const localVoiceQuotas = new LocalVoiceQuotas(numberFromEnv('VOICE_GAMES_PER_DAY', 3));

function useLocalVoiceQuotas(): boolean {
	return shouldUseLocalVoiceQuotas({
		development: dev,
		redisUrl: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
		redisToken: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN
	});
}

export async function reserveVoiceMove(input: {
	sessionId: string;
	ipHash: string;
	gameId: string;
	requestId: string;
}): Promise<QuotaResult> {
	if (useLocalVoiceQuotas()) return localVoiceQuotas.reserveVoiceMove(input);

	const now = new Date();
	const day = now.toISOString().slice(0, 10);
	const month = day.slice(0, 7);
	const prefix = 'quota:v1';
	const result = await redisCommand<[number, string, number]>([
		'EVAL', VOICE_RESERVATION_SCRIPT, 10,
		`${prefix}:pace:${input.sessionId}`,
		`${prefix}:minute:${input.sessionId}`,
		`${prefix}:day:${day}:session:${input.sessionId}`,
		`${prefix}:day:${day}:ip:${input.ipHash}`,
		`${prefix}:day:${day}:global`,
		`${prefix}:month:${month}:global`,
		`${prefix}:game:${input.sessionId}:${input.gameId}`,
		`${prefix}:request:${input.sessionId}:${input.requestId}`,
		`${prefix}:games:rolling:${input.sessionId}`,
		`${prefix}:lock:${input.sessionId}`,
		1,
		numberFromEnv('VOICE_MOVES_PER_MINUTE', 20),
		numberFromEnv('VOICE_MOVES_PER_DAY', 250),
		numberFromEnv('VOICE_MOVES_GLOBAL_DAY', 1000),
		numberFromEnv('VOICE_MOVES_GLOBAL_MONTH', 22400),
		10,
		numberFromEnv('VOICE_GAMES_PER_DAY', 3),
		input.requestId,
		Math.floor(now.getTime() / 1000),
		input.gameId
	]);
	return { allowed: result[0] === 1, reason: result[1], remainingGames: result[2] };
}

export async function releaseVoiceLock(sessionId: string, requestId: string): Promise<void> {
	if (useLocalVoiceQuotas()) return localVoiceQuotas.releaseVoiceLock(sessionId, requestId);

	await redisCommand([
		'EVAL',
		"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
		1,
		`quota:v1:lock:${sessionId}`,
		requestId
	]);
}

export async function finishVoiceGame(sessionId: string, gameId: string): Promise<{ remainingGames: number; voiceMoves: number }> {
	if (useLocalVoiceQuotas()) return localVoiceQuotas.finishVoiceGame(sessionId, gameId);

	const now = Math.floor(Date.now() / 1000);
	const result = await redisCommand<[number, number]>([
		'EVAL', END_GAME_SCRIPT, 3,
		`quota:v1:game:${sessionId}:${gameId}`,
		`quota:v1:games:rolling:${sessionId}`,
		`quota:v1:short-exemptions:${sessionId}`,
		10,
		numberFromEnv('VOICE_GAMES_PER_DAY', 3),
		5,
		now,
		gameId
	]);
	return { remainingGames: result[0], voiceMoves: result[1] };
}

export async function remainingVoiceGames(sessionId: string): Promise<number> {
	if (useLocalVoiceQuotas()) return localVoiceQuotas.remainingVoiceGames(sessionId);

	const now = Math.floor(Date.now() / 1000);
	const used = Number(await redisCommand<number | string>([
		'EVAL',
		"redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - 86400); return redis.call('ZCARD', KEYS[1])",
		1,
		`quota:v1:games:rolling:${sessionId}`,
		now
	]) ?? 0);
	return Math.max(0, numberFromEnv('VOICE_GAMES_PER_DAY', 3) - used);
}

export async function reserveTts(sessionId: string): Promise<{ allowed: boolean; reason: string }> {
	if (useLocalVoiceQuotas()) return localVoiceQuotas.reserveTts(sessionId);

	const day = new Date().toISOString().slice(0, 10);
	const month = day.slice(0, 7);
	const result = await redisCommand<[number, string]>([
		'EVAL', TTS_RESERVATION_SCRIPT, 3,
		`quota:v1:tts:minute:${sessionId}`,
		`quota:v1:tts:day:${day}:global`,
		`quota:v1:tts:month:${month}:global`,
		40,
		numberFromEnv('TTS_GLOBAL_DAY', 2000),
		numberFromEnv('TTS_GLOBAL_MONTH', 22400)
	]);
	return { allowed: result[0] === 1, reason: result[1] };
}

function numberFromEnv(name: string, fallback: number): number {
	const parsed = Number(env[name]);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
