import { isAddress, type Hex } from 'viem';
import { hashSafeTransaction, type SafeHashDomain, type SafeTransactionHashFields } from './safe-hash.js';

export type SafeDecodeReason =
  | 'UNSUPPORTED_SAFE_PROFILE'
  | 'INVALID_SAFE_TRANSACTION'
  | 'SAFE_OPERATION_UNSUPPORTED'
  | 'SAFE_NONZERO_FORBIDDEN_FIELD';

export class SafeTransactionError extends Error {
  readonly reason: SafeDecodeReason;
  readonly field: string | undefined;

  constructor(reason: SafeDecodeReason, field?: string) {
    super(reason);
    this.name = 'SafeTransactionError';
    this.reason = reason;
    this.field = field;
  }
}

export interface SafeProfile extends SafeHashDomain {
  readonly implementation: string;
  readonly version: string;
}

export interface DecodedSafeTransaction {
  readonly transaction: SafeTransactionHashFields;
  readonly domain: SafeHashDomain;
  readonly digest: Hex;
  readonly operation: 0;
}

const TRANSACTION_FIELDS = [
  'to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice',
  'gasToken', 'refundReceiver', 'nonce',
] as const;
const PROFILE_FIELDS = ['implementation', 'version', 'chainId', 'verifyingSafe'] as const;
const UINT = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function readExactPlainRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) return undefined;
    const expected = [...fields].sort();
    const actual = (ownKeys as string[]).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return undefined;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of actual) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function uint(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n && value <= UINT256_MAX) return value;
  if (typeof value === 'string' && UINT.test(value) && BigInt(value) <= UINT256_MAX) return BigInt(value);
  throw new SafeTransactionError('INVALID_SAFE_TRANSACTION');
}

function safeAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS.test(value) && isAddress(value);
}

export function decodeSafeTransaction(raw: unknown, profile: unknown): DecodedSafeTransaction {
  const profileRecord = readExactPlainRecord(profile, PROFILE_FIELDS);
  if (!profileRecord ||
      profileRecord.implementation !== 'SafeL2' || profileRecord.version !== '1.5.0' ||
      !safeAddress(profileRecord.verifyingSafe)) {
    throw new SafeTransactionError('UNSUPPORTED_SAFE_PROFILE');
  }
  let chainId: bigint;
  try { chainId = uint(profileRecord.chainId); }
  catch { throw new SafeTransactionError('UNSUPPORTED_SAFE_PROFILE'); }
  if (chainId !== 8453n) throw new SafeTransactionError('UNSUPPORTED_SAFE_PROFILE', 'chainId');

  const rawRecord = readExactPlainRecord(raw, TRANSACTION_FIELDS);
  if (!rawRecord) {
    throw new SafeTransactionError('INVALID_SAFE_TRANSACTION');
  }
  if (!safeAddress(rawRecord.to) || !safeAddress(rawRecord.gasToken) || !safeAddress(rawRecord.refundReceiver) ||
      typeof rawRecord.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(rawRecord.data) ||
      typeof rawRecord.operation !== 'number' || !Number.isInteger(rawRecord.operation) || rawRecord.operation < 0 || rawRecord.operation > 255) {
    throw new SafeTransactionError('INVALID_SAFE_TRANSACTION');
  }
  if (rawRecord.operation !== 0) throw new SafeTransactionError('SAFE_OPERATION_UNSUPPORTED', 'operation');

  let value: bigint, safeTxGas: bigint, baseGas: bigint, gasPrice: bigint, nonce: bigint;
  try {
    value = uint(rawRecord.value);
    safeTxGas = uint(rawRecord.safeTxGas);
    baseGas = uint(rawRecord.baseGas);
    gasPrice = uint(rawRecord.gasPrice);
    nonce = uint(rawRecord.nonce);
  } catch {
    throw new SafeTransactionError('INVALID_SAFE_TRANSACTION');
  }
  for (const [field, amount] of [['value', value], ['safeTxGas', safeTxGas], ['baseGas', baseGas], ['gasPrice', gasPrice]] as const) {
    if (amount !== 0n) throw new SafeTransactionError('SAFE_NONZERO_FORBIDDEN_FIELD', field);
  }
  if ((rawRecord.gasToken as string).toLowerCase() !== ZERO_ADDRESS || (rawRecord.refundReceiver as string).toLowerCase() !== ZERO_ADDRESS) {
    throw new SafeTransactionError('SAFE_NONZERO_FORBIDDEN_FIELD', (rawRecord.gasToken as string).toLowerCase() !== ZERO_ADDRESS ? 'gasToken' : 'refundReceiver');
  }

  const transaction: SafeTransactionHashFields = {
    to: rawRecord.to as string,
    value,
    data: rawRecord.data as Hex,
    operation: 0,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken: rawRecord.gasToken as string,
    refundReceiver: rawRecord.refundReceiver as string,
    nonce,
  };
  const domain = { chainId, verifyingSafe: profileRecord.verifyingSafe as string };
  try {
    return { transaction, domain, operation: 0, digest: hashSafeTransaction(transaction, domain) };
  } catch {
    throw new SafeTransactionError('INVALID_SAFE_TRANSACTION');
  }
}
