/**
 * Platform adapter — abstracts OS-specific behavior behind a common interface.
 * Each platform exports a PlatformAdapter; the correct one is selected at startup.
 */

import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';

// ── Interface ──

export interface PlatformAdapter {
  /** Absolute path to the app log file */
  readonly logPath: string;

  /** Extra BrowserWindow constructor options for the overlay (e.g. type: 'panel' on macOS) */
  readonly overlayWindowOptions: Record<string, unknown>;

  /** Configure overlay window for always-on-top behavior (called after creation) */
  configureOverlayWindow(win: BrowserWindow): void;

  /** Get the PID of the frontmost application (for visibility tracking). Resolves null if unsupported. */
  getFrontmostPid(): Promise<string | null>;

  /** Show the app in the OS task switcher / dock (no-op on platforms without a dock) */
  showInDock(app: Electron.App): void;

  /** Query screen capture permission status. Returns 'granted' on platforms without permission gates. */
  getScreenCaptureStatus(systemPreferences: Electron.SystemPreferences): string;

  /** Whether the app should quit when all windows are closed */
  quitOnAllWindowsClosed: boolean;
}

// ── macOS ──

const darwinAdapter: PlatformAdapter = {
  logPath: '/tmp/chessray-app.log',

  overlayWindowOptions: { type: 'panel' },

  configureOverlayWindow(win: BrowserWindow): void {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  },

  getFrontmostPid(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('osascript', ['-e',
        'tell application "System Events" to unix id of first process whose frontmost is true',
      ], (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.trim() || null);
      });
    });
  },

  showInDock(app: Electron.App): void {
    (app as any).dock?.show();
  },

  getScreenCaptureStatus(sp: Electron.SystemPreferences): string {
    return sp.getMediaAccessStatus('screen');
  },

  quitOnAllWindowsClosed: false,
};

// ── Windows ──

const win32Adapter: PlatformAdapter = {
  logPath: path.join(os.tmpdir(), 'chessray-app.log'),

  overlayWindowOptions: {},

  configureOverlayWindow(win: BrowserWindow): void {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true);
  },

  getFrontmostPid(): Promise<string | null> {
    return new Promise((resolve) => {
      // PowerShell: get the PID of the foreground window's process
      const script = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          public class FG {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
          }
"@
        $hwnd = [FG]::GetForegroundWindow()
        $pid = 0
        [void][FG]::GetWindowThreadProcessId($hwnd, [ref]$pid)
        Write-Output $pid
      `.trim();
      execFile('powershell', ['-NoProfile', '-Command', script], (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.trim() || null);
      });
    });
  },

  showInDock(_app: Electron.App): void {
    // Windows: taskbar presence is automatic
  },

  getScreenCaptureStatus(): string {
    return 'granted'; // Windows doesn't gate screen capture
  },

  quitOnAllWindowsClosed: true,
};

// ── Linux ──

const linuxAdapter: PlatformAdapter = {
  logPath: path.join(os.tmpdir(), 'chessray-app.log'),

  overlayWindowOptions: {},

  configureOverlayWindow(win: BrowserWindow): void {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true);
  },

  getFrontmostPid(): Promise<string | null> {
    return new Promise((resolve) => {
      // xdotool: get PID of the active window (X11 only; Wayland has no equivalent)
      execFile('xdotool', ['getactivewindow', 'getwindowpid'], (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.trim() || null);
      });
    });
  },

  showInDock(_app: Electron.App): void {
    // Linux: desktop entry handles taskbar presence
  },

  getScreenCaptureStatus(): string {
    return 'granted'; // Linux doesn't gate screen capture at OS level
  },

  quitOnAllWindowsClosed: true,
};

// ── Export ──

const adapters: Record<string, PlatformAdapter> = {
  darwin: darwinAdapter,
  win32: win32Adapter,
  linux: linuxAdapter,
};

export const platform: PlatformAdapter = adapters[process.platform] ?? linuxAdapter;
