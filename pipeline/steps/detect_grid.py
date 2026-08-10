"""Step: attempt automatic 3x3 grid detection from page-1 brightness profiles."""
import json
from dataclasses import asdict, dataclass

import numpy as np
from PIL import ImageDraw

from .. import config
from ..pdf_utils import get_logger, open_pdf, render_page

log = get_logger(__name__)


class GridDetectionError(RuntimeError):
    """Raised when page 1 doesn't segment cleanly into a GRID_ROWSxGRID_COLS grid."""


@dataclass
class GridResult:
    zoom: float
    img_w: int
    img_h: int
    cols: list
    rows: list


def _find_segments(profile: np.ndarray, total: int, min_gap: int = config.GUTTER_MIN_GAP_PX) -> list:
    """Return (start, end) ranges of non-bright (card content) regions."""
    bright = profile > config.GUTTER_BRIGHTNESS
    segments = []
    in_card = False
    start = 0
    for i, b in enumerate(bright):
        if not in_card and not b:
            in_card, start = True, i
        elif in_card and b:
            if i - start > min_gap:
                segments.append((int(start), int(i - 1)))
            in_card = False
    if in_card and total - start > min_gap:
        segments.append((int(start), int(total - 1)))
    return segments


def detect_grid(zoom: float = config.DEFAULT_ZOOM, save_debug: bool = True) -> GridResult:
    doc = open_pdf(config.CARDS_PDF)
    try:
        img = render_page(doc[0], zoom)
    finally:
        doc.close()

    arr = np.array(img.convert("L"))
    h, w = arr.shape
    col_segs = _find_segments(arr.mean(axis=0), w)
    row_segs = _find_segments(arr.mean(axis=1), h)

    config.DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    if len(col_segs) != config.GRID_COLS or len(row_segs) != config.GRID_ROWS:
        np.save(config.DEBUG_OUTPUT_DIR / "col_profile.npy", arr.mean(axis=0))
        np.save(config.DEBUG_OUTPUT_DIR / "row_profile.npy", arr.mean(axis=1))
        raise GridDetectionError(
            f"Expected {config.GRID_COLS}x{config.GRID_ROWS} grid, got "
            f"{len(col_segs)} cols x {len(row_segs)} rows. Profiles saved to "
            f"{config.DEBUG_OUTPUT_DIR} — inspect with the 'gutters' step."
        )

    result = GridResult(zoom=zoom, img_w=w, img_h=h, cols=col_segs, rows=row_segs)

    for i, (s, e) in enumerate(col_segs):
        log.info("col %d: x=%d..%d (w=%d px, %.1f pt)", i, s, e, e - s, (e - s) / zoom)
    for i, (s, e) in enumerate(row_segs):
        log.info("row %d: y=%d..%d (h=%d px, %.1f pt)", i, s, e, e - s, (e - s) / zoom)

    if save_debug:
        config.GRID_COORDS_FILE.write_text(json.dumps(asdict(result), indent=2), encoding="utf-8")
        log.info("Grid detected. Coordinates saved to %s", config.GRID_COORDS_FILE)

        debug_img = img.copy().convert("RGB")
        draw = ImageDraw.Draw(debug_img)
        for x0, x1 in col_segs:
            draw.line([(x0, 0), (x0, h)], fill=(255, 0, 0), width=3)
            draw.line([(x1, 0), (x1, h)], fill=(255, 0, 0), width=3)
        for y0, y1 in row_segs:
            draw.line([(0, y0), (w, y0)], fill=(0, 255, 0), width=3)
            draw.line([(0, y1), (w, y1)], fill=(0, 255, 0), width=3)
        debug_path = config.DEBUG_OUTPUT_DIR / "debug_detected_grid.png"
        debug_img.save(debug_path)
        log.info("Debug overlay saved to %s (red=col cuts, green=row cuts)", debug_path)

    return result
