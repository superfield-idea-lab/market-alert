import { describe, expect, it } from 'vitest';
import { createProxy } from './vite.config';

describe('vite proxy configuration', () => {
  it('proxies studio and api routes to the Bun server', () => {
    const proxy = createProxy();
    expect(proxy['/api']).toBeDefined();
    expect(proxy['/studio']).toBeDefined();
  });

  it('uses STUDIO_API_PORT when set', () => {
    const proxy = createProxy({
      ...process.env,
      STUDIO_API_PORT: '32100',
      PORT: undefined,
    });
    expect(proxy['/api']).toEqual(
      expect.objectContaining({
        target: 'http://localhost:32100',
      }),
    );
  });
});
