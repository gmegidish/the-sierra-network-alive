// Three-plane (visual / priority / control) drawing surface for vector pictures.
// Reference: ScummVM engines/sci/graphics/screen.cpp (putPixel, drawLine,
// getDrawingMask, vectorIsFillMatch) and picture.cpp (vectorFloodFill).

export const MASK_VISUAL = 1;
export const MASK_PRIORITY = 2;
export const MASK_CONTROL = 4;
export const NO_DRAW = 255;
export const WHITE = 255;

/** Create a cleared surface: visual white, priority 0, control 0. */
export function createPicCanvas(width, height) {
  return {
    width,
    height,
    visual: new Uint8Array(width * height).fill(WHITE),
    priority: new Uint8Array(width * height),
    control: new Uint8Array(width * height),
  };
}

export function drawingMask(color, priority, control) {
  return (color !== NO_DRAW ? MASK_VISUAL : 0)
    | (priority !== NO_DRAW ? MASK_PRIORITY : 0)
    | (control !== NO_DRAW ? MASK_CONTROL : 0);
}

export function putPixel(canvas, x, y, mask, color, priority, control) {
  const offset = y * canvas.width + x;
  if (mask & MASK_VISUAL) {
    canvas.visual[offset] = color;
  }
  if (mask & MASK_PRIORITY) {
    canvas.priority[offset] = priority;
  }
  if (mask & MASK_CONTROL) {
    canvas.control[offset] = control;
  }
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/** Sierra's Bresenham line (screen.cpp GfxScreen::drawLine). */
export function drawLine(canvas, x0, y0, x1, y1, color, priority, control) {
  let left = clamp(x0, 0, canvas.width - 1);
  let top = clamp(y0, 0, canvas.height - 1);
  const right = clamp(x1, 0, canvas.width - 1);
  const bottom = clamp(y1, 0, canvas.height - 1);
  const mask = drawingMask(color, priority, control);
  const plot = (x, y) => putPixel(canvas, x, y, mask, color, priority, control);
  if (top === bottom) {
    for (let x = Math.min(left, right); x <= Math.max(left, right); x++) {
      plot(x, top);
    }
    return;
  }
  if (left === right) {
    for (let y = Math.min(top, bottom); y <= Math.max(top, bottom); y++) {
      plot(left, y);
    }
    return;
  }
  const stepY = bottom - top < 0 ? -1 : 1;
  const stepX = right - left < 0 ? -1 : 1;
  const dy = Math.abs(bottom - top) << 1;
  const dx = Math.abs(right - left) << 1;
  plot(left, top);
  plot(right, bottom);
  if (dx > dy) {
    let fraction = dy - (dx >> 1);
    while (left !== right) {
      if (fraction >= 0) {
        top += stepY;
        fraction -= dx;
      }
      left += stepX;
      fraction += dy;
      plot(left, top);
    }
    return;
  }
  let fraction = dx - (dy >> 1);
  while (top !== bottom) {
    if (fraction >= 0) {
      left += stepX;
      fraction -= dy;
    }
    top += stepY;
    fraction += dx;
    plot(left, top);
  }
}

function isFillMatch(canvas, x, y, matchMask, search) {
  const offset = y * canvas.width + x;
  if (matchMask === MASK_VISUAL) {
    return canvas.visual[offset] === search.color;
  }
  if (matchMask === MASK_PRIORITY) {
    return canvas.priority[offset] === search.priority;
  }
  return canvas.control[offset] === search.control;
}

function fillTargetMask(canvas, offset, color, priority, control) {
  let mask = drawingMask(color, priority, control);
  const search = {
    color: canvas.visual[offset],
    priority: canvas.priority[offset],
    control: canvas.control[offset],
  };
  // Abort rules taken from Sierra's interpreter (see picture.cpp).
  if (mask & MASK_VISUAL) {
    if (color === WHITE || search.color !== WHITE) {
      return null;
    }
  } else if (mask & MASK_PRIORITY) {
    if (priority === 0 || search.priority !== 0) {
      return null;
    }
  } else if (mask & MASK_CONTROL) {
    if (control === 0 || search.control !== 0) {
      return null;
    }
  }
  if ((mask & MASK_VISUAL) && search.color === color) {
    mask &= ~MASK_VISUAL;
  }
  if ((mask & MASK_PRIORITY) && search.priority === priority) {
    mask &= ~MASK_PRIORITY;
  }
  if ((mask & MASK_CONTROL) && search.control === control) {
    mask &= ~MASK_CONTROL;
  }
  return mask ? { mask, search } : null;
}

function firstPlane(mask) {
  if (mask & MASK_VISUAL) {
    return MASK_VISUAL;
  }
  return mask & MASK_PRIORITY ? MASK_PRIORITY : MASK_CONTROL;
}

/** Scanline flood fill (picture.cpp GfxPicture::vectorFloodFill). */
export function floodFill(canvas, x, y, color, priority, control) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
    return;
  }
  const target = fillTargetMask(canvas, y * canvas.width + x, color, priority, control);
  if (!target) {
    return;
  }
  const { mask, search } = target;
  const matchMask = firstPlane(mask);
  const matches = (px, py) => isFillMatch(canvas, px, py, matchMask, search);
  const fill = (px, py) => putPixel(canvas, px, py, mask, color, priority, control);
  const right = canvas.width - 1;
  const bottom = canvas.height - 1;
  const stack = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (!matches(px, py)) {
      continue;
    }
    fill(px, py);
    let toLeft = px;
    let toRight = px;
    while (toLeft > 0 && matches(toLeft - 1, py)) {
      fill(--toLeft, py);
    }
    while (toRight < right && matches(toRight + 1, py)) {
      fill(++toRight, py);
    }
    let aboveSet = false;
    let belowSet = false;
    for (let cx = toLeft; cx <= toRight; cx++) {
      const above = py > 0 && matches(cx, py - 1);
      if (above && !aboveSet) {
        stack.push([cx, py - 1]);
      }
      aboveSet = above;
      const below = py < bottom && matches(cx, py + 1);
      if (below && !belowSet) {
        stack.push([cx, py + 1]);
      }
      belowSet = below;
    }
  }
}
