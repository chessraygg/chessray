// ── Preferences persistence ──
const PREFS_KEY = 'chessray-prefs';

export interface Prefs {
  overlayVisible: boolean;
  borderVisible: boolean;
  arrowsVisible: boolean;
  lineVisible: boolean;
  pvDepth: number;
  lossThreshold: number;
  playedLossThreshold: number;
  maxDepth: number;
  multiPvMax: number;
  multiPvRamp: number;
  evalBarVisible: boolean;
  panelScale: number;
  collapsed: boolean;
  autoMode: boolean;
  autoDelaySec: number;
  pvGrowDelaySec: number;
  vboardOverlayVisible: boolean;
  compactMode: boolean;
  changeDetect: boolean;
  pvWhiteColor: string;
  pvBlackColor: string;
  collapsedSections: string[];
  panelLeft: number | null;
  panelTop: number | null;
}

export const DEFAULT_PREFS: Prefs = {
  overlayVisible: true,
  borderVisible: false,
  arrowsVisible: false,
  lineVisible: true,
  autoMode: false,
  autoDelaySec: 5,
  pvGrowDelaySec: 3,
  vboardOverlayVisible: true,
  compactMode: false,
  changeDetect: true,
  pvWhiteColor: '#60a5fa',
  pvBlackColor: '#f9a8d4',
  pvDepth: 10,
  lossThreshold: 0,
  playedLossThreshold: 50,
  maxDepth: 28,
  multiPvMax: 5,
  multiPvRamp: 1,
  evalBarVisible: true,
  panelScale: 1,
  collapsed: false,
  collapsedSections: ['debug'],
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
