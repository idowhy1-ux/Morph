#!/usr/bin/env python3
"""Packages packs/ into dist/Morph.mcaddon (tap it on a phone to import into Minecraft)."""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
os.makedirs(DIST, exist_ok=True)
out = os.path.join(DIST, "Morph_v5.mcaddon")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for pack in ("MorphBP", "MorphRP"):
        base = os.path.join(ROOT, "packs", pack)
        for dirpath, _, files in os.walk(base):
            for f in sorted(files):
                full = os.path.join(dirpath, f)
                z.write(full, os.path.join(pack.replace("Morph", "Morph_v5_"), os.path.relpath(full, base)))
print("wrote", out, os.path.getsize(out), "bytes")
