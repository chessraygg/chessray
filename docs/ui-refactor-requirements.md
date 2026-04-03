# UI Refactor Requirements

## Panels
- **User panel**: clean, minimal — eval bar, best moves, arrows controls
- **Debug panel**: separate, collapsible — raw detection data, timing, diagnostics

## "What app sees"
- Live board crop from screen capture (debug panel)
- Detected bbox overlay with grid lines (debug panel)

## "What app understands"
- Virtual board with recognized position (user panel)
- Professional piece graphics (SVG piece set, e.g. cburnett/merida style)
- Highlighted squares (last move) rendered on virtual board

## Notation
- PV lines in standard algebraic notation (Nf3, Bxe5) by default
- Toggle to switch between SAN and UCI notation

## Controls
- Box toggle (bbox outline) → debug panel only
- Overlay on/off → debug panel only
- Arrows / Line / Eval bar toggles → user panel

## Orientation & Status
- Elegant "white plays ↑" / "black plays ↑" indicator (not raw text)
- Turn indicator integrated into eval bar or board frame
- Detection confidence as subtle visual (not raw percentage)
