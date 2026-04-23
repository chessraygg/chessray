// ── Preferences persistence ──
const PREFS_KEY = 'chessray-prefs';

export interface Prefs {
  overlayVisible: boolean;
  borderVisible: boolean;
  pvDepth: number;
  lossThreshold: number;
  maxDepth: number;
  multiPvMax: number;
  multiPvRamp: number;
  evalBarVisible: boolean;
  panelScale: number;
  collapsed: boolean;
  autoDelaySec: number;
  /** When true, auto-play the PV piece-by-piece animation after the top-moves delay. */
  pvAutoplay: boolean;
  pvGrowDelaySec: number;
  /** Seconds the PV preview phase (single highlighted move, others hidden)
   *  stays visible before the per-step PV animation starts. */
  pvPreviewSec: number;
  showMovesDelaySec: number;
  vboardOverlayVisible: boolean;
  compactMode: boolean;
  /** @deprecated kept for migration only — superseded by fpsMin/fpsMax. */
  targetFps: number;
  /** Lower bound of the auto-tuned FPS range. */
  fpsMin: number;
  /** Upper bound of the auto-tuned FPS range. */
  fpsMax: number;
  changeDetect: boolean;
  collapsedSections: string[];
  hiddenSections: string[];
  panelLeft: number | null;
  panelTop: number | null;
  panelWidth: number | null;
  panelHeight: number | null;
  sectionLayout: unknown | null;
  gravityUp: boolean;
  /** Debug section's board-preview image scale, percent of panel width (25..200). */
  debugImgScale: number;
}

export const DEFAULT_PREFS: Prefs = {
  overlayVisible: true,
  borderVisible: false,
  autoDelaySec: 5,
  pvAutoplay: false,
  pvGrowDelaySec: 3,
  pvPreviewSec: 1,
  showMovesDelaySec: 0,
  vboardOverlayVisible: true,
  compactMode: false,
  targetFps: 2,
  fpsMin: 1,
  fpsMax: 5,
  changeDetect: true,
  pvDepth: 10,
  lossThreshold: 0,
  maxDepth: 28,
  multiPvMax: 5,
  multiPvRamp: 1,
  evalBarVisible: true,
  panelScale: 1,
  collapsed: false,
  collapsedSections: ['debug'],
  hiddenSections: [],
  panelLeft: null,
  panelTop: null,
  panelWidth: null,
  panelHeight: null,
  sectionLayout: null,
  gravityUp: true,
  debugImgScale: 100,
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
