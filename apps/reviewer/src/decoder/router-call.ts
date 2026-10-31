import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { decodeSafeTransaction, readExactPlainRecord, type SafeProfile } from './safe-transaction.js';

const ABI = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline)',
  'function approve(address spender,uint256 amount)',
]);
const ROUTER_PROFILE_FIELDS = ['safe', 'router', 'inputToken', 'outputToken', 'defaultFactory', 'maxAmountIn', 'maxDeadlineHorizonSeconds', 'referenceTimestamp', 'expectedSwapAmountIn'] as const;
const RAW_CALL_FIELDS = ['data', 'target', 'value'] as const;
const OFFLINE_PROFILE_FIELDS = ['implementation', 'version', 'chainId', 'verifyingSafe', 'router', 'inputToken', 'outputToken', 'defaultFactory', 'maxAmountIn', 'maxDeadlineHorizonSeconds', 'referenceTimestamp', 'expectedSwapAmountIn'] as const;

export type RouterCallReason =
  | 'CALL_MALFORMED' | 'CALL_TARGET_UNSUPPORTED' | 'OUTER_VALUE_NONZERO'
  | 'SWAP_RECIPIENT_MISMATCH' | 'SWAP_MIN_OUT_ZERO' | 'SWAP_ROUTE_UNSUPPORTED'
  | 'SWAP_AMOUNT_OUT_OF_RANGE' | 'SWAP_AMOUNT_MISMATCH' | 'SWAP_DEADLINE_OUT_OF_RANGE'
  | 'APPROVAL_TOKEN_UNSUPPORTED' | 'APPROVAL_SPENDER_UNSUPPORTED' | 'APPROVAL_AMOUNT_MISMATCH';

export class RouterCallError extends Error {
  readonly reason: RouterCallReason;
  constructor(reason: RouterCallReason) { super(reason); this.name = 'RouterCallError'; this.reason = reason; }
}

export interface RouterCallProfile {
  readonly safe: string;
  readonly router: string;
  readonly inputToken: string;
  readonly outputToken: string;
  readonly defaultFactory: string;
  readonly maxAmountIn: bigint;
  readonly maxDeadlineHorizonSeconds: bigint;
  readonly referenceTimestamp: bigint;
  readonly expectedSwapAmountIn: bigint;
}

export interface OfflineDecoderProfile extends SafeProfile, Omit<RouterCallProfile, 'safe'> {}

export type DecodedRouterCall =
  | { readonly kind: 'swap'; readonly amountIn: bigint; readonly amountOutMin: bigint; readonly recipient: string; readonly deadline: bigint }
  | { readonly kind: 'approval'; readonly token: string; readonly spender: string; readonly amount: bigint }
  | { readonly kind: 'revoke'; readonly token: string; readonly spender: string; readonly amount: 0n };

interface RawCall { readonly target: string; readonly value: bigint | string; readonly data: Hex }

function fail(reason: RouterCallReason): never { throw new RouterCallError(reason); }
function validAddress(value: string): boolean { return isAddress(value); }
function nonzeroAddress(value: string): boolean { return validAddress(value) && !/^0x0{40}$/i.test(value); }

export function decodeRouterCall(rawInput: unknown, profileInput: unknown): DecodedRouterCall {
  const profileRecord = readExactPlainRecord(profileInput, ROUTER_PROFILE_FIELDS);
  if (!profileRecord) fail('CALL_MALFORMED');
  const profile = profileRecord as unknown as RouterCallProfile;
  const rawRecord = readExactPlainRecord(rawInput, RAW_CALL_FIELDS);
  if (!rawRecord) fail('CALL_MALFORMED');
  const raw = rawRecord as unknown as RawCall;
  if (typeof profile.maxAmountIn !== 'bigint' || typeof profile.expectedSwapAmountIn !== 'bigint' ||
      typeof profile.maxDeadlineHorizonSeconds !== 'bigint' || typeof profile.referenceTimestamp !== 'bigint' ||
      !nonzeroAddress(profile.safe) || !nonzeroAddress(profile.router) || !nonzeroAddress(profile.inputToken) ||
      !nonzeroAddress(profile.outputToken) || !nonzeroAddress(profile.defaultFactory) || profile.maxAmountIn <= 0n ||
      profile.expectedSwapAmountIn <= 0n || profile.expectedSwapAmountIn > profile.maxAmountIn ||
      profile.maxDeadlineHorizonSeconds < 0n || profile.referenceTimestamp < 0n) fail('CALL_MALFORMED');
  if (typeof raw.target !== 'string' || !validAddress(raw.target)) fail('CALL_MALFORMED');
  if (!(typeof raw.value === 'bigint' || (typeof raw.value === 'string' && /^(0|[1-9][0-9]*)$/.test(raw.value)))) fail('CALL_MALFORMED');
  let value: bigint;
  try { value = typeof raw.value === 'bigint' ? raw.value : BigInt(raw.value); } catch { return fail('CALL_MALFORMED'); }
  if (value !== 0n) fail('OUTER_VALUE_NONZERO');
  if (typeof raw.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(raw.data)) fail('CALL_MALFORMED');

  const selector = raw.data.slice(0, 10).toLowerCase();
  if (selector === '0xcac88ea9') {
    if (raw.target.toLowerCase() !== profile.router.toLowerCase()) fail('CALL_TARGET_UNSUPPORTED');
    let decoded: ReturnType<typeof decodeFunctionData>;
    try {
      decoded = decodeFunctionData({ abi: ABI, data: raw.data });
      const canonical = encodeFunctionData({ abi: ABI, functionName: 'swapExactTokensForTokens', args: decoded.args as never });
      if (canonical.toLowerCase() !== raw.data.toLowerCase()) fail('CALL_MALFORMED');
    } catch (error) {
      if (error instanceof RouterCallError) throw error;
      return fail('CALL_MALFORMED');
    }
    if (decoded.functionName !== 'swapExactTokensForTokens') fail('CALL_MALFORMED');
    const [amountIn, amountOutMin, routes, recipient, deadline] = decoded.args as readonly [bigint, bigint, readonly { from: Address; to: Address; stable: boolean; factory: Address }[], Address, bigint];
    if (recipient.toLowerCase() !== profile.safe.toLowerCase()) fail('SWAP_RECIPIENT_MISMATCH');
    if (amountOutMin === 0n) fail('SWAP_MIN_OUT_ZERO');
    if (amountIn === 0n || amountIn > profile.maxAmountIn) fail('SWAP_AMOUNT_OUT_OF_RANGE');
    if (amountIn !== profile.expectedSwapAmountIn) fail('SWAP_AMOUNT_MISMATCH');
    if (deadline < profile.referenceTimestamp || deadline - profile.referenceTimestamp > profile.maxDeadlineHorizonSeconds) fail('SWAP_DEADLINE_OUT_OF_RANGE');
    const route = routes.length === 1 ? routes[0] : undefined;
    if (!route || route.from.toLowerCase() !== profile.inputToken.toLowerCase() ||
        route.to.toLowerCase() !== profile.outputToken.toLowerCase() || route.stable !== false ||
        route.factory.toLowerCase() !== profile.defaultFactory.toLowerCase()) fail('SWAP_ROUTE_UNSUPPORTED');
    return { kind: 'swap', amountIn, amountOutMin, recipient, deadline };
  }

  if (selector === '0x095ea7b3') {
    if (raw.target.toLowerCase() !== profile.inputToken.toLowerCase()) fail('APPROVAL_TOKEN_UNSUPPORTED');
    let args: readonly [Address, bigint];
    try {
      const decoded = decodeFunctionData({ abi: ABI, data: raw.data });
      if (decoded.functionName !== 'approve') fail('CALL_MALFORMED');
      args = decoded.args as readonly [Address, bigint];
      const canonical = encodeFunctionData({ abi: ABI, functionName: 'approve', args });
      if (canonical.toLowerCase() !== raw.data.toLowerCase()) fail('CALL_MALFORMED');
    } catch (error) {
      if (error instanceof RouterCallError) throw error;
      return fail('CALL_MALFORMED');
    }
    const [spender, amount] = args;
    if (spender.toLowerCase() !== profile.router.toLowerCase()) fail('APPROVAL_SPENDER_UNSUPPORTED');
    if (amount === 0n) return { kind: 'revoke', token: profile.inputToken, spender, amount: 0n };
    if (amount !== profile.expectedSwapAmountIn) fail('APPROVAL_AMOUNT_MISMATCH');
    return { kind: 'approval', token: profile.inputToken, spender, amount };
  }
  return fail('CALL_MALFORMED');
}

export function decodeApprovedSafeTransaction(raw: unknown, profileInput: unknown) {
  const profile = readExactPlainRecord(profileInput, OFFLINE_PROFILE_FIELDS);
  if (!profile) fail('CALL_MALFORMED');
  const safe = decodeSafeTransaction(raw, {
    implementation: profile.implementation as string,
    version: profile.version as string,
    chainId: profile.chainId as string | bigint,
    verifyingSafe: profile.verifyingSafe as string,
  });
  if (safe.domain.verifyingSafe.toLowerCase() !== (profile.verifyingSafe as string).toLowerCase()) fail('CALL_MALFORMED');
  const call = decodeRouterCall({
    target: safe.transaction.to,
    value: safe.transaction.value,
    data: safe.transaction.data,
  }, {
    safe: profile.verifyingSafe,
    router: profile.router,
    inputToken: profile.inputToken,
    outputToken: profile.outputToken,
    defaultFactory: profile.defaultFactory,
    maxAmountIn: profile.maxAmountIn,
    maxDeadlineHorizonSeconds: profile.maxDeadlineHorizonSeconds,
    referenceTimestamp: profile.referenceTimestamp,
    expectedSwapAmountIn: profile.expectedSwapAmountIn,
  });
  return { safe, call };
}
