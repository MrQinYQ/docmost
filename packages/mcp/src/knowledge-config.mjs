import { loadOpenVikingConfig } from './openviking-config.mjs';

/** Select before consulting backend configuration. Disabled means no side effects. */
export function loadKnowledgeConfig(env = process.env) {
  const provider = env.DOCMOST_KNOWLEDGE_PROVIDER?.trim();
  if (provider === 'none') return undefined;
  if (provider && provider !== 'openviking') return { provider: 'unsupported', error: {
    code: 'KB_UNSUPPORTED_PROVIDER', message: 'This knowledge-base provider is not supported. Choose none or openviking.',
  } };
  const config = loadOpenVikingConfig(env);
  if (!provider && !config) return undefined;
  return { provider: 'openviking', config: config ?? { error: {
    code: 'OV_CONFIG_ERROR', message: 'Set DOCMOST_OPENVIKING_URL to the OpenViking deployment root URL.',
  } } };
}
