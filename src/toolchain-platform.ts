import pins from '../vendor/toolchain.json';
import { AccountError } from '../packages/identity/src/signer';

export function selectNodeToolchain(platform: string, arch: string, macVersion?: string) {
  let legacy = false;
  if (platform === 'darwin') {
    const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(macVersion ?? '');
    if (!match || Number(match[1]) < 11)
      throw new AccountError(
        'TOOLCHAIN_OS',
        'Project setup requires macOS 11 or newer. Could not select a compatible toolchain.',
      );
    const major = Number(match[1]),
      minor = Number(match[2]);
    legacy = major < 13 || (major === 13 && minor < 5);
  }
  const pin = legacy ? pins.nodeLegacyMac : pins.node;
  const key = `${platform}-${arch}`;
  const archive = (
    pin.platforms as Record<string, { url: string; sha256: string; directory: string }>
  )[key];
  if (!archive)
    throw new AccountError(
      'TOOLCHAIN_PLATFORM',
      'The project toolchain supports macOS and glibc Linux on ARM64/x64.',
    );
  return { version: pin.version, archive };
}
