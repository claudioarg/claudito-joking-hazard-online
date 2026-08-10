"""Step: inspect PDF dimensions and dump the rules text.

Read-only diagnostics — safe to re-run anytime.
"""
from pathlib import Path

from .. import config
from ..pdf_utils import get_logger, open_pdf

log = get_logger(__name__)


def inspect_cards_pdf() -> None:
    doc = open_pdf(config.CARDS_PDF)
    try:
        log.info("Total pages: %d", len(doc))
        for i, page in enumerate(doc):
            rect = page.rect
            log.info(
                "Page %d: %.1f x %.1f pts (%.1f x %.1f cm)",
                i + 1, rect.width, rect.height,
                rect.width / 72 * 2.54, rect.height / 72 * 2.54,
            )
            if i >= 4:
                log.info("... (showing first 5 pages only)")
                break
    finally:
        doc.close()


def extract_rules_text() -> Path:
    doc = open_pdf(config.RULES_PDF)
    try:
        chunks = [f"\n--- PAGE {i + 1} ---\n{page.get_text()}" for i, page in enumerate(doc)]
        text = "".join(chunks)
    finally:
        doc.close()

    config.DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    config.RULES_TEXT_FILE.write_text(text, encoding="utf-8")
    log.info("Rules text saved to %s (%d chars)", config.RULES_TEXT_FILE, len(text))
    return config.RULES_TEXT_FILE
