#!/usr/bin/env python3
"""Render the Anbot main-mark bitmap frames from the whale cutout PNG.

Pipeline (reproducible):
  1. Read the source RGBA cutout (transparent background).
  2. Crop to its alpha bounding box, so no stray margin biases the fit.
  3. Contain the cutout inside a square frame with a uniform margin (ink
     occupies the central INK_RATIO of the frame); nothing is cropped.
  4. Write lossy-but-sharp WebP frames at the bundled size and a retained
     retina size. The 160px frame is the one bundled by
     `node dev/anbot-assets.mjs`; the 320px frame is kept on disk for future
     2x retina avatars and is not inlined into the client module.

Usage:
  python3 dev/anbot-render-mark.py [source.png]

Pass the cutout path, or set ANBOT_WHALE_SRC. Requires Pillow (`pip install pillow`);
its WebP encoder must be available in the Pillow build.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image

PLUGIN = Path(__file__).resolve().parent.parent
ASSETS = PLUGIN / "assets" / "marks"

# Bundled frame: every displayed mark fits inside this at 2x (largest shown
# size is 60px; 2x = 120px < 160px).
BUNDLED_SIZE = 160
# Retina spare, not bundled yet.
RETINA_SIZE = 320

# Uniform margin around the ink inside the square frame (fraction of frame).
# The CSS slot already uses object-fit:contain; the margin only keeps the
# bucket hat, spout and tail fin clear of the 50% corner rounding.
INK_RATIO = 0.88

# The identity cutout is artwork, not a build input: it lives outside the repository, so
# the path comes from the command line or ANBOT_WHALE_SRC.
DEFAULT_SOURCE = Path(os.environ.get("ANBOT_WHALE_SRC", "anbot-whale.png"))


def render(source: Path, size: int, out: Path) -> None:
    im = Image.open(source).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit(f"source {source} has no opaque pixels")
    im = im.crop(bbox)

    target = round(size * INK_RATIO)
    scale = min(target / im.width, target / im.height)
    new_size = (max(1, round(im.width * scale)), max(1, round(im.height * scale)))
    im = im.resize(new_size, Image.LANCZOS)

    frame = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    frame.paste(im, ((size - new_size[0]) // 2, (size - new_size[1]) // 2), im)
    frame.save(out, "WEBP", quality=90, method=6, exact=True)
    print(f"wrote {out} ({size}px, ink {new_size[0]}x{new_size[1]})")


def main() -> None:
    source = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ANBOT_WHALE_SRC", DEFAULT_SOURCE))
    if not source.exists():
        raise SystemExit(f"source cutout not found: {source}")
    ASSETS.mkdir(parents=True, exist_ok=True)
    render(source, BUNDLED_SIZE, ASSETS / "anbot-160.webp")
    render(source, RETINA_SIZE, ASSETS / "anbot-320.webp")


if __name__ == "__main__":
    main()
