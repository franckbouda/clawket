import { GatewayProtocolClient as GatewayClient } from './gateway-client';

function client() {
  const gateway = Object.create(GatewayClient.prototype) as GatewayClient;
  const request = jest.fn();
  Object.assign(gateway, { request });
  return { gateway, request };
}

describe('model catalog refresh compatibility', () => {
  it('fetches a new provider catalog on a picker refresh', async () => {
    const { gateway, request } = client();
    request.mockResolvedValueOnce({ models: [{ id: 'old' }] }).mockResolvedValueOnce({ models: [{ id: 'vendor/new' }] });
    expect(await gateway.listModels()).toEqual([{ id: 'old' }]);
    expect(await gateway.listModels({ refresh: true })).toEqual([{ id: 'vendor/new' }]);
    expect(request.mock.calls).toEqual([['models.list', {}], ['models.list', { refresh: true }]]);
  });
  it('falls back only when a legacy Gateway rejects the additive refresh field', async () => {
    const { gateway, request } = client();
    request.mockRejectedValueOnce(new Error("Unexpected property 'refresh'")).mockResolvedValueOnce({ models: [{ id: 'legacy' }] });
    expect(await gateway.listModels({ refresh: true })).toEqual([{ id: 'legacy' }]);
    expect(request).toHaveBeenLastCalledWith('models.list', {});
  });
  it.each(['Unauthorized', 'Provider refresh timed out', 'Unknown provider', 'Unknown provider refresh-v2'])('does not hide %s', async message => {
    const { gateway, request } = client();
    request.mockRejectedValue(new Error(message));
    await expect(gateway.listModels({ refresh: true })).rejects.toThrow(message);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
