import {
  concatHex,
  encodeAbiParameters,
  isAddress,
  keccak256,
  stringToHex,
  type Hex,
} from 'viem';

const SAFE_TX_TYPEHASH = keccak256(stringToHex(
  'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
));
const DOMAIN_SEPARATOR_TYPEHASH = '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as Hex;
const UINT256_MAX = (1n << 256n) - 1n;

export interface SafeTransactionHashFields {
  readonly to: string;
  readonly value: bigint | string;
  readonly data: Hex;
  readonly operation: number;
  readonly safeTxGas: bigint | string;
  readonly baseGas: bigint | string;
  readonly gasPrice: bigint | string;
  readonly gasToken: string;
  readonly refundReceiver: string;
  readonly nonce: bigint | string;
}

export interface SafeHashDomain {
  readonly chainId: bigint | string;
  readonly verifyingSafe: string;
}

function uint256(value: bigint | string, field: string): bigint {
  let result: bigint;
  if (typeof value === 'bigint') result = value;
  else if (/^(0|[1-9][0-9]*)$/.test(value)) result = BigInt(value);
  else throw new TypeError(`${field} must be a canonical unsigned decimal integer`);
  if (result < 0n || result > UINT256_MAX) throw new RangeError(`${field} is outside uint256`);
  return result;
}

function address(value: string, field: string): `0x${string}` {
  if (!isAddress(value)) throw new TypeError(`${field} must be a 20-byte address`);
  return value as `0x${string}`;
}

function bytes(value: Hex): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new TypeError('data must be even-length hexadecimal bytes');
  }
  return value;
}

export function hashSafeTransaction(
  transaction: SafeTransactionHashFields,
  domain: SafeHashDomain,
): Hex {
  const chainId = uint256(domain.chainId, 'chainId');
  const verifyingSafe = address(domain.verifyingSafe, 'verifyingSafe');
  const dataHash = keccak256(bytes(transaction.data));
  const safeTxStructHash = keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bytes32' },
      { type: 'uint8' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
    ],
    [
      SAFE_TX_TYPEHASH,
      address(transaction.to, 'to'),
      uint256(transaction.value, 'value'),
      dataHash,
      transaction.operation,
      uint256(transaction.safeTxGas, 'safeTxGas'),
      uint256(transaction.baseGas, 'baseGas'),
      uint256(transaction.gasPrice, 'gasPrice'),
      address(transaction.gasToken, 'gasToken'),
      address(transaction.refundReceiver, 'refundReceiver'),
      uint256(transaction.nonce, 'nonce'),
    ],
  ));
  const domainSeparator = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [DOMAIN_SEPARATOR_TYPEHASH, chainId, verifyingSafe],
  ));
  return keccak256(concatHex(['0x1901', domainSeparator, safeTxStructHash]));
}
