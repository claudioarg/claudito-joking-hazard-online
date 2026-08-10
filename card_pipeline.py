"""Root convenience entry point.

Run `python card_pipeline.py <command>` from the repo root, e.g.:
    python card_pipeline.py extract
    python card_pipeline.py all -v
"""
from pipeline.cli import main

if __name__ == "__main__":
    main()
