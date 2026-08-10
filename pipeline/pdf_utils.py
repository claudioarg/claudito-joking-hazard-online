"""Shared helpers for rendering pages from a PDF with PyMuPDF."""
import io
import logging
import sys
from pathlib import Path

import fitz
from PIL import Image


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


def require_file(path: Path, kind: str = "file") -> Path:
    if not path.exists():
        raise FileNotFoundError(f"{kind} no encontrado: {path}")
    return path


def open_pdf(path: Path) -> fitz.Document:
    require_file(path, "PDF")
    return fitz.open(str(path))


def render_page(page: fitz.Page, zoom: float) -> Image.Image:
    """Rasterize a PyMuPDF page to a PIL Image at the given zoom factor."""
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    return Image.open(io.BytesIO(pix.tobytes("png")))
