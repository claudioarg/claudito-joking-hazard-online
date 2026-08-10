"""Command-line entry point for the card-extraction pipeline.

Usage:
    python card_pipeline.py <command> [--zoom Z] [-v]

Commands:
    inspect       Print PDF page dimensions and dump the rules text.
    reference     Render page 1 as a reference image for manual grid calibration.
    layout-debug  Dump content bounding box + per-cell debug crops.
    gutters       Print brightness profiles around expected gutter positions.
    detect-grid   Attempt automatic 3x3 grid detection.
    extract       Crop all cards and (re)build cards.json.
    all           Run inspect -> reference -> detect-grid -> extract.
"""
import argparse
import logging
import sys

from . import config
from .pdf_utils import get_logger
from .steps import detect_grid as detect_grid_step
from .steps import extract_cards as extract_step
from .steps import gutters as gutters_step
from .steps import inspect_pdf as inspect_step
from .steps import layout_debug as layout_debug_step
from .steps import render_reference as reference_step

log = get_logger("pipeline.cli")


def _cmd_inspect(args: argparse.Namespace) -> None:
    inspect_step.inspect_cards_pdf()
    inspect_step.extract_rules_text()


def _cmd_reference(args: argparse.Namespace) -> None:
    reference_step.render_reference(zoom=args.zoom)


def _cmd_layout_debug(args: argparse.Namespace) -> None:
    layout_debug_step.debug_layout(zoom=args.zoom)


def _cmd_gutters(args: argparse.Namespace) -> None:
    gutters_step.diagnose_gutters(zoom=args.zoom)


def _cmd_detect_grid(args: argparse.Namespace) -> None:
    try:
        detect_grid_step.detect_grid(zoom=args.zoom)
    except detect_grid_step.GridDetectionError as exc:
        log.error(str(exc))
        sys.exit(1)


def _cmd_extract(args: argparse.Namespace) -> None:
    extract_step.extract_cards(zoom=args.zoom)


def _cmd_all(args: argparse.Namespace) -> None:
    _cmd_inspect(args)
    _cmd_reference(args)
    try:
        detect_grid_step.detect_grid(zoom=args.zoom)
    except detect_grid_step.GridDetectionError as exc:
        log.warning("%s -- falling back to the manually calibrated GRID_* constants in config.py", exc)
    _cmd_extract(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="card_pipeline", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging.")
    sub = parser.add_subparsers(dest="command", required=True)

    commands = [
        ("inspect", _cmd_inspect, "Print PDF page dimensions and dump the rules text."),
        ("reference", _cmd_reference, "Render page 1 as a reference image for manual calibration."),
        ("layout-debug", _cmd_layout_debug, "Dump content bounding box + per-cell debug crops."),
        ("gutters", _cmd_gutters, "Print brightness profiles around expected gutter positions."),
        ("detect-grid", _cmd_detect_grid, "Attempt automatic 3x3 grid detection."),
        ("extract", _cmd_extract, "Crop all cards and (re)build cards.json."),
        ("all", _cmd_all, "Run inspect -> reference -> detect-grid -> extract."),
    ]
    for name, fn, help_text in commands:
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--zoom", type=float, default=config.DEFAULT_ZOOM,
                        help=f"Rasterization zoom factor (default: {config.DEFAULT_ZOOM}).")
        p.set_defaults(func=fn)

    return parser


def main(argv=None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.verbose:
        logging.getLogger("pipeline").setLevel(logging.DEBUG)
    try:
        args.func(args)
    except FileNotFoundError as exc:
        log.error(str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
