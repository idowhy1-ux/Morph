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
    # --- Zombie (vanilla 64x32 humanoid layout)
    g.append(geo("geometry.morph.zombie", 64, 32, humanoid_core() + [
        bone("body", [0, 24, 0], "waist", [cube([-4, 12, -2], [8, 12, 4], [16, 16])]),
        bone("head", [0, 24, 0], "body", [cube([-4, 24, -4], [8, 8, 8], [0, 0])]),
        bone("hat", [0, 24, 0], "head", [cube([-4, 24, -4], [8, 8, 8], [32, 0], 0.5)]),
        bone("rightArm", [-5, 22, 0], "body", [cube([-8, 12, -2], [4, 12, 4], [40, 16])]),
        bone("rightItem", [-6, 15, 1], "rightArm"),
        bone("leftArm", [5, 22, 0], "body", [cube([4, 12, -2], [4, 12, 4], [40, 16])], mirror=True),
        bone("leftItem", [6, 15, 1], "leftArm"),
        bone("rightLeg", [-1.9, 12, 0], "root", [cube([-3.9, 0, -2], [4, 12, 4], [0, 16])]),
        bone("leftLeg", [1.9, 12, 0], "root", [cube([-0.1, 0, -2], [4, 12, 4], [0, 16])], mirror=True),
    ]))
    # --- Skeleton
    g.append(geo("geometry.morph.skeleton", 64, 32, humanoid_core() + [
        bone("body", [0, 24, 0], "waist", [cube([-4, 12, -2], [8, 12, 4], [16, 16])]),
        bone("head", [0, 24, 0], "body", [cube([-4, 24, -4], [8, 8, 8], [0, 0])]),
        bone("rightArm", [-5, 22, 0], "body", [cube([-6, 12, -1], [2, 12, 2], [40, 16])]),
        bone("rightItem", [-6, 15, 1], "rightArm"),
        bone("leftArm", [5, 22, 0], "body", [cube([4, 12, -1], [2, 12, 2], [40, 16])], mirror=True),
        bone("leftItem", [6, 15, 1], "leftArm"),
        bone("rightLeg", [-2, 12, 0], "root", [cube([-3, 0, -1], [2, 12, 2], [0, 16])]),
        bone("leftLeg", [2, 12, 0], "root", [cube([1, 0, -1], [2, 12, 2], [0, 16])], mirror=True),
    ]))
    # --- Creeper
    g.append(geo("geometry.morph.creeper", 64, 32, [
        bone("root", [0, 0, 0]),
        bone("body", [0, 12, 0], "root", [cube([-4, 6, -2], [8, 12, 4], [16, 16])]),
        bone("head", [0, 18, 0], "body", [cube([-4, 18, -4], [8, 8, 8], [0, 0])]),
        bone("leg0", [-2, 6, 4], "root", [cube([-4, 0, 2], [4, 6, 4], [0, 16])]),
        bone("leg1", [2, 6, 4], "root", [cube([0, 0, 2], [4, 6, 4], [0, 16])]),
        bone("leg2", [-2, 6, -4], "root", [cube([-4, 0, -6], [4, 6, 4], [0, 16])]),
        bone("leg3", [2, 6, -4], "root", [cube([0, 0, -6], [4, 6, 4], [0, 16])]),
        bone("rightItem", [-4, 12, -2], "body"),
        bone("leftItem", [4, 12, -2], "body"),
    ]))
    # --- Spider
    spider = [bone("root", [0, 0, 0]),
              bone("body0", [0, 9, 0], "root", [cube([-3, 6, -3], [6, 6, 6], [0, 0])]),
              bone("head", [0, 9, -3], "body0", [cube([-4, 5, -11], [8, 8, 8], [32, 4])]),
              bone("body1", [0, 9, 9], "body0", [cube([-5, 5, 3], [10, 8, 12], [0, 12])])]
    for i, z in enumerate((2, 1, 0, -1)):
        spider.append(bone(f"leg{i*2}", [-4, 9, z], "body0", [cube([-19, 8, z - 1], [16, 2, 2], [18, 0])]))
        spider.append(bone(f"leg{i*2+1}", [4, 9, z], "body0", [cube([3, 8, z - 1], [16, 2, 2], [18, 0])]))
    spider += [bone("rightItem", [-4, 10, -6], "head"), bone("leftItem", [4, 10, -6], "head")]
    g.append(geo("geometry.morph.spider", 64, 32, spider, (3, 2, (0, 0.5, 0))))
    # --- Enderman (rest pose baked in: legs 0-30, body 30-42, head 42-50)
    g.append(geo("geometry.morph.enderman", 64, 32, humanoid_core() + [
        bone("body", [0, 42, 0], "waist", [cube([-4, 30, -2], [8, 12, 4], [32, 16])]),
        bone("head", [0, 42, 0], "body", [cube([-4, 42, -4], [8, 8, 8], [0, 0])]),
        bone("hat", [0, 42, 0], "head", [cube([-4, 41.5, -4], [8, 8, 8], [0, 16], -0.5)]),
        bone("rightArm", [-5, 40, 0], "body", [cube([-6, 12, -1], [2, 30, 2], [56, 0])]),
        bone("rightItem", [-5, 13, 1], "rightArm"),
        bone("leftArm", [5, 40, 0], "body", [cube([4, 12, -1], [2, 30, 2], [56, 0])], mirror=True),
        bone("leftItem", [5, 13, 1], "leftArm"),
        bone("rightLeg", [-2, 30, 0], "root", [cube([-3, 0, -1], [2, 30, 2], [56, 0])]),
        bone("leftLeg", [2, 30, 0], "root", [cube([1, 0, -1], [2, 30, 2], [56, 0])], mirror=True),
    ], (2, 4, (0, 2, 0))))
    # --- Blaze (rod bones are placed every frame by the vanilla "animation.blaze.move")
    blaze = [bone("root", [0, 0, 0]),
             bone("body", [0, 24, 0], "root"),
             bone("head", [0, 24, 0], "body", [cube([-4, 20, -4], [8, 8, 8], [0, 0])])]
    for i in range(12):
        blaze.append(bone(f"upperBodyParts{i}", [0, 24, 0], "body", [cube([0, 16, 0], [2, 8, 2], [0, 16])]))
    blaze += [bone("rightItem", [-6, 16, 0], "body"), bone("leftItem", [6, 16, 0], "body")]
    g.append(geo("geometry.morph.blaze", 64, 32, blaze, (2, 3, (0, 1.2, 0))))
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
        fp("geometry.morph.fp.shapeshifter", 64, 64,
           [cube([-7, 9, -1.5], [3, 15, 3], [40, 16])], [cube([4, 9, -1.5], [3, 15, 3], [16, 34])]),
        fp("geometry.morph.fp.zombie", 64, 32,
           [cube([-8, 12, -2], [4, 12, 4], [40, 16])], [cube([4, 12, -2], [4, 12, 4], [40, 16], mirror=True)]),
        fp("geometry.morph.fp.skeleton", 64, 32,
           [cube([-6, 12, -1], [2, 12, 2], [40, 16])], [cube([4, 12, -1], [2, 12, 2], [40, 16], mirror=True)]),
        # creeper has no arms: you see a stubby creeper leg-limb as your "hand"
        fp("geometry.morph.fp.creeper", 64, 32,
           [cube([-8, 12, -2], [4, 6, 4], [0, 16]), cube([-8, 18, -2], [4, 6, 4], [0, 16])],
           [cube([4, 12, -2], [4, 6, 4], [0, 16]), cube([4, 18, -2], [4, 6, 4], [0, 16])]),
        # spider: a hairy spider leg, rotated upright
        fp("geometry.morph.fp.spider", 64, 32, [], None, [
            bone("spiderLeg", [-6, 12, 0], "rightArm", [cube([-6, 11, -1], [16, 2, 2], [18, 0])], rotation=[0, 0, -90]),
            bone("spiderClaw", [-6, 12, 0], "rightArm", [cube([-7, 9, -1], [2, 4, 2], [18, 0])]),
        ]),
        fp("geometry.morph.fp.enderman", 64, 32,
           [cube([-6, 9, -1], [2, 15, 2], [56, 0])], [cube([4, 9, -1], [2, 15, 2], [56, 0], mirror=True)]),
        # blaze: two burning rods
        fp("geometry.morph.fp.blaze", 64, 32,
           [cube([-7, 12, -1], [2, 8, 2], [0, 16]), cube([-5.5, 17, 0], [2, 8, 2], [0, 16])],
           [cube([5, 12, -1], [2, 8, 2], [0, 16]), cube([3.5, 17, 0], [2, 8, 2], [0, 16])]),
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
