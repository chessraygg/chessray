// ── Preferences persistence ──
const PREFS_KEY = 'chessray-prefs';

export interface Prefs {
  overlayVisible: boolean;
  borderVisible: boolean;
  pvDepth: number;
  lossThreshold: number;
  maxDepth: number;
  multiPvMax: number;
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
  /** Upper bound of the auto-tuned FPS range. Floor is hardcoded to 1. */
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
  /** Scales every on-board decoration: best-move arrow width (rank 0), PV step
   *  label circle, and played-move markers. Other arrow ranks keep the 5:4:3
   *  ratio. Value is the target best-move arrow width in px at the canonical
   *  192px board size (5 = previous default). */
  overlaySize: number;
  /** Uniform alpha applied to every on-board decoration (arrows, step labels,
   *  played-move markers). Color carries quality; this is just presence. */
  overlayOpacity: number;
  /** Minimum opacity for the actual-board eval bar when the eval is stale
   *  (position changed; engine is re-evaluating). Lower = more subtle, but
   *  easy to lose track of. Only applies to the actual-board overlay. */
  evalBarStaleOpacity: number;
  /** User-supplied orientation override. null = auto-detect. true = white at
   *  top (flipped). false = white at bottom. Auto-reset to null when the
   *  position changes significantly (new game). */
  manualOrientationFlip: boolean | null;
}

export const DEFAULT_PREFS: Prefs = {
  overlayVisible: true,
  borderVisible: false,
  autoDelaySec: 5,
  pvAutoplay: false,
  pvGrowDelaySec: 1,
  pvPreviewSec: 1,
  showMovesDelaySec: 0,
  vboardOverlayVisible: true,
  compactMode: false,
  targetFps: 2,
  fpsMax: 5,
  changeDetect: true,
  pvDepth: 10,
  lossThreshold: 100,
  maxDepth: 28,
  multiPvMax: 5,
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
  overlaySize: 5,
  overlayOpacity: 0.50,
  evalBarStaleOpacity: 0.90,
  manualOrientationFlip: null,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs> & {
        arrowMaxWidth?: number; arrowMaxOpacity?: number;
      };
      // Migration: the arrow-only knobs were renamed when their scope expanded
      // to all on-board decorations. Copy legacy values forward.
      if (parsed.arrowMaxWidth != null && parsed.overlaySize == null) {
        parsed.overlaySize = parsed.arrowMaxWidth;
      }
      if (parsed.arrowMaxOpacity != null && parsed.overlayOpacity == null) {
        parsed.overlayOpacity = parsed.arrowMaxOpacity;
      }
      return { ...DEFAULT_PREFS, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(partial: Partial<Prefs>): void {
  try {
    const current = loadPrefs();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...current, ...partial }));
  } catch { /* ignore */ }
}
