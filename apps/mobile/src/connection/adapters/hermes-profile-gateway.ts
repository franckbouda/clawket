import { AdapterError } from '@clawket/agent-protocol';
import type { GatewayClient } from '../protocol';
/** Independent request view: never mutates the live client's global selection or transport. */
export function profileGateway(gateway: GatewayClient, profile: string, available: () => boolean = () => true): GatewayClient {
  const request: GatewayClient['request'] = (method, params, ...options) => {
    if (!available()) return Promise.reject(new AdapterError('unsupported', 'Update the Bridge to use Hermes profiles.'));
    return gateway.request('hermes.profile.request', { profile, method, params }, ...options);
  };
  return new Proxy(gateway, { get(target, key) {
    if (key === 'request') return request;
    return Reflect.get(target, key, target);
  } });
}
