#!/usr/bin/env python3
"""Generates the procedural textures and model (geometry) files for the Morph add-on.

Run from the repo root:  python3 tools/generate_assets.py
Outputs are written straight into packs/MorphRP and packs/MorphBP.
"""
import json
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RP = os.path.join(ROOT, "packs", "MorphRP")
BP = os.path.join(ROOT, "packs", "MorphBP")


def out(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


# ---------------------------------------------------------------------------
# Shapeshifter (the "no-body" base form) texture, 64x64
# ---------------------------------------------------------------------------
def shapeshifter_texture():
    rnd = random.Random(1337)
    W = H = 64
    img = Image.new("RGBA", (W, H))
    px = img.load()
    dark = (10, 5, 18, 255)
    mid = (36, 16, 58, 255)
    # smooth value noise
    grid = [[rnd.random() for _ in range(9)] for _ in range(9)]

    def noise(x, y):
        gx, gy = x / 8.0, y / 8.0
        x0, y0 = int(gx), int(gy)
        fx, fy = gx - x0, gy - y0
        fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        a = grid[y0][x0] * (1 - fx) + grid[y0][x0 + 1] * fx
        b = grid[y0 + 1][x0] * (1 - fx) + grid[y0 + 1][x0 + 1] * fx
        return a * (1 - fy) + b * fy

    for y in range(H):
        for x in range(W):
            n = noise(x, y) * 0.8 + rnd.random() * 0.2
            px[x, y] = lerp(dark, mid, n)

    # glowing veins (random walks)
    vein = (123, 47, 208, 255)
    core = (199, 125, 255, 255)
    for _ in range(26):
        x, y = rnd.randrange(W), rnd.randrange(16, H)
        for _ in range(rnd.randrange(6, 16)):
            if 0 <= x < W and 0 <= y < H:
                px[x, y] = core if rnd.random() < 0.35 else vein
            x += rnd.choice((-1, 0, 1))
            y += rnd.choice((-1, 1, 1))

    # head (uv 0,0 box 8x8x8): keep it a smooth void, faceless
    for y in range(0, 16):
        for x in range(0, 32):
            n = noise(x, y)
            px[x, y] = lerp((6, 3, 12, 255), (26, 11, 42, 255), n)
    # two faint glowing eye slits on the front face (x 8..15, y 8..15)
    for (ex, ey) in ((9, 11), (10, 11), (13, 11), (14, 11)):
        px[ex, ey] = (236, 200, 255, 255)
    for (ex, ey) in ((9, 12), (10, 12), (13, 12), (14, 12)):
        px[ex, ey] = (150, 70, 230, 255)
    # floating shard cubes (uv 56,0  1x1x1)
    for y in range(0, 4):
        for x in range(56, 64):
            px[x, y] = core if (x + y) % 2 else (240, 190, 255, 255)
    img.save(out(os.path.join(RP, "textures", "entity", "morph", "shapeshifter.png")))


# ---------------------------------------------------------------------------
# Morph Core item icon, 16x16
# ---------------------------------------------------------------------------
def morph_core_icon():
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    px = img.load()
    cx, cy = 7.5, 7.5
    for y in range(16):
        for x in range(16):
            d = math.hypot(x - cx, y - cy)
            if d <= 6.6:
                ang = math.atan2(y - cy, x - cx)
                swirl = (math.sin(ang * 3 + d * 1.3) + 1) / 2
                t = d / 6.6
                base = lerp((240, 200, 255, 255), (70, 20, 120, 255), t)
                col = lerp(base, (160, 60, 240, 255), swirl * 0.55)
                px[x, y] = col
            elif d <= 7.4:
                px[x, y] = (30, 8, 50, 255)
    px[5, 5] = px[6, 5] = px[5, 6] = (255, 255, 255, 255)
    img.save(out(os.path.join(RP, "textures", "items", "morph_core.png")))


def flake_particle():
    img = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([(4, 0), (8, 4), (4, 8), (0, 4)], fill=(255, 255, 255, 255))
    img.save(out(os.path.join(RP, "textures", "particle", "morph_flake.png")))


def pack_icon(path, hue_shift):
    S = 128
    img = Image.new("RGBA", (S, S), (12, 6, 20, 255))
    d = ImageDraw.Draw(img)
    for r in range(64, 0, -2):
        t = r / 64
        d.ellipse([64 - r, 64 - r, 64 + r, 64 + r], fill=lerp((200, 120, 255, 255), (20, 8, 34, 255), t))
    # faceless silhouette
    d.ellipse([46, 20, 82, 56], fill=(8, 4, 14, 255))
    d.rounded_rectangle([42, 58, 86, 112], 10, fill=(8, 4, 14, 255))
    d.rectangle([54, 36, 59, 39], fill=(240, 210, 255, 255))
    d.rectangle([69, 36, 74, 39], fill=(240, 210, 255, 255))
    if hue_shift:
        d.polygon([(64, 66), (78, 84), (64, 102), (50, 84)], fill=(190, 90, 255, 255))
    img = img.filter(ImageFilter.SMOOTH)
    img.save(out(path))


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def cube(origin, size, uv, inflate=None, mirror=None):
    c = {"origin": origin, "size": size, "uv": uv}
    if inflate:
        c["inflate"] = inflate
    if mirror:
        c["mirror"] = True
    return c


def bone(name, pivot, parent=None, cubes=None, rotation=None, mirror=None):
    b = {"name": name, "pivot": pivot}
    if parent:
        b["parent"] = parent
    if rotation:
        b["rotation"] = rotation
    if mirror:
        b["mirror"] = True
    if cubes:
        b["cubes"] = cubes
    return b


def geo(identifier, tw, th, bones, vb=(2, 3, (0, 1.5, 0))):
    return {
        "description": {
            "identifier": identifier,
            "texture_width": tw,
            "texture_height": th,
            "visible_bounds_width": vb[0],
            "visible_bounds_height": vb[1],
            "visible_bounds_offset": list(vb[2]),
        },
        "bones": bones,
    }


def humanoid_core(extra_body=None):
    return [bone("root", [0, 0, 0]), bone("waist", [0, 12, 0], "root")]


def third_person_geos():
    g = []
    # --- Shapeshifter: slender, faceless, elongated limbs + orbiting shards
    g.append(geo("geometry.morph.shapeshifter", 64, 64, humanoid_core() + [
        bone("body", [0, 24, 0], "waist", [cube([-3.5, 12, -1.5], [7, 12, 3], [16, 16])]),
        bone("head", [0, 24, 0], "body", [cube([-4, 24, -4], [8, 8, 8], [0, 0])]),
        bone("rightArm", [-5, 22, 0], "body", [cube([-6.5, 8, -1.5], [3, 15, 3], [40, 16])]),
        bone("rightItem", [-5, 9, 1], "rightArm"),
        bone("leftArm", [5, 22, 0], "body", [cube([3.5, 8, -1.5], [3, 15, 3], [16, 34])]),
        bone("leftItem", [5, 9, 1], "leftArm"),
        bone("rightLeg", [-1.9, 12, 0], "root", [cube([-3.4, 0, -1.5], [3, 12, 3], [0, 16])]),
        bone("leftLeg", [1.9, 12, 0], "root", [cube([0.4, 0, -1.5], [3, 12, 3], [32, 34])]),
        bone("aura", [0, 18, 0], "root", [
            cube([7, 22, -0.5], [1, 1, 1], [56, 0]),
            cube([-8, 16, 3], [1, 1, 1], [56, 0]),
            cube([2, 10, -7], [1, 1, 1], [56, 0]),
            cube([-3, 27, 6], [1, 1, 1], [56, 0]),
        ]),
    ]))
    return g


def first_person_geos():
    """One small geometry per form that only contains the right arm (+ left arm for maps),
    positioned exactly like the player's arm so vanilla first-person animations line up."""
    def fp(identifier, tw, th, right_cubes, left_cubes=None, right_children=()):
        bones = [bone("root", [0, 0, 0]), bone("waist", [0, 12, 0], "root"),
                 bone("body", [0, 24, 0], "waist"),
                 bone("rightArm", [-5, 22, 0], "body", right_cubes),
                 bone("rightItem", [-6, 15, 1], "rightArm")]
        bones += list(right_children)
        if left_cubes:
            bones += [bone("leftArm", [5, 22, 0], "body", left_cubes),
                      bone("leftItem", [6, 15, 1], "leftArm")]
        return geo(identifier, tw, th, bones)

    return [
        fp("geometry.morph.fp.shapeshifter", 64, 64, [cube([-7, 9, -1.5], [3, 15, 3], [40, 16])]),
    ]


def write_geometry():
    for name, geos in (("morph_forms.geo.json", third_person_geos()),
                       ("morph_first_person.geo.json", first_person_geos())):
        data = {"format_version": "1.12.0", "minecraft:geometry": geos}
        with open(out(os.path.join(RP, "models", "entity", name)), "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    shapeshifter_texture()
    morph_core_icon()
    flake_particle()
    pack_icon(os.path.join(RP, "pack_icon.png"), False)
    pack_icon(os.path.join(BP, "pack_icon.png"), True)
    write_geometry()
    print("assets generated")
