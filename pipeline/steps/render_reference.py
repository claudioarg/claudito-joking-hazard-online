"""Step: render page 1 as a high-res reference image for manual grid calibration
(used together with marcar_cartas.html)."""
from pathlib import Path

from .. import config
from ..pdf_utils import get_logger, open_pdf, render_page

log = get_logger(__name__)


def render_reference(zoom: float = config.DEFAULT_ZOOM) -> Path:
    doc = open_pdf(config.CARDS_PDF)
    try:
        page = doc[0]
        img = render_page(page, zoom)
        page_rect = page.rect
    finally:
        doc.close()

    config.DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = config.DEBUG_OUTPUT_DIR / "page1_reference.png"
    img.save(out_path, "PNG")

    log.info("Page 1 rendered: %dx%d px (zoom %.1fx) -> %s", img.width, img.height, zoom, out_path)
    log.info("Original page: %.1f x %.1f pts", page_rect.width, page_rect.height)
    return out_path
