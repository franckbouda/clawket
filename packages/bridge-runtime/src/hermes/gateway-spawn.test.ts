import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(() => ({ pid: 123 })) }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));
import { spawnHermesGateway } from './gateway-process.js';
afterEach(() => vi.unstubAllEnvs());
it('pins a managed Hermes child to the configured home while preserving API authentication and legacy arguments', () => {
  vi.stubEnv('CLAWKET_HERMES_BRIDGE_TOKEN', 'bridge-token');
  vi.stubEnv('CLAWKET_HERMES_VERBOSE', '0');
  spawnHermesGateway({ command: 'hermes', hermesHomePath: '/configured/hermes', apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'native-api-key', log: vi.fn() });
  expect(mocks.spawn).toHaveBeenCalledWith('hermes', ['gateway', 'run', '--replace'], expect.objectContaining({
    stdio: 'ignore', env: expect.objectContaining({ HERMES_HOME: '/configured/hermes', HERMES_GATEWAY_EXTERNAL_SUPERVISOR: '1',
      API_SERVER_ENABLED: 'true', API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: '8642', API_SERVER_KEY: 'native-api-key' }),
  }));
  const options = mocks.spawn.mock.calls[0][2] as unknown as { env: NodeJS.ProcessEnv };
  expect(options.env).not.toHaveProperty('CLAWKET_HERMES_BRIDGE_TOKEN');
});
