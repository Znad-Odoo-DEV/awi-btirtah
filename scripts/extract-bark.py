"""
extract-bark.py — cut ONE clean bark out of the source recording.

  py -3.11 scripts/extract-bark.py [seconds]   (default: 41.07, the cleanest isolated bark)

Steps: decode → find the exact onset near the given time → cut onset..tail
→ high-pass 180 Hz (removes wind/handling rumble) → short fades → normalize
→ export assets/sfx/bark.mp3 (+ .wav for inspection in scripts/out).
Deps: pip install imageio-ffmpeg numpy scipy
"""

import glob
import subprocess
import sys
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from scipy.signal import butter, sosfiltfilt

ROOT = Path(__file__).resolve().parent.parent
SR = 44100
AT = float(sys.argv[1]) if len(sys.argv) > 1 else 41.07

ff = imageio_ffmpeg.get_ffmpeg_exe()
src = glob.glob(str(ROOT / "pic" / "*.mp3"))[0]
raw = subprocess.run([ff, "-v", "error", "-i", src, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
x = np.frombuffer(raw, np.float32).astype(np.float64)

# High-pass the whole thing first so the rumble doesn't fool onset detection.
x = sosfiltfilt(butter(4, 180, "highpass", fs=SR, output="sos"), x)

# 5 ms envelope around the requested time.
win = x[int((AT - 0.25) * SR) : int((AT + 0.6) * SR)]
hop = SR // 200
env = np.sqrt(np.convolve(win**2, np.ones(hop) / hop, "same"))
peak = env.max()
onset = int(np.argmax(env > peak * 0.12))  # first point above -18 dB of the peak
after = np.where(env[onset:] > peak * 0.06)[0]  # last point above -24 dB
end = onset + int(after[-1]) + int(0.03 * SR)
start = max(0, onset - int(0.008 * SR))
cut = win[start:end].copy()

# fades: 4 ms in, 50 ms out
fi, fo = int(0.004 * SR), int(0.05 * SR)
cut[:fi] *= np.linspace(0, 1, fi)
cut[-fo:] *= np.linspace(1, 0, fo) ** 2
cut *= 0.89 / np.abs(cut).max()  # -1 dB peak

print(f"bark: {start / SR + AT - 0.25:.3f}s → {end / SR + AT - 0.25:.3f}s ({len(cut) / SR * 1000:.0f} ms)")

out_dir = ROOT / "assets" / "sfx"
out_dir.mkdir(parents=True, exist_ok=True)
tmp = ROOT / "scripts" / "out" / "bark.wav"
tmp.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(tmp), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((cut * 32767).astype(np.int16).tobytes())
subprocess.run([ff, "-v", "error", "-y", "-i", str(tmp), "-codec:a", "libmp3lame", "-b:a", "96k", str(out_dir / "bark.mp3")], check=True)
print("→", out_dir / "bark.mp3", (out_dir / "bark.mp3").stat().st_size, "bytes")
