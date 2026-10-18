#!/usr/bin/env python3
"""Checks compute_spectrum with synthetic audio. Needs numpy only. Exit 0 pass, 1 fail, 77 skipped (no numpy)."""
import base64, os, runpy, sys
try:
    import numpy as np
except ImportError:
    print("skip: numpy not installed"); sys.exit(77)
ns = runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "synth.py"), run_name="lib")
cs, RATE, B, FPS = ns["compute_spectrum"], ns["RATE"], ns["SPEC_BANDS"], ns["SPEC_FPS"]
fails = 0
def check(name, cond, extra=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(extra) if extra else ""))
    fails += 0 if cond else 1
def decode(b64, secs): a = np.frombuffer(base64.b64decode(b64), dtype=np.uint8); return a.reshape(-1, B)

t = np.arange(int(3 * RATE)) / RATE
tone = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
a = decode(cs(tone), 3)
check("frame count is seconds x 10", abs(a.shape[0] - 30) <= 1 and a.shape[1] == B, a.shape)
band_hz = np.geomspace(80, 8000, B + 1)
want = int(np.searchsorted(band_hz, 1000) - 1)
peak = int(a[5:25].mean(axis=0).argmax())
check("a 1 kHz tone lights the 1 kHz band", abs(peak - want) <= 1, f"peak band {peak}, expected {want}")
check("a loud tone reaches full scale", a.max() >= 240, a.max())
low = (0.5 * np.sin(2 * np.pi * 150 * t)).astype(np.float32)
hi = (0.5 * np.sin(2 * np.pi * 5000 * t)).astype(np.float32)
pl, ph = int(decode(cs(low), 3)[5:25].mean(axis=0).argmax()), int(decode(cs(hi), 3)[5:25].mean(axis=0).argmax())
check("low tone peaks below the high tone", pl < ph, f"{pl} < {ph}")
sil = decode(cs(np.zeros(int(2 * RATE), dtype=np.float32)), 2)
check("silence stays dark", int(sil.max()) == 0, int(sil.max()))
mix = np.concatenate([np.zeros(RATE, dtype=np.float32), tone[:RATE], np.zeros(RATE, dtype=np.float32)])
m = decode(cs(mix), 3)
check("silence before and after a tone is dark, the tone is lit", m[:8].max() == 0 and m[12:18].max() > 100 and m[24:].max() == 0, (int(m[:8].max()), int(m[12:18].max()), int(m[24:].max())))
sys.exit(1 if fails else 0)
