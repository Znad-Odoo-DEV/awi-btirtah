"""
process-faces.py — asset pipeline for عوي ولاااك

For every source photo in ./pic:
  1. remove the background (rembg, isnet-general-use + alpha matting)
  2. detect the face (OpenCV Haar cascade, largest face wins)
  3. build a feathered "head only" mask (hair + face + a bit of neck, no shoulders)
  4. crop to a centered square canvas with transparent background
  5. export WebP + PNG at 512px and 256px into ./assets/faces/<slug>-<size>.<ext>

Also writes ./assets/faces/meta.json with a suggested jaw line (0..1 of the
output height) per face, and ./scripts/out/preview.png (cutouts on a checkerboard)
for eyeballing edge quality.

Usage:  py -3.11 scripts/process-faces.py
Deps:   pip install "rembg[cpu]" opencv-python-headless pillow numpy
"""

import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter
from rembg import new_session, remove

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "pic"
OUT = ROOT / "assets" / "faces"
PREVIEW = ROOT / "scripts" / "out"

# Arabic file name -> ASCII slug. Display names live in src/config.js.
FACES = {
    "بشار الاسد.jpg": "bashar",
    "ماهر الاسد.jpg": "maher",
    "2.jpg": "nasrallah",
    "1.jpg": "samir",
    "3.jpg": "ghazwan",
}

# Optional per-face tweaks (all in units of the detected face height `h`).
#   top:   how far above the face box the crop starts (hair)
#   chin:  where the chin sits below the face box top
#   neck:  how much neck to keep below the chin
#   width: head ellipse half-width relative to face box width
TUNING = {
    "default": {"top": 0.6, "chin": 1.05, "neck": 0.14, "width": 0.66},
    "bashar": {},
    "maher": {},
    # turban on top, long beard below → taller crop
    "nasrallah": {"top": 0.95, "chin": 1.36, "neck": 0.0, "width": 0.6},
    "samir": {"chin": 1.0, "neck": 0.08, "recenter": True},
    # beanie on top, full beard below
    "ghazwan": {"top": 0.62, "chin": 1.2, "neck": 0.08, "width": 0.53, "keep_top": True, "hat_w": 0.44},
}

SIZES = (512, 256)


def detect_face(rgb: np.ndarray):
    """Return (x, y, w, h) of the largest frontal face."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gray = cv2.equalizeHist(gray)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=6, minSize=(60, 60))
    if len(faces) == 0:
        raise RuntimeError("no face found")
    return max(faces, key=lambda f: f[2] * f[3])


def head_mask(shape, face, t):
    """Soft mask: ellipse over hair+face, a narrow neck column, faded at the bottom."""
    H, W = shape
    x, y, w, h = face
    cx = x + w / 2
    top = y - t["top"] * h
    chin = y + t["chin"] * h
    neck_end = chin + t["neck"] * h

    mask = np.zeros((H, W), np.float32)
    # Head ellipse spans from the top of the hair to the chin.
    cy = (top + chin) / 2
    ry = (chin - top) / 2
    rx = t["width"] * w
    cv2.ellipse(mask, (int(cx), int(cy)), (int(rx), int(ry)), 0, 0, 360, 1.0, -1)
    # Neck column, a bit narrower than the jaw.
    nw = 0.24 * w
    cv2.rectangle(mask, (int(cx - nw), int(cy)), (int(cx + nw), int(neck_end)), 1.0, -1)

    # Feather edges of the mask, then fade the neck out towards the bottom.
    k = max(3, int(w * 0.06)) | 1
    mask = cv2.GaussianBlur(mask, (k, k), 0)
    fade_start = chin + 0.02 * h
    ys = np.arange(H, dtype=np.float32)[:, None]
    fade = np.clip(1 - (ys - fade_start) / max(1.0, neck_end - fade_start), 0, 1)
    return mask * fade, (cx, top, neck_end, chin)


def process(path: Path, slug: str, session):
    src = Image.open(path).convert("RGB")
    rgb = np.array(src)
    face = detect_face(rgb)
    t = {**TUNING["default"], **TUNING.get(slug, {})}

    cut = remove(
        src,
        session=session,
        alpha_matting=True,
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=12,
        alpha_matting_erode_size=8,
    )
    cut = np.array(cut.convert("RGBA")).astype(np.float32)

    mask, (cx, top, bottom, chin) = head_mask(rgb.shape[:2], face, t)
    alpha = cut[..., 3] / 255.0
    # Refinement 1: erode the matte ~1px to drop the light halo picked up from walls.
    alpha = cv2.erode(alpha, np.ones((3, 3), np.uint8), iterations=1)
    if t.get("keep_top"):
        # Dark hat on a dark background: the matte drops it, so trust our own
        # head ellipse above the eyebrows instead.
        brow = int(face[1] + 0.38 * face[3])  # eye level: dome base ≈ face width here
        dome = np.zeros(alpha.shape, np.float32)
        hx, hy, hw, hh = face
        ry = int(brow - max(4, hy - t["top"] * hh))  # keep the dome inside the photo
        cv2.ellipse(dome, (int(hx + hw / 2), brow), (int(t["hat_w"] * hw), ry), 0, 180, 360, 1.0, -1)
        dome = cv2.GaussianBlur(dome, (9, 9), 0)
        hat = (dome[:brow] > 0.5) & (alpha[:brow] < 0.5)
        alpha[:brow][hat] = 1.0
        cut[:brow, :, :3][hat] = rgb[:brow][hat]  # real pixels, not the matte's guess
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0) * mask
    alpha[alpha < 0.06] = 0
    # Refinement 1b: keep only the biggest blob (drops stray bits of background).
    n, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 0.3).astype(np.uint8))
    if n > 2:
        biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        keep = cv2.dilate((labels == biggest).astype(np.uint8), np.ones((5, 5), np.uint8))
        alpha *= keep
    if t.get("recenter"):
        # Tilted heads: centre on the cut-out's own mass, not the face box.
        cx = float((alpha.sum(0) * np.arange(alpha.shape[1])).sum() / max(alpha.sum(), 1))
    # Refinement 2: colour decontamination — edge pixels take the colour of the
    # nearby solid interior (premultiplied blur), so no background tint bleeds in.
    solid = (alpha > 0.9).astype(np.float32)
    k = max(5, int(face[2] * 0.08)) | 1
    num = cv2.GaussianBlur(cut[..., :3] * solid[..., None], (k, k), 0)
    den = cv2.GaussianBlur(solid, (k, k), 0)[..., None]
    bled = np.where(den > 1e-3, num / np.maximum(den, 1e-3), cut[..., :3])
    edge = ((alpha > 0) & (alpha < 0.9))[..., None]
    cut[..., :3] = np.where(edge, bled, cut[..., :3])
    cut[..., 3] = alpha * 255

    # Square crop centred on the head, with a little padding.
    side = (bottom - top) * 1.02
    x0 = int(round(cx - side / 2))
    y0 = int(round(top - side * 0.02))
    s = int(round(side))
    canvas = np.zeros((s, s, 4), np.float32)
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(rgb.shape[1], x0 + s), min(rgb.shape[0], y0 + s)
    canvas[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0] = cut[sy0:sy1, sx0:sx1]
    # Premultiply-safe: zero colour where fully transparent (smaller files, no fringes).
    canvas[canvas[..., 3] == 0, :3] = 0
    img = Image.fromarray(canvas.clip(0, 255).astype(np.uint8), "RGBA")

    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        r = img.resize((size, size), Image.LANCZOS)
        if size == 512:
            r = r.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
        r.save(OUT / f"{slug}-{size}.webp", "WEBP", quality=86, method=6)
        r.save(OUT / f"{slug}-{size}.png", "PNG", optimize=True)

    # Jaw line guess: mouth sits ~78% down the Haar face box.
    x, y, w, h = face
    jaw = (y + 0.80 * h - y0) / s
    return img, {"jawY": round(float(jaw), 3), "chinY": round(float((chin - y0) / s), 3)}


def checker(size, cell=16):
    a = (np.indices((size, size)) // cell).sum(axis=0) % 2
    c = np.where(a[..., None] == 1, 200, 150).astype(np.uint8)
    return Image.fromarray(np.repeat(c, 3, axis=2), "RGB")


def main():
    session = new_session("isnet-general-use")
    meta, previews = {}, []
    for name, slug in FACES.items():
        img, info = process(SRC / name, slug, session)
        meta[slug] = info
        big = img.resize((512, 512), Image.LANCZOS)
        # Top: checkerboard (shows alpha). Bottom: the site's charcoal background.
        tile = Image.new("RGB", (512, 1024), (28, 27, 30))
        tile.paste(checker(512), (0, 0))
        tile.paste(big, (0, 0), big)
        tile.paste(big, (0, 512), big)
        previews.append(tile)
        print(f"{slug}: {info}")

    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
    PREVIEW.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGB", (512 * len(previews), 1024))
    for i, p in enumerate(previews):
        sheet.paste(p, (512 * i, 0))
    sheet.save(PREVIEW / "preview.png")
    print("preview ->", PREVIEW / "preview.png")


if __name__ == "__main__":
    main()
