/**
 * Color helpers for theming the virtual board to match the detected real
 * board colors, with an "analysis mode" brightening effect.
 */

export type RGB = [number, number, number];

const ANALYSIS_BRIGHTNESS = 0.18; // mix toward white by 18% in analysis mode
const HIGHLIGHT_YELLOW: RGB = [247, 247, 105];
const HIGHLIGHT_BLEND = 0.55;

// Sensible defaults used when detection hasn't produced colors yet
const DEFAULT_LIGHT: RGB = [232, 220, 200];
const DEFAULT_DARK: RGB = [181, 136, 99];

export function rgbToCss(rgb: RGB): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** Mix `rgb` toward white by `factor` (0..1). */
export function brighten(rgb: RGB, factor: number): RGB {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * factor),
    Math.round(rgb[1] + (255 - rgb[1]) * factor),
    Math.round(rgb[2] + (255 - rgb[2]) * factor),
  ];
}

/** Mix `rgb` with a fixed yellow highlight tint. */
export function blendYellow(rgb: RGB, factor: number = HIGHLIGHT_BLEND): RGB {
  return [
    Math.round(rgb[0] * (1 - factor) + HIGHLIGHT_YELLOW[0] * factor),
    Math.round(rgb[1] * (1 - factor) + HIGHLIGHT_YELLOW[1] * factor),
    Math.round(rgb[2] * (1 - factor) + HIGHLIGHT_YELLOW[2] * factor),
  ];
}

/** Compute the full 4-color palette (light, dark, light-highlight, dark-highlight)
 * for a board, derived from detected square colors. In analysis mode, the base
 * colors are brightened to signal that the board content is engine-projected. */
export function squareColorPalette(
  detected: { light: RGB; dark: RGB } | null | undefined,
  opts: { analysis?: boolean } = {},
): { light: RGB; dark: RGB; lightHl: RGB; darkHl: RGB } {
  const baseLight = detected?.light ?? DEFAULT_LIGHT;
  const baseDark = detected?.dark ?? DEFAULT_DARK;
  const light = opts.analysis ? brighten(baseLight, ANALYSIS_BRIGHTNESS) : baseLight;
  const dark = opts.analysis ? brighten(baseDark, ANALYSIS_BRIGHTNESS) : baseDark;
  return {
    light, dark,
    lightHl: blendYellow(light),
    darkHl: blendYellow(dark),
  };
}
