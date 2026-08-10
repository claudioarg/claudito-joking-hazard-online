"""Central configuration for the card-extraction pipeline.

All paths are resolved relative to this file, so every script works
regardless of the current working directory it's launched from.
"""
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

CARDS_PDF = PROJECT_ROOT / "PnP Español A4.pdf"
RULES_PDF = PROJECT_ROOT / "reglas español.pdf"

SERVER_PUBLIC_DIR = PROJECT_ROOT / "server" / "public"
CARDS_OUTPUT_DIR = SERVER_PUBLIC_DIR / "cards"
DATA_OUTPUT_DIR = SERVER_PUBLIC_DIR / "data"
CARDS_REGISTRY_FILE = DATA_OUTPUT_DIR / "cards.json"

# Scratch space for anything that isn't a final build artifact (reference
# images, brightness profiles, debug overlays). Safe to delete anytime.
DEBUG_OUTPUT_DIR = PROJECT_ROOT / "pipeline" / "debug_output"
RULES_TEXT_FILE = DEBUG_OUTPUT_DIR / "reglas_extraidas.txt"
GRID_COORDS_FILE = DEBUG_OUTPUT_DIR / "grid_coords.json"

DEFAULT_ZOOM = 3.0
GRID_ROWS = 3
GRID_COLS = 3

# Manually-calibrated grid boundaries (at DEFAULT_ZOOM) used by the `extract`
# step. Re-calibrate with marcar_cartas.html + `detect-grid`/`layout-debug`
# if the source PDF's layout ever changes.
GRID_X0 = 84
GRID_Y0 = 131
GRID_X1 = 1700
GRID_Y1 = 2391

# A cropped cell is treated as blank/empty if its grayscale std-dev is below this.
BLANK_CELL_STD_THRESHOLD = 8.0

# Red-card detection: mean RGB of a border strip of this fraction of the
# cell's shortest side (clamped to a minimum pixel width).
RED_BORDER_FRACTION = 0.03
RED_BORDER_MIN_PX = 6
RED_R_MIN = 140
RED_GB_MAX = 100

# White-gutter detection used by the `detect-grid` / `gutters` diagnostics.
GUTTER_BRIGHTNESS = 220
GUTTER_MIN_GAP_PX = 40
