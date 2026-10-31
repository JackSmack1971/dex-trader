import { snapshotProviderMembership } from './provider-config.js';
import type { RpcMethod } from './rpc-client.js';

export interface RpcProvider {
  readonly operatorId: string;
  readonly request: <T = unknown>(method: string, params?: readonly unknown[]) => Promise<T>;
}
export type PinnedReadMethod = 'eth_call' | 'eth_getCode' | 'eth_getStorageAt' | 'eth_getBalance';
export interface BlockHeader {
  readonly number: bigint;
  readonly hash: `0x${string}`;
  readonly parentHash: `0x${string}`;
  readonly timestamp: bigint;
}
export type CanonicalStateReason = 'CHAIN_MISMATCH' | 'PROVIDER_FAILURE' | 'PROVIDER_TIMEOUT' | 'MALFORMED_RESPONSE' | 'HEAD_DIVERGENCE_EXCEEDED' | 'BLOCK_HASH_DISAGREEMENT' | 'STALE_BLOCK' | 'FUTURE_BLOCK' | 'FINALIZED_DISAGREEMENT' | 'FINALIZED_ORDER_INVALID' | 'CLOCK_SANITY_FAILED' | 'READ_DISAGREEMENT' | 'READ_UNAVAILABLE' | 'REORG_DETECTED' | 'PROVIDER_INDEPENDENCE_UNDECLARED';
export class CanonicalStateError extends Error {
  constructor(readonly reason: CanonicalStateReason) { super(reason); this.name = 'CanonicalStateError'; }
}
export interface CanonicalStateOptions {
  readonly divergenceCapBlocks: number;
  readonly maxCandidateAgeSeconds: number;
  readonly clockSkewSeconds: number;
  readonly reviewReadBudgetMs: number;
  readonly now?: () => number;
  readonly independenceApproved?: boolean;
}
export const S2_PROVISIONAL_DEFAULTS = Object.freeze({ maxCandidateAgeSeconds: 300, divergenceCapBlocks: 150, clockSkewSeconds: 10, perCallTimeoutMs: 5000, reviewReadBudgetMs: 20000, retries: 0, crossProviderFallback: false });
export interface CanonicalSnapshot {
  readonly chainId: 8453n;
  readonly candidate: BlockHeader;
  readonly finalized: BlockHeader;
  readonly providerOperatorIds: readonly [string, string];
  readonly observedAt: number;
  readonly deadlineAt: number;
}

const MAX_BLOCK_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

function deny(reason: CanonicalStateReason): never { throw new CanonicalStateError(reason); }
function parseQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !MAX_BLOCK_QUANTITY.test(value)) deny('MALFORMED_RESPONSE');
  return BigInt(value);
}
function parseBlock(value: unknown): BlockHeader {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype || typeof value.number !== 'string' || typeof value.timestamp !== 'string' ||
    typeof value.hash !== 'string' || !HASH.test(value.hash) || typeof value.parentHash !== 'string' || !HASH.test(value.parentHash)) deny('MALFORMED_RESPONSE');
  return Object.freeze({ number: parseQuantity(value.number), timestamp: parseQuantity(value.timestamp), hash: value.hash.toLowerCase() as `0x${string}`, parentHash: value.parentHash.toLowerCase() as `0x${string}` });
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function classify(error: unknown): never {
  if (error instanceof CanonicalStateError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'RPC_TIMEOUT') deny('PROVIDER_TIMEOUT');
  if (code === 'RPC_MALFORMED_RESPONSE') deny('MALFORMED_RESPONSE');
  deny('PROVIDER_FAILURE');
}
function withinDeadline<T>(promise: Promise<T>, endAt: number): Promise<T> {
  const remaining = endAt - Date.now();
  if (remaining <= 0) return Promise.reject(new CanonicalStateError('PROVIDER_TIMEOUT'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CanonicalStateError('PROVIDER_TIMEOUT')), remaining);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
async function request<T>(provider: RpcProvider, method: RpcMethod, params: readonly unknown[], endAt: number): Promise<T> {
  try { return await withinDeadline(provider.request<T>(method, params), endAt); }
  catch (error) { return classify(error); }
}
async function getBlock(provider: RpcProvider, tag: string | `0x${string}`, endAt: number): Promise<BlockHeader> {
  return parseBlock(await request(provider, 'eth_getBlockByNumber', [tag, false], endAt));
}
function sameCandidate(a: BlockHeader, b: BlockHeader): boolean { return a.hash === b.hash && a.parentHash === b.parentHash && a.timestamp === b.timestamp; }

export async function establishCanonicalState(providersInput: readonly RpcProvider[], options: CanonicalStateOptions): Promise<CanonicalSnapshot> {
  if (!options.independenceApproved) deny('PROVIDER_INDEPENDENCE_UNDECLARED');
  let providers: readonly Readonly<RpcProvider>[];
  try { providers = snapshotProviderMembership(providersInput); }
  catch { deny('MALFORMED_RESPONSE'); }
  const providerA = providers[0]!;
  const providerB = providers[1]!;
  if (!Number.isSafeInteger(options.divergenceCapBlocks) || options.divergenceCapBlocks < 0 ||
      !Number.isSafeInteger(options.maxCandidateAgeSeconds) || options.maxCandidateAgeSeconds < 0 ||
      !Number.isSafeInteger(options.clockSkewSeconds) || options.clockSkewSeconds < 0 ||
      !Number.isSafeInteger(options.reviewReadBudgetMs) || options.reviewReadBudgetMs <= 0) deny('MALFORMED_RESPONSE');
  const endAt = Date.now() + options.reviewReadBudgetMs;
  const now = options.now ?? Date.now;
  try {
    const chainIds = await Promise.all(providers.map((p) => request<unknown>(p, 'eth_chainId', [], endAt)));
    if (chainIds.some((id) => parseQuantity(id) !== 8453n)) deny('CHAIN_MISMATCH');
    const [safeA, safeB, finalizedA, finalizedB, latestA, latestB] = await Promise.all([
      getBlock(providerA, 'safe', endAt), getBlock(providerB, 'safe', endAt),
      getBlock(providerA, 'finalized', endAt), getBlock(providerB, 'finalized', endAt),
      getBlock(providerA, 'latest', endAt), getBlock(providerB, 'latest', endAt),
    ]);
    const divergence = safeA.number > safeB.number ? safeA.number - safeB.number : safeB.number - safeA.number;
    if (divergence > BigInt(options.divergenceCapBlocks)) deny('HEAD_DIVERGENCE_EXCEEDED');
    const candidateNumber = safeA.number < safeB.number ? safeA.number : safeB.number;
    const candidateTag = `0x${candidateNumber.toString(16)}` as const;
    const [candidateA, candidateB] = await Promise.all([getBlock(providerA, candidateTag, endAt), getBlock(providerB, candidateTag, endAt)]);
    if (candidateA.number !== candidateNumber || candidateB.number !== candidateNumber || !sameCandidate(candidateA, candidateB)) deny('BLOCK_HASH_DISAGREEMENT');
    if ((safeA.number === candidateNumber && !sameCandidate(candidateA, safeA)) || (safeB.number === candidateNumber && !sameCandidate(candidateB, safeB))) deny('BLOCK_HASH_DISAGREEMENT');
    const finalizedHeight = finalizedA.number < finalizedB.number ? finalizedA.number : finalizedB.number;
    if (candidateNumber <= finalizedHeight) deny('FINALIZED_ORDER_INVALID');
    const finalizedTag = `0x${finalizedHeight.toString(16)}` as const;
    const [finalAtA, finalAtB] = await Promise.all([getBlock(providerA, finalizedTag, endAt), getBlock(providerB, finalizedTag, endAt)]);
    if (finalAtA.number !== finalizedHeight || finalAtB.number !== finalizedHeight || finalAtA.hash !== finalAtB.hash) deny('FINALIZED_DISAGREEMENT');
    if ((finalizedA.number === finalizedHeight && finalizedA.hash !== finalAtA.hash) || (finalizedB.number === finalizedHeight && finalizedB.hash !== finalAtB.hash)) deny('FINALIZED_DISAGREEMENT');
    const nowMs = now();
    if (!Number.isFinite(nowMs)) deny('CLOCK_SANITY_FAILED');
    const nowMsBig = BigInt(Math.trunc(nowMs));
    const latestMedianMs = (latestA.timestamp + latestB.timestamp) * 500n;
    const clockDifferenceMs = nowMsBig > latestMedianMs ? nowMsBig - latestMedianMs : latestMedianMs - nowMsBig;
    if (clockDifferenceMs > BigInt(options.clockSkewSeconds) * 1000n) deny('CLOCK_SANITY_FAILED');
    const candidateMs = candidateA.timestamp * 1000n;
    if (candidateMs > nowMsBig) deny('FUTURE_BLOCK');
    if (nowMsBig - candidateMs > BigInt(options.maxCandidateAgeSeconds) * 1000n) deny('STALE_BLOCK');
    return Object.freeze({ chainId: 8453n, candidate: candidateA, finalized: finalAtA, providerOperatorIds: Object.freeze([providerA.operatorId, providerB.operatorId]) as readonly [string, string], observedAt: nowMs, deadlineAt: endAt });
  } catch (error) { return classify(error); }
}

function stableJson(value: unknown): string {
  if (typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function readPinnedFromBoth<T>(snapshot: CanonicalSnapshot, providersInput: readonly RpcProvider[], method: PinnedReadMethod, params: readonly unknown[], options: CanonicalStateOptions): Promise<readonly [T, T]> {
  const session = createPinnedReadSession(snapshot, providersInput, options);
  const values = await session.read<T>(method, params);
  await session.finish();
  return values;
}

export function createPinnedReadSession(snapshot: CanonicalSnapshot, providersInput: readonly RpcProvider[], options: CanonicalStateOptions): {
  read<T>(method: PinnedReadMethod, params: readonly unknown[]): Promise<readonly [T, T]>;
  finish(): Promise<void>;
} {
  const providers = snapshotProviderMembership(providersInput);
  const providerA = providers[0]!;
  const providerB = providers[1]!;
  if (providerA.operatorId !== snapshot.providerOperatorIds[0] || providerB.operatorId !== snapshot.providerOperatorIds[1]) deny('READ_UNAVAILABLE');
  const endAt = snapshot.deadlineAt;
  let finished = false;
  return {
    async read<T>(method: PinnedReadMethod, params: readonly unknown[]): Promise<readonly [T, T]> {
      if (finished) deny('READ_UNAVAILABLE');
      const expectedCount = method === 'eth_getStorageAt' ? 3 : method === 'eth_call' || method === 'eth_getCode' || method === 'eth_getBalance' ? 2 : 0;
      if (method === 'eth_call' ? params.length < 1 || params.length > 2 : params.length !== expectedCount) deny('READ_UNAVAILABLE');
      const blockRef = { blockHash: snapshot.candidate.hash };
      const pinnedParams = method === 'eth_call'
        ? [params[0], blockRef]
        : method === 'eth_getStorageAt' || method === 'eth_getBalance' || method === 'eth_getCode'
          ? [...params.slice(0, -1), blockRef]
          : params;
      const [left, right] = await Promise.all([request<T>(providerA, method, pinnedParams, endAt), request<T>(providerB, method, pinnedParams, endAt)]);
      if (stableJson(left) !== stableJson(right)) deny('READ_DISAGREEMENT');
      return Object.freeze([left, right]) as readonly [T, T];
    },
    async finish(): Promise<void> {
      if (finished) deny('READ_UNAVAILABLE');
      finished = true;
      const numberTag = `0x${snapshot.candidate.number.toString(16)}` as const;
      const [postA, postB] = await Promise.all([getBlock(providerA, numberTag, endAt), getBlock(providerB, numberTag, endAt)]);
      if (postA.number !== snapshot.candidate.number || postB.number !== snapshot.candidate.number || postA.hash !== snapshot.candidate.hash || postB.hash !== snapshot.candidate.hash) deny('REORG_DETECTED');
    },
  };
}
