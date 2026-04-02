import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'path';

const isDarwin = process.platform === 'darwin';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'ChessRay',
    executableName: 'ChessRay',
    asar: true,
    extraResource: ['../../vendor'],
    // macOS-only: code signing and entitlements for screen capture
    ...(isDarwin ? {
      osxSign: {
        identity: '-', // ad-hoc signing
        optionsForFile: () => ({
          entitlements: path.resolve(__dirname, 'entitlements.plist'),
        }),
      },
      extendInfo: {
        NSScreenCaptureUsageDescription: 'ChessRay needs screen recording to detect chess boards on your screen.',
      },
    } : {}),
  },
  makers: [
    { name: '@electron-forge/maker-zip' },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: { format: 'ULFO' },
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: { name: 'ChessRay' },
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'chessray',
          productName: 'ChessRay',
          maintainer: 'chessraygg',
          homepage: 'https://github.com/chessraygg/chessray',
        },
      },
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [
        {
          name: 'analysis_window',
          config: 'vite.renderer.analysis.config.ts',
        },
        {
          name: 'overlay_window',
          config: 'vite.renderer.overlay.config.ts',
        },
      ],
    }),
  ],
};

export default config;
