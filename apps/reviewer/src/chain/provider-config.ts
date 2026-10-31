import { RpcClient } from './rpc-client.js';

export interface ProviderDefinition {
  readonly operatorId: string;
  readonly urlEnvVar: 'BASE_RPC_ALCHEMY_URL' | 'BASE_RPC_QUICKNODE_URL';
}

export class ProviderConfigError extends Error {
  constructor(readonly reason: 'PROVIDER_CONFIG_INVALID' | 'AWAITING_CREDENTIALS') { super(reason); this.name = 'ProviderConfigError'; }
}

const CANDIDATES: readonly ProviderDefinition[] = Object.freeze([
  Object.freeze({ operatorId: 'alchemy-candidate', urlEnvVar: 'BASE_RPC_ALCHEMY_URL' }),
  Object.freeze({ operatorId: 'quicknode-candidate', urlEnvVar: 'BASE_RPC_QUICKNODE_URL' }),
]);

export function getCandidateProviderDefinitions(): readonly ProviderDefinition[] {
  return Object.freeze(CANDIDATES.map((item) => Object.freeze({ ...item })));
}

export interface ConfiguredProvider {
  readonly operatorId: string;
  readonly urlEnvVar: ProviderDefinition['urlEnvVar'];
  readonly endpoint: string;
}

export interface RpcConfiguredProvider {
  readonly operatorId: string;
  readonly request: <T = unknown>(method: string, params?: readonly unknown[]) => Promise<T>;
}

export function configureProviders(definitions: readonly ProviderDefinition[], env: Readonly<Record<string, string | undefined>>): readonly ConfiguredProvider[] {
  if (!Array.isArray(definitions) || definitions.length !== 2) throw new ProviderConfigError('PROVIDER_CONFIG_INVALID');
  const ids = new Set<string>();
  const envs = new Set<string>();
  const providers = definitions.map((definition) => {
    if (!definition || typeof definition.operatorId !== 'string' || definition.operatorId.trim() === '' ||
      ids.has(definition.operatorId) || !['BASE_RPC_ALCHEMY_URL', 'BASE_RPC_QUICKNODE_URL'].includes(definition.urlEnvVar) || envs.has(definition.urlEnvVar)) {
      throw new ProviderConfigError('PROVIDER_CONFIG_INVALID');
    }
    ids.add(definition.operatorId);
    envs.add(definition.urlEnvVar);
    const endpoint = env[definition.urlEnvVar];
    if (typeof endpoint !== 'string' || endpoint === '') throw new ProviderConfigError('AWAITING_CREDENTIALS');
    return Object.freeze({ operatorId: definition.operatorId, urlEnvVar: definition.urlEnvVar, endpoint });
  });
  return Object.freeze(providers);
}

export function createRpcProviders(configured: readonly ConfiguredProvider[]): readonly RpcConfiguredProvider[] {
  if (!Array.isArray(configured) || configured.length !== 2 || !configured[0]?.operatorId.trim() || !configured[1]?.operatorId.trim() ||
      configured[0].operatorId === configured[1].operatorId || configured[0].urlEnvVar === configured[1].urlEnvVar ||
      !['BASE_RPC_ALCHEMY_URL', 'BASE_RPC_QUICKNODE_URL'].includes(configured[0].urlEnvVar) || !['BASE_RPC_ALCHEMY_URL', 'BASE_RPC_QUICKNODE_URL'].includes(configured[1].urlEnvVar)) throw new ProviderConfigError('PROVIDER_CONFIG_INVALID');
  return Object.freeze(configured.map((provider) => {
    const client = new RpcClient({ endpoint: provider.endpoint, timeoutMs: 5000 });
    return Object.freeze({ operatorId: provider.operatorId, urlEnvVar: provider.urlEnvVar, request: <T = unknown>(method: string, params: readonly unknown[] = []) => client.request<T>(method, params) });
  }));
}

export function snapshotProviderMembership<T extends { readonly operatorId: string }>(providers: readonly T[]): readonly Readonly<T>[] {
  if (!Array.isArray(providers) || providers.length !== 2 || providers[0]?.operatorId === providers[1]?.operatorId) throw new ProviderConfigError('PROVIDER_CONFIG_INVALID');
  return Object.freeze(providers.map((provider) => Object.freeze(provider)));
}

