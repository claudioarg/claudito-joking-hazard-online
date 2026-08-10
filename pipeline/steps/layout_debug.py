"""Step: analyze the content bounding box of page 1 and dump per-cell debug crops."""
import numpy as np

from .. import config
from ..pdf_utils import get_logger, open_pdf, render_page

log = get_logger(__name__)


def debug_layout(zoom: float = config.DEFAULT_ZOOM) -> None:
    config.DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    doc = open_pdf(config.CARDS_PDF)
    try:
        for page_num in range(min(3, len(doc))):
            img = render_page(doc[page_num], zoom)
            out = config.DEBUG_OUTPUT_DIR / f"debug_page_{page_num + 1}_full.png"
            img.save(out)
            log.info("Page %d size at zoom %.1fx: %s -> %s", page_num + 1, zoom, img.size, out)

        img = render_page(doc[0], zoom)
    finally:
        doc.close()

    gray = np.array(img.convert("L"))
    non_white_rows = np.where(gray.min(axis=1) < 240)[0]
    non_white_cols = np.where(gray.min(axis=0) < 240)[0]

    if not len(non_white_rows) or not len(non_white_cols):
        log.warning("No content detected on page 1 (looks blank)")
        return

    top, bottom = int(non_white_rows[0]), int(non_white_rows[-1])
    left, right = int(non_white_cols[0]), int(non_white_cols[-1])
    log.info("Content bounding box: left=%d top=%d right=%d bottom=%d", left, top, right, bottom)
    log.info("Margins: top=%d bottom=%d left=%d right=%d", top, gray.shape[0] - bottom, left, gray.shape[1] - right)

    content_w, content_h = right - left, bottom - top
    cell_w, cell_h = content_w / config.GRID_COLS, content_h / config.GRID_ROWS
    log.info("Estimated cell size (%dx%d grid): %.1f x %.1f px", config.GRID_ROWS, config.GRID_COLS, cell_w, cell_h)

    cropped = img.crop((left, top, right, bottom))
    cropped_path = config.DEBUG_OUTPUT_DIR / "debug_page_1_cropped.png"
    cropped.save(cropped_path)
    log.info("Saved %s", cropped_path)

    for row in range(config.GRID_ROWS):
        for col in range(config.GRID_COLS):
            x0, y0 = int(col * cell_w), int(row * cell_h)
            x1, y1 = int((col + 1) * cell_w), int((row + 1) * cell_h)
            cell = cropped.crop((x0, y0, x1, y1))
            cell.save(config.DEBUG_OUTPUT_DIR / f"debug_cell_r{row + 1}_c{col + 1}.png")
    log.info("Saved individual debug cells to %s", config.DEBUG_OUTPUT_DIR)
