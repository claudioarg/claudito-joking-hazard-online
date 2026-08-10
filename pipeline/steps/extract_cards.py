"""Step: crop cards from every page of the PDF using the calibrated grid and
(re)build the cards.json registry consumed by server/server.js.

This is the only step that writes to server/public/{cards,data} — everything
else in this package only writes to pipeline/debug_output/.
"""
import json
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image

from .. import config
from ..pdf_utils import get_logger, open_pdf, render_page

log = get_logger(__name__)


@dataclass
class GridBox:
    x0: int
    y0: int
    x1: int
    y1: int

    @classmethod
    def default(cls) -> "GridBox":
        return cls(config.GRID_X0, config.GRID_Y0, config.GRID_X1, config.GRID_Y1)

    @property
    def cell_w(self) -> float:
        return (self.x1 - self.x0) / config.GRID_COLS

    @property
    def cell_h(self) -> float:
        return (self.y1 - self.y0) / config.GRID_ROWS


def _is_red_card(cell_rgb: np.ndarray) -> bool:
    border_px = max(config.RED_BORDER_MIN_PX, int(min(cell_rgb.shape[:2]) * config.RED_BORDER_FRACTION))
    edges = np.concatenate([
        cell_rgb[:border_px, :].reshape(-1, 3),
        cell_rgb[-border_px:, :].reshape(-1, 3),
        cell_rgb[:, :border_px].reshape(-1, 3),
        cell_rgb[:, -border_px:].reshape(-1, 3),
    ])
    return (
        float(edges[:, 0].mean()) > config.RED_R_MIN and
        float(edges[:, 1].mean()) < config.RED_GB_MAX and
        float(edges[:, 2].mean()) < config.RED_GB_MAX
    )


def extract_cards(grid: Optional[GridBox] = None, zoom: float = config.DEFAULT_ZOOM) -> list:
    """Crop every card, save PNGs + cards.json, and return the registry list."""
    grid = grid or GridBox.default()

    config.CARDS_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    config.DATA_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    doc = open_pdf(config.CARDS_PDF)
    registry = []
    card_index = 0
    try:
        total_pages = len(doc)
        log.info("Processing %d pages...", total_pages)
        log.info("Grid: (%d,%d) -> (%d,%d)  cell=%.1fx%.1f",
                  grid.x0, grid.y0, grid.x1, grid.y1, grid.cell_w, grid.cell_h)

        for page_num in range(total_pages):
            img = render_page(doc[page_num], zoom)
            cells_saved = 0
            for row in range(config.GRID_ROWS):
                for col in range(config.GRID_COLS):
                    x0 = int(grid.x0 + col * grid.cell_w)
                    y0 = int(grid.y0 + row * grid.cell_h)
                    x1 = int(grid.x0 + (col + 1) * grid.cell_w)
                    y1 = int(grid.y0 + (row + 1) * grid.cell_h)
                    card_img = img.crop((x0, y0, x1, y1))

                    gray = np.array(card_img.convert("L"))
                    if gray.std() < config.BLANK_CELL_STD_THRESHOLD:
                        continue

                    card_index += 1
                    filename = f"card_{card_index:04d}.png"
                    card_img.save(config.CARDS_OUTPUT_DIR / filename, "PNG", optimize=True)

                    is_red = _is_red_card(np.array(card_img))
                    registry.append({
                        "id": card_index,
                        "filename": filename,
                        "page": page_num + 1,
                        "row": row + 1,
                        "col": col + 1,
                        "is_red": is_red,
                    })
                    cells_saved += 1

            log.info("Page %d/%d: %d cards (total: %d)", page_num + 1, total_pages, cells_saved, card_index)
    finally:
        doc.close()

    config.CARDS_REGISTRY_FILE.write_text(json.dumps(registry, indent=2), encoding="utf-8")

    red_count = sum(1 for c in registry if c["is_red"])
    log.info("Done! %d cards extracted to %s", card_index, config.CARDS_OUTPUT_DIR)
    log.info("  Normal cards: %d", card_index - red_count)
    log.info("  Red cards:    %d", red_count)
    log.info("Registry: %s", config.CARDS_REGISTRY_FILE)

    return registry
