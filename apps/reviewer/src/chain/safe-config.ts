import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { createPinnedReadSession, establishCanonicalState, type CanonicalSnapshot, type CanonicalStateOptions, type PinnedReadMethod, type RpcProvider } from './canonical-state.js';

const trustedConfigBrand: unique symbol = Symbol('TrustedExpectedSafeConfig');
export interface TrustedExpectedSafeConfig {
  readonly [trustedConfigBrand]: true;
  readonly safe: Address;
  readonly singleton: Address;
  readonly singletonCodeHash: Hex;
  readonly proxyRuntimeCodeHash: Hex;
  readonly owners: readonly Address[];
  readonly threshold: bigint;
  readonly fallbackHandler: Address;
  readonly router: Address;
  readonly routerCodeHash: Hex;
  readonly weth: Address;
  readonly wethCodeHash: Hex;
  readonly usdc: Address;
  readonly usdcCodeHash: Hex;
}

export type SafeConfigReason = 'SAFE_CONFIG_INVALID' | 'SAFE_CONFIG_READ_UNAVAILABLE';
export class SafeConfigError extends Error {
  constructor(readonly reason: SafeConfigReason) { super(reason); this.name = 'SafeConfigError'; }
}
const EXPECTED_CONFIG_FIELDS = ['safe', 'singleton', 'singletonCodeHash', 'proxyRuntimeCodeHash', 'owners', 'threshold', 'fallbackHandler', 'router', 'routerCodeHash', 'weth', 'wethCodeHash', 'usdc', 'usdcCodeHash'] as const;

function normalizeExpectedConfig(input: unknown): TrustedExpectedSafeConfig {
  try {
    if (typeof input !== 'object' || input === null || Object.getPrototypeOf(input) !== Object.prototype) deny();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== EXPECTED_CONFIG_FIELDS.length || keys.some((key) => typeof key !== 'string' || !EXPECTED_CONFIG_FIELDS.includes(key as typeof EXPECTED_CONFIG_FIELDS[number]))) deny();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (EXPECTED_CONFIG_FIELDS.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value'))) deny();
    const values = Object.fromEntries(EXPECTED_CONFIG_FIELDS.map((key) => [key, descriptors[key]!.value])) as Omit<TrustedExpectedSafeConfig, typeof trustedConfigBrand>;
    const nonzeroAddress = (address: unknown) => typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/i.test(address);
    if (!Array.isArray(values.owners) || Object.getPrototypeOf(values.owners) !== Array.prototype || values.owners.length === 0) deny();
    const ownerKeys = Reflect.ownKeys(values.owners);
    const ownerDescriptors = Object.getOwnPropertyDescriptors(values.owners);
    if (ownerKeys.length !== values.owners.length + 1 || !Object.hasOwn(ownerDescriptors, 'length') ||
        Array.from({ length: values.owners.length }, (_, index) => String(index)).some((key) => !Object.hasOwn(ownerDescriptors, key) || !Object.hasOwn(ownerDescriptors[key]!, 'value'))) deny();
    const trustedOwners = Array.from({ length: values.owners.length }, (_, index) => ownerDescriptors[String(index)]!.value);
    if (!trustedOwners.every(nonzeroAddress) || new Set(trustedOwners.map((owner) => (owner as string).toLowerCase())).size !== trustedOwners.length ||
        typeof values.threshold !== 'bigint' || values.threshold <= 0n || values.threshold > BigInt(trustedOwners.length) ||
        ![values.safe, values.singleton, values.fallbackHandler, values.router, values.weth, values.usdc].every(nonzeroAddress) ||
        ![values.singletonCodeHash, values.proxyRuntimeCodeHash, values.routerCodeHash, values.wethCodeHash, values.usdcCodeHash].every((hash) => typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash))) deny();
    return Object.freeze({ ...values, owners: Object.freeze(trustedOwners as Address[]) }) as TrustedExpectedSafeConfig;
  } catch (error) {
    if (error instanceof SafeConfigError) throw error;
    return deny('SAFE_CONFIG_INVALID');
  }
}
export interface SafeConfigSnapshot {
  readonly version: '1.5.0';
  readonly singleton: Address;
  readonly singletonCodeHash: Hex;
  readonly proxyRuntimeCodeHash: Hex;
  readonly owners: readonly Address[];
  readonly threshold: bigint;
  readonly nonce: bigint;
  readonly modules: readonly Address[];
  readonly fallbackHandler: Address;
  readonly nativeBalance: bigint;
  readonly wethBalance: bigint;
  readonly usdcBalance: bigint;
  readonly wethAllowance: bigint;
  readonly usdcAllowance: bigint;
  readonly routerCodeHash: Hex;
  readonly wethCodeHash: Hex;
  readonly usdcCodeHash: Hex;
}

const ABI = parseAbi([
  'function VERSION() view returns (string)', 'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)', 'function nonce() view returns (uint256)',
  'function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
]);
type SafeFunctionName = 'VERSION' | 'getOwners' | 'getThreshold' | 'nonce' | 'getModulesPaginated' | 'balanceOf' | 'allowance';
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;
const CANONICAL_SINGLETON = '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e' as Address;
const CANONICAL_SINGLETON_CODE_HASH = '0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc' as Hex;
const CANONICAL_FALLBACK_HANDLER = '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4' as Address;
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
const MODULE_GUARD_SLOT = '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947';
const FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
function deny(reason: SafeConfigReason = 'SAFE_CONFIG_INVALID'): never { throw new SafeConfigError(reason); }
function wordAddress(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) deny();
  return `0x${value.slice(-40)}` as Address;
}
function slotIsZero(value: unknown): boolean { return typeof value === 'string' && /^0x0{64}$/i.test(value); }
function decode<T>(functionName: SafeFunctionName, data: unknown): T {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(data)) deny('SAFE_CONFIG_READ_UNAVAILABLE');
  try {
    const decoded = decodeFunctionResult({ abi: ABI, functionName, data: data as Hex });
    const canonical = encodeFunctionResult({ abi: ABI, functionName, result: decoded as never });
    if (canonical.toLowerCase() !== data.toLowerCase()) deny('SAFE_CONFIG_READ_UNAVAILABLE');
    return decoded as T;
  }
  catch { return deny('SAFE_CONFIG_READ_UNAVAILABLE'); }
}
function callData(functionName: SafeFunctionName, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi: ABI, functionName, args: args as never });
}
export async function readSafeConfiguration(snapshot: CanonicalSnapshot, providers: readonly RpcProvider[], expected: TrustedExpectedSafeConfig, options: CanonicalStateOptions): Promise<SafeConfigSnapshot> {
  expected = normalizeExpectedConfig(expected);
  try {
    const reads = createPinnedReadSession(snapshot, providers, options);
    const pin = async <T>(method: PinnedReadMethod, params: readonly unknown[]): Promise<T> => (await reads.read<T>(method, params))[0];
    const call = async <T>(to: Address, functionName: SafeFunctionName, args: readonly unknown[] = []): Promise<T> => {
      const data = await pin<string>('eth_call', [{ to, data: callData(functionName, args) }, { blockHash: snapshot.candidate.hash }]);
      return decode<T>(functionName, data);
    };
    const [version, singletonRaw, singletonCode, proxyCode, owners, threshold, nonce, modulesRaw, guard, moduleGuard, fallbackRaw,
      nativeBalanceRaw, wethBalance, usdcBalance, wethAllowance, usdcAllowance, routerCode, wethCode, usdcCode] = await Promise.all([
      call<string>(expected.safe, 'VERSION'),
      pin<string>('eth_getStorageAt', [expected.safe, '0x0', { blockHash: snapshot.candidate.hash }]),
      pin<Hex>('eth_getCode', [expected.singleton, { blockHash: snapshot.candidate.hash }]),
      pin<Hex>('eth_getCode', [expected.safe, { blockHash: snapshot.candidate.hash }]),
      call<Address[]>(expected.safe, 'getOwners'),
      call<bigint>(expected.safe, 'getThreshold'),
      call<bigint>(expected.safe, 'nonce'),
      pin<string>('eth_call', [{ to: expected.safe, data: callData('getModulesPaginated', [SENTINEL, 10n]) }, { blockHash: snapshot.candidate.hash }]),
      pin<string>('eth_getStorageAt', [expected.safe, GUARD_SLOT, { blockHash: snapshot.candidate.hash }]),
      pin<string>('eth_getStorageAt', [expected.safe, MODULE_GUARD_SLOT, { blockHash: snapshot.candidate.hash }]),
      pin<string>('eth_getStorageAt', [expected.safe, FALLBACK_SLOT, { blockHash: snapshot.candidate.hash }]),
      pin<string>('eth_getBalance', [expected.safe, { blockHash: snapshot.candidate.hash }]),
      call<bigint>(expected.weth, 'balanceOf', [expected.safe]),
      call<bigint>(expected.usdc, 'balanceOf', [expected.safe]),
      call<bigint>(expected.weth, 'allowance', [expected.safe, expected.router]),
      call<bigint>(expected.usdc, 'allowance', [expected.safe, expected.router]),
      pin<Hex>('eth_getCode', [expected.router, { blockHash: snapshot.candidate.hash }]),
      pin<Hex>('eth_getCode', [expected.weth, { blockHash: snapshot.candidate.hash }]),
      pin<Hex>('eth_getCode', [expected.usdc, { blockHash: snapshot.candidate.hash }]),
    ]);
    await reads.finish();
    const singleton = wordAddress(singletonRaw);
    const fallbackHandler = wordAddress(fallbackRaw);
    const moduleTuple = decode<readonly [readonly Address[], Address]>('getModulesPaginated', modulesRaw) as readonly [unknown, unknown];
    const moduleItems = moduleTuple[0];
    const nextModule = moduleTuple[1];
    if (expected.singleton.toLowerCase() !== CANONICAL_SINGLETON.toLowerCase() || expected.singletonCodeHash.toLowerCase() !== CANONICAL_SINGLETON_CODE_HASH.toLowerCase() ||
      expected.fallbackHandler.toLowerCase() !== CANONICAL_FALLBACK_HANDLER.toLowerCase() || version !== '1.5.0' || singleton.toLowerCase() !== CANONICAL_SINGLETON.toLowerCase() ||
      keccak256(singletonCode).toLowerCase() !== CANONICAL_SINGLETON_CODE_HASH.toLowerCase() ||
      keccak256(proxyCode).toLowerCase() !== expected.proxyRuntimeCodeHash.toLowerCase() ||
      !Array.isArray(owners) || owners.length !== expected.owners.length || owners.some((owner, index) => owner.toLowerCase() !== expected.owners[index]!.toLowerCase()) ||
      threshold !== expected.threshold || nonce < 0n ||
      !Array.isArray(moduleTuple) || moduleTuple.length !== 2 || !Array.isArray(moduleItems) || moduleItems.length !== 0 || typeof nextModule !== 'string' || nextModule.toLowerCase() !== SENTINEL.toLowerCase() ||
      !slotIsZero(guard) || !slotIsZero(moduleGuard) || fallbackHandler.toLowerCase() !== expected.fallbackHandler.toLowerCase() ||
      keccak256(routerCode).toLowerCase() !== expected.routerCodeHash.toLowerCase() ||
      keccak256(wethCode).toLowerCase() !== expected.wethCodeHash.toLowerCase() || keccak256(usdcCode).toLowerCase() !== expected.usdcCodeHash.toLowerCase()) deny();
    const moduleCanonical = encodeFunctionResult({ abi: ABI, functionName: 'getModulesPaginated', result: [[], SENTINEL] });
    if (typeof modulesRaw !== 'string' || modulesRaw.toLowerCase() !== moduleCanonical.toLowerCase()) deny();
    const snapshotResult: SafeConfigSnapshot = Object.freeze({ version: '1.5.0', singleton, singletonCodeHash: keccak256(singletonCode), proxyRuntimeCodeHash: keccak256(proxyCode),
      owners: Object.freeze([...owners]), threshold, nonce, modules: Object.freeze([]), fallbackHandler, nativeBalance: parseNativeBalance(nativeBalanceRaw), wethBalance, usdcBalance, wethAllowance, usdcAllowance,
      routerCodeHash: keccak256(routerCode), wethCodeHash: keccak256(wethCode), usdcCodeHash: keccak256(usdcCode) });
    return snapshotResult;
  } catch (error) {
    if (error instanceof SafeConfigError) throw error;
    return deny('SAFE_CONFIG_READ_UNAVAILABLE');
  }
}

function parseNativeBalance(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) deny('SAFE_CONFIG_READ_UNAVAILABLE');
  return BigInt(value);
}

export async function readCanonicalSafeSnapshot(providers: readonly RpcProvider[], expected: TrustedExpectedSafeConfig, options: CanonicalStateOptions): Promise<Readonly<{ state: CanonicalSnapshot; safe: SafeConfigSnapshot }>> {
  try {
    const state = await establishCanonicalState(providers, options);
    const safe = await readSafeConfiguration(state, providers, expected, options);
    return Object.freeze({ state, safe });
  } catch (error) {
    if (error instanceof SafeConfigError) throw error;
    throw error;
  }
}

export const SAFE_CONFIGURATION_SLOTS = Object.freeze({ guard: GUARD_SLOT, moduleGuard: MODULE_GUARD_SLOT, fallbackHandler: FALLBACK_SLOT });
