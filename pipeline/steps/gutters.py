"""Step: print brightness profiles around the expected gutter positions.

Useful when `detect-grid` fails to find a clean 3x3 split and you need to
eyeball where the actual white gutters are.
"""
import numpy as np

from .. import config
from ..pdf_utils import get_logger, open_pdf, render_page

log = get_logger(__name__)


def _report(label: str, avg: np.ndarray, center: int, window: int) -> None:
    lo, hi = max(0, center - window), min(len(avg), center + window)
    log.info("--- %s averages around %d (%d..%d) ---", label, center, lo, hi)
    for i in range(lo, hi):
        marker = " <-- possible gutter" if avg[i] > 248 else ""
        log.info("  %s %4d: avg=%.1f%s", label, i, avg[i], marker)


def diagnose_gutters(zoom: float = 2.5, window: int = 20) -> None:
    doc = open_pdf(config.CARDS_PDF)
    try:
        img = render_page(doc[0], zoom)
    finally:
        doc.close()

    arr = np.array(img.convert("L"))
    h, w = arr.shape
    log.info("Image: %dx%d", w, h)

    row_avg, col_avg = arr.mean(axis=1), arr.mean(axis=0)
    third_h, third_w = h // 3, w // 3

    _report("row", row_avg, third_h, window)
    _report("row", row_avg, 2 * third_h, window)
    _report("col", col_avg, third_w, window)
