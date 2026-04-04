// ── Preferences persistence ──
const PREFS_KEY = 'chessray-prefs';

export interface Prefs {
  overlayVisible: boolean;
  borderVisible: boolean;
  arrowsVisible: boolean;
  lineVisible: boolean;
  pvDepth: number;
  lossThreshold: number;
  evalBarVisible: boolean;
  panelScale: number;
  collapsed: boolean;
  panelLeft: number | null;
  panelTop: number | null;
}

export const DEFAULT_PREFS: Prefs = {
  overlayVisible: true,
  borderVisible: false,
  arrowsVisible: false,
  lineVisible: true,
  pvDepth: 4,
  lossThreshold: 50,
  evalBarVisible: true,
  panelScale: 1,
  collapsed: false,
  panelLeft: null,
  panelTop: null,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(partial: Partial<Prefs>): void {
  try {
    const current = loadPrefs();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...current, ...partial }));
  } catch { /* ignore */ }
}
