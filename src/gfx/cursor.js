// Mouse cursor overlay. The cursor is a view cel (SetCursor(view, loop, cel))
// drawn over the RGBA output after the framebuffer is converted, never into
// the game's planes, so it leaves no trails and never ends up in save-under
// bits. Hotspot follows SCI1.1 (ScummVM GfxCursor::kernelSetView): the cel's
// origin, i.e. (width/2 - displaceX, height - 1 - displaceY).

/**
 * @typedef {{ view: number, loop: number, cel: number, visible: boolean,
 *   hotspot: { x: number, y: number } | null }} CursorState  hotspot null = the cel's origin
 */

const BYTES_PER_PIXEL = 4;

/** @returns {CursorState} */
export function createCursor() {
  return { view: -1, loop: 0, cel: 0, visible: true, hotspot: null };
}

function hotspotOf(cel) {
  return { x: (cel.width >> 1) - cel.displaceX, y: cel.height - 1 - cel.displaceY };
}

/**
 * Composite the cursor into `rgba` (the screen's toRgba output) at `mouse`.
 * @param {import('./graphics.js').Graphics} graphics
 * @param {CursorState} cursor
 * @param {{ x: number, y: number }} mouse
 * @param {Uint8ClampedArray} rgba
 */
export function drawCursor(graphics, cursor, mouse, rgba) {
  if (!cursor.visible || cursor.view < 0) {
    return;
  }
  const cel = graphics.cel(cursor.view, cursor.loop, cursor.cel);
  if (!cel) {
    return;
  }
  const { screen } = graphics;
  const hotspot = cursor.hotspot ?? hotspotOf(cel);
  const left = mouse.x - hotspot.x;
  const top = mouse.y - hotspot.y;
  const rgb = screen.palette.rgb;
  for (let row = 0; row < cel.height; row++) {
    for (let col = 0; col < cel.width; col++) {
      const color = cel.pixels[row * cel.width + col];
      const x = left + col;
      const y = top + row;
      if (color === cel.clearKey || !screen.inBounds(x, y)) {
        continue;
      }
      const offset = (y * screen.width + x) * BYTES_PER_PIXEL;
      rgba.set(rgb.subarray(color * 3, color * 3 + 3), offset);
    }
  }
}
