import { expect, test } from 'bun:test';
import { selectNodeToolchain } from '../toolchain-platform';

test('Monterey and early Ventura use the pinned compatible Node runtime', () => {
  for (const arch of ['x64', 'arm64']) {
    for (const version of ['11.7.10', '12.7.6', '13.4.1']) {
      const node = selectNodeToolchain('darwin', arch, version);
      expect(node.version).toStartWith('22.');
      expect(node.archive.directory).toBe(`node-v${node.version}-darwin-${arch}`);
      expect(node.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(selectNodeToolchain('darwin', arch, '13.5').version).toStartWith('24.');
    expect(selectNodeToolchain('darwin', arch, '15.6.1').version).toStartWith('24.');
    expect(selectNodeToolchain('linux', arch).version).toStartWith('24.');
  }
  expect(() => selectNodeToolchain('darwin', 'x64', '10.15.7')).toThrow('macOS 11');
  expect(() => selectNodeToolchain('darwin', 'x64', 'unknown')).toThrow('compatible toolchain');
  expect(() => selectNodeToolchain('win32', 'x64')).toThrow('supports macOS');
});
