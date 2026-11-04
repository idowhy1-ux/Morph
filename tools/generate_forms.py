#!/usr/bin/env python3
"""Builds every morph form (all vanilla mobs) from a checkout of Mojang's bedrock-samples.

Usage (from repo root):
    git clone --depth 1 https://github.com/Mojang/bedrock-samples /tmp/bedrock-samples
    python3 tools/generate_assets.py           # shapeshifter textures/models
    python3 tools/generate_forms.py /tmp/bedrock-samples

Writes, into packs/:
  RP  entity/player.entity.json, entity/stolen_skin.entity.json
      render_controllers/morph.render_controllers.json
      animation_controllers/morph.animation_controllers.json
      animations/morph_generated.animation.json
      models/entity/morph_fp_generated.geo.json (+ legacy variant)
  BP  entities/player.json, entities/stolen_skin.json
      scripts/forms_data.js
"""
import copy
import json
import math
import os
import sys

from vanilla_index import index, load

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RP = os.path.join(ROOT, "packs", "MorphRP")
BP = os.path.join(ROOT, "packs", "MorphBP")

# --------------------------------------------------------------------------- tweaks
DROP_ANIMS = {
    "axolotl": {"animation.axolotl.idle_underwater", "animation.axolotl.idle_floor_underwater",
                "animation.axolotl.swim", "animation.axolotl.walk_floor_underwater"},
    "bat": {"animation.bat.resting"},
    "bee": {"animation.bee.no_stinger"},
    "breeze": {"animation.breeze.whirl_sound", "animation.breeze.slide"},
    "camel": {"animation.camel.stand_up"}, "camel_husk": {"animation.camel.stand_up"},
    "cat": {"animation.cat.sprint"}, "ocelot": {"animation.ocelot.sprint"},
    "copper_golem": {"animation.copper_golem.spin", "animation.copper_golem.spin.oxidized"},
    "frog": {"animation.frog.swim", "animation.frog.idle.water"},
    "fox": {"animation.fox.wiggle", "animation.fox.stuck"},
    "panda": {"animation.panda.unhappy", "animation.panda.sneezing", "animation.panda.lying"},
    "parrot": {"animation.parrot.standing"},
    "iron_golem": {"animation.iron_golem.move_to_target"},
    "wither": {"animation.wither_boss.scale"},
}
FORCE_SPEED = {"animation.rabbit.move.v2", "animation.copper_golem.walk", "animation.frog.walk",
               "animation.piglin.move", "animation.endermite.move", "animation.dolphin.move"}
TEXTURE_OVERRIDE = {"elder_guardian": "textures/entity/guardian_elder"}
ZOMBIE_ARMS = {"zombie", "husk", "drowned", "zombie_villager", "zombie_villager_v2", "parched"}
# bones that only make sense with extra layers/equipment the player never has
ALWAYS_HIDDEN = ["Saddle", "ReinsL", "ReinsR", "Bridle", "BitL", "BitR", "BagL", "BagR", "body_rolled_up",
                 "tongue", "croaking_body", "tornado_body", "tornado_bottom", "tornado_mid", "tornado_top",
                 "brim"]
MULE_EARS = {"donkey", "mule"}
FP_TARGET = [-5.0, 22.0, 0.0]
SEAT_MIN, SEAT_STEP, SEAT_COUNT = -2.5, 0.05, 241   # seat heights -2.5 .. 9.5 blocks


def seat_index(y):
    return int(min(max(round((y - SEAT_MIN) / SEAT_STEP), 0), SEAT_COUNT - 1))


def lname(b):
    return b["name"].lower()


def children_map(bones):
    ch = {}
    for b in bones:
        p = (b.get("parent") or "").lower()
        ch.setdefault(p, []).append(b)
    return ch


def subtree(bones, root):
    ch = children_map(bones)
    out, stack = [], [root]
    while stack:
        b = stack.pop()
        out.append(b)
        stack.extend(ch.get(lname(b), []))
    return out


def cubes_of(bs):
    return [c for b in bs for c in b.get("cubes", [])]


def renderable(b):
    return not b.get("neverRender") and b["name"] not in ALWAYS_HIDDEN and "poly_mesh" not in b


def pick_limb(bones):
    vis = [b for b in bones if renderable(b)]
    names = {lname(b) for b in vis}
    piv = lambda b: b.get("pivot", [0, 0, 0])

    def has_cubes(b):
        return bool(cubes_of(subtree(bones, b)))

    def top_level(cands, word):
        # drop bones whose parent also matches (e.g. leg tips)
        return [b for b in cands if not (b.get("parent") and word in (b.get("parent") or "").lower())]

    groups = [
        ("arm", lambda n: "arm" in n and "armor" not in n),
        ("leg", lambda n: "leg" in n and "legging" not in n),
        ("wing", lambda n: "wing" in n),
        ("tentacle", lambda n: "tentacle" in n),
        ("fin", lambda n: "fin" in n and "tail" not in n),
        ("upperbodypart", lambda n: "upperbodypart" in n or n.startswith("rod")),
        ("tail", lambda n: "tail" in n),
    ]
    for word, test in groups:
        c = top_level([b for b in vis if test(lname(b)) and has_cubes(b)], word)
        if not c:
            continue
        right = [b for b in c if "right" in lname(b) or lname(b).endswith("r") or lname(b).endswith("fr")]
        pool = right or c
        # front-most (lowest z), then right-most (lowest x)
        pool.sort(key=lambda b: (0 if "front" in lname(b) else 1, round(piv(b)[2], 2) if word == "leg" else 0, piv(b)[0]))
        return pool[0]
    for b in vis:
        if b.get("cubes"):
            return b
    return None


def bbox(cs):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for c in cs:
        o, s = c["origin"], c["size"]
        for i in range(3):
            lo[i] = min(lo[i], o[i]); hi[i] = max(hi[i], o[i] + s[i])
    return lo, hi


def shift(v, d):
    return [round(v[i] + d[i], 4) for i in range(3)]


def make_fp(mob):
    """First-person arm: the mob's arm/leg/wing/etc. re-hung at the player's shoulder."""
    bones = mob["bones"]
    limb = pick_limb(bones)
    base = [{"name": "root", "pivot": [0, 0, 0]},
            {"name": "waist", "parent": "root", "pivot": [0, 12, 0]},
            {"name": "body", "parent": "waist", "pivot": [0, 24, 0]},
            {"name": "rightArm", "parent": "body", "pivot": FP_TARGET},
            {"name": "rightItem", "parent": "rightArm", "pivot": [-6, 15, 1]}]
    if not limb:
        return base, 1.0, None
    tree = [b for b in subtree(bones, limb) if renderable(b)]
    cs = cubes_of(tree)
    pivot = limb.get("pivot", [0, 0, 0])
    lo, hi = bbox(cs)
    ext = [hi[i] - lo[i] for i in range(3)]
    axis = max(range(3), key=lambda i: ext[i])
    centre = (lo[axis] + hi[axis]) / 2
    toward_neg = centre < pivot[axis]
    if axis == 1:
        rot = [0, 0, 0] if toward_neg else [180, 0, 0]
    elif axis == 0:
        rot = [0, 0, -90] if toward_neg else [0, 0, 90]
    else:
        rot = [90, 0, 0] if toward_neg else [-90, 0, 0]
    length = max(abs(lo[axis] - pivot[axis]), abs(hi[axis] - pivot[axis]), 1)
    cross = max(ext[i] for i in range(3) if i != axis) or 1
    fit = min(max(10.0 / length, 0.3), 2.0)
    fit = min(fit, 7.0 / cross) if cross * fit > 7 else fit
    fit = round(max(fit, 0.2), 3)
    d = [FP_TARGET[i] - pivot[i] for i in range(3)]
    base.append({"name": "fp_mount", "parent": "rightArm", "pivot": FP_TARGET, "rotation": rot})
    keep = {lname(b) for b in tree}
    for b in tree:
        nb = {"name": "fp_" + b["name"], "pivot": shift(b.get("pivot", [0, 0, 0]), d)}
        par = (b.get("parent") or "").lower()
        nb["parent"] = "fp_mount" if b is limb or par not in keep else "fp_" + next(x["name"] for x in tree if lname(x) == par)
        for k in ("rotation", "mirror", "inflate"):
            if k in b and not (k == "rotation" and b is limb and False):
                nb[k] = b[k]
        if b.get("bind_pose_rotation") and "rotation" not in nb:
            nb["rotation"] = b["bind_pose_rotation"]
        cubes = []
        for c in b.get("cubes", []):
            nc = copy.deepcopy(c)
            nc["origin"] = shift(c["origin"], d)
            if "pivot" in c:
                nc["pivot"] = shift(c["pivot"], d)
            cubes.append(nc)
        if cubes:
            nb["cubes"] = cubes
        base.append(nb)
    return base, fit, limb["name"]


def head_bones(bones):
    heads = [b for b in bones if lname(b) == "head" or lname(b) == "head1"]
    out = set()
    for h in heads:
        out |= {b["name"] for b in subtree(bones, h)}
    return out


# --------------------------------------------------------------------------- animations
def bone_set(anim):
    return {k.lower() for k in anim.get("bones", {})}


def generic_motion(mob, animated):
    """Walk cycle / flapping for bones no vanilla animation handles."""
    bones = [b for b in mob["bones"] if renderable(b)]
    player_handled = {"rightarm", "leftarm", "rightleg", "leftleg", "head", "body"}
    out = {}
    for b in bones:
        n = lname(b)
        if n in animated or n in player_handled:
            continue
        if b.get("parent") and any(w in (b.get("parent") or "").lower() for w in ("leg", "arm", "wing")):
            continue
        p = b.get("pivot", [0, 0, 0])
        side = -1 if p[0] < 0 else 1
        front = -1 if p[2] < 0 else 1
        if ("leg" in n and "legging" not in n) or n in ("frontlegs", "backlegs"):
            sign = side * front
            out[b["name"]] = {"rotation": [f"variable.tcos0 * {1.2 * sign}", 0, 0]}
        elif "arm" in n and "armor" not in n:
            out[b["name"]] = {"rotation": [f"variable.tcos0 * {-1.0 * side}", 0, 0]}
        elif "wing" in n:
            out[b["name"]] = {"rotation": [0, 0, f"math.sin(query.life_time * 1100.0) * (query.is_on_ground ? 8.0 : 40.0) * {side}"]}
        elif "tentacle" in n:
            out[b["name"]] = {"rotation": [f"math.sin(query.life_time * 200.0 + {abs(hash(n)) % 360}) * 12.0", 0, 0]}
        elif "fin" in n or "tail" in n:
            out[b["name"]] = {"rotation": [0, "math.sin(query.life_time * 400.0) * 15.0", 0]}
    return out


def body_motion(mob, already):
    """Motion the player animations used to supply, for when the mob is drawn on the body."""
    already = {a.lower() for a in already}
    out = {}
    limbs = {"rightarm": -1, "leftarm": 1, "rightleg": 1, "leftleg": -1}
    found = False
    for b in mob["bones"]:
        n = lname(b)
        if n in limbs and renderable(b) and n not in already:
            out[b["name"]] = {"rotation": [f"variable.tcos0 * {1.4 * limbs[n] if 'leg' in n else 1.0 * limbs[n]}", 0, 0]}
            found = True
    has_limbs = found or any(any(w in lname(b) for w in ("leg", "arm", "wing", "fin", "tentacle")) for b in mob["bones"] if renderable(b))
    if not has_limbs and not already:
        for t in top_bones(mob):
            out[t] = {"position": [0, "math.abs(math.sin(query.modified_distance_moved * 25.0)) * 3.0 * math.clamp(query.modified_move_speed * 2.0, 0.0, 1.0) + math.sin(query.life_time * 120.0) * 0.4", 0]}
    for b in mob["bones"]:
        n = lname(b)
        if n in ("rods", "upperbodypart2", "upperbodypart3") and n not in already:
            out[b["name"]] = {"rotation": [0, "query.life_time * 90.0", 0]} if n == "rods" else {"rotation": [f"math.sin(query.life_time * 90.0) * 5.0", 0, 0]}
    return out


def top_bones(mob):
    return [b["name"] for b in mob["bones"] if not b.get("parent") and renderable(b)]


def find(mob, *names):
    for b in mob["bones"]:
        if lname(b) in names:
            return b["name"]
    return None


def absorb_anim(mob):
    bones = {}
    for t in top_bones(mob):
        bones[t] = {"position": ["math.sin(query.life_time * 2100.0) * 0.35", "6.0 + math.sin(query.life_time * 360.0)",
                                 "math.cos(query.life_time * 1900.0) * 0.35"],
                    "scale": "1.0 + math.sin(query.life_time * 1080.0) * 0.07"}
    h = find(mob, "head")
    if h:
        bones.setdefault(h, {})["rotation"] = [-30.0, 0.0, "math.sin(query.life_time * 1500.0) * 6.0"]
    ra = find(mob, "rightarm", "right_arm", "arm0")
    la = find(mob, "leftarm", "left_arm", "arm1")
    if ra:
        bones.setdefault(ra, {})["rotation"] = ["-20.0 + math.sin(query.life_time * 1700.0) * 8.0", 0.0, "100.0 + math.sin(query.life_time * 1300.0) * 10.0"]
    if la:
        bones.setdefault(la, {})["rotation"] = ["-20.0 - math.sin(query.life_time * 1600.0) * 8.0", 0.0, "-100.0 - math.sin(query.life_time * 1250.0) * 10.0"]
    return {"loop": True, "bones": bones}


def peel_anim(mob):
    bones = {}
    for i, t in enumerate(top_bones(mob)):
        bones[t] = {"rotation": [f"math.sin(query.life_time * {500 + i * 37}.0) * 25.0", 0.0,
                                 f"math.cos(query.life_time * {420 + i * 29}.0) * 30.0"]}
    for b in mob["bones"]:
        n = lname(b)
        if renderable(b) and any(w in n for w in ("arm", "leg", "wing", "tentacle")) and "armor" not in n:
            side = -1 if b.get("pivot", [0, 0, 0])[0] < 0 else 1
            bones[b["name"]] = {"rotation": [f"math.sin(query.life_time * 900.0) * {35 * side}", 0.0, f"{30 * side * -1}"]}
    return {"loop": True, "bones": bones}


# --------------------------------------------------------------------------- main
def main(vanilla):
    mobs = index(vanilla)
    anims_src = {}
    import glob
    for f in glob.glob(os.path.join(vanilla, "resource_pack", "animations", "*.json")):
        try:
            anims_src.update(load(f).get("animations", {}))
        except Exception:
            pass

    shapeshifter_geo = json.load(open(os.path.join(RP, "models", "entity", "morph_forms.geo.json")))["minecraft:geometry"][0]
    shapeshifter = {
        "type": None, "key": "shapeshifter", "name": "Shapeshifter", "hp": 20, "height": 1.8, "width": 0.6,
        "natural_scale": 0.9375, "texture": "textures/entity/morph/shapeshifter",
        "geometry": "geometry.morph.shapeshifter", "tw": 64, "th": 64, "legacy": False,
        "bones": shapeshifter_geo["bones"], "anims": [{"id": "animation.morph.shapeshifter.aura", "speed": False}],
        "families": [],
    }
    forms = [shapeshifter] + sorted(mobs, key=lambda m: m["name"])

    gen_anims = {}
    fp_new, fp_legacy = [], {}
    states = {"router": {"transitions": []}}
    body_states = {"router": {"transitions": []}}
    hidden_by_bone = {}  # bone name -> list of form ids where it is part of the head (pov hide)
    data = []
    for fid, m in enumerate(forms):
        key = m["key"]
        base_key = key[5:] if key.startswith("baby_") else key
        tex = TEXTURE_OVERRIDE.get(key, m["texture"])
        # first-person geometry
        if key == "shapeshifter":
            fp_id, fit, limb = "geometry.morph.fp.shapeshifter", 1.0, "rightArm"
        else:
            fp_bones, fit, limb = make_fp(m)
            fp_id = f"geometry.morph.fp.{key}"
            if m["legacy"]:
                fp_legacy[fp_id] = {"texturewidth": m["tw"], "textureheight": m["th"],
                                    "visible_bounds_width": 2, "visible_bounds_height": 3,
                                    "visible_bounds_offset": [0, 1.5, 0], "bones": fp_bones}
            else:
                fp_new.append({"description": {"identifier": fp_id, "texture_width": m["tw"], "texture_height": m["th"],
                                               "visible_bounds_width": 2, "visible_bounds_height": 3,
                                               "visible_bounds_offset": [0, 1.5, 0]}, "bones": fp_bones})
        m["fp_geometry"], m["texture_final"] = fp_id, tex

        # third-person animations for this form
        state_anims = []
        animated = set()
        for a in m["anims"]:
            if a["id"] in DROP_ANIMS.get(base_key, set()):
                continue
            short = f"f{fid}_" + a["id"].replace("animation.", "").replace(".", "_")
            m.setdefault("anim_map", {})[short] = a["id"]
            speed = a["speed"] or a["id"] in FORCE_SPEED
            w = "!variable.is_first_person"
            if speed:
                w += " * math.clamp(query.modified_move_speed * 1.5, 0.0, 1.0)"
            state_anims.append({short: w})
            # only animations that actually move over time count as "animating" a bone; static poses
            # (e.g. parrot.base) must not stop the generic walk/flap from being added
            body_json = json.dumps(anims_src.get(a["id"], {}))
            if any(q in body_json for q in ("anim_time", "life_time", "modified_distance_moved", "modified_move_speed", "tcos0")):
                animated |= bone_set(anims_src.get(a["id"], {}))
        if base_key in ZOMBIE_ARMS:
            m.setdefault("anim_map", {})[f"f{fid}_zombie_arms"] = "animation.morph.zombie.arms"
            state_anims.append({f"f{fid}_zombie_arms": "!variable.is_first_person && variable.attack_time <= 0.0"})
        if key != "shapeshifter":
            motion = generic_motion(m, animated)
            if motion:
                aid = f"animation.morph.gen.walk.{key}"
                gen_anims[aid] = {"loop": True, "bones": motion}
                m.setdefault("anim_map", {})[f"f{fid}_walk"] = aid
                state_anims.append({f"f{fid}_walk": "!variable.is_first_person"})
        ab = f"animation.morph.gen.absorb.{key}"
        gen_anims[ab] = absorb_anim(m)
        m.setdefault("anim_map", {})[f"f{fid}_absorb"] = ab
        state_anims.append({f"f{fid}_absorb": "variable.morph_absorb && !variable.is_first_person"})
        m["anim_map"][f"f{fid}_absorb_fp"] = "animation.morph.absorb.first_person"
        state_anims.append({f"f{fid}_absorb_fp": "variable.morph_absorb && variable.is_first_person"})
        if abs(fit - 1.0) > 0.01:
            fa = f"animation.morph.gen.fpfit.{key}"
            gen_anims[fa] = {"loop": True, "bones": {"rightArm": {"scale": fit}}}
            m["anim_map"][f"f{fid}_fpfit"] = fa
            state_anims.append({f"f{fid}_fpfit": "variable.is_first_person"})
        pk = f"animation.morph.gen.peel.{key}"
        gen_anims[pk] = peel_anim(m)
        m["peel"] = pk

        states[f"form_{fid}"] = {"animations": state_anims,
                                 "transitions": [{"router": f"variable.morph_form != {fid}"}]}
        states["router"]["transitions"].append({f"form_{fid}": f"variable.morph_form == {fid}"})
        # the same form, drawn on the invisible body the player rides (third person / other players)
        body_anims = [a for a in state_anims if not any(x in next(iter(a)) for x in ("_absorb_fp", "_fpfit"))]
        # the body has no vanilla player animations: walk human-style limbs and liven up limbless mobs
        extra = body_motion(m, animated | set(generic_motion(m, animated)))
        if extra:
            aid = f"animation.morph.gen.bodywalk.{key}"
            gen_anims[aid] = {"loop": True, "bones": extra}
            m["anim_map"][f"f{fid}_bodywalk"] = aid
            body_anims.append({f"f{fid}_bodywalk": "1.0"})
        hb = find(m, "head")
        if hb:
            m["anim_map"]["morph_body_pitch"] = "animation.morph.body.pitch"
            body_anims.append({"morph_body_pitch": "1.0"})
        body_states[f"form_{fid}"] = {"animations": body_anims,
                                      "transitions": [{"router": f"variable.morph_form != {fid}"}]}
        body_states["router"]["transitions"].append({f"form_{fid}": f"variable.morph_form == {fid}"})

        eye = 1.62 if key == "shapeshifter" else round(m["height"] * 0.85, 3)
        data.append({"id": fid, "type": m["type"], "key": key, "name": m["name"], "hp": int(math.ceil(m["hp"])),
                     "eye": eye, "height": m["height"], "width": m["width"], "baby": bool(m.get("baby")), "r": round(m["natural_scale"], 4), "families": m["families"]})

    # ---------------- RP: geometry
    with open(os.path.join(RP, "models", "entity", "morph_fp_generated.geo.json"), "w") as f:
        json.dump({"format_version": "1.12.0", "minecraft:geometry": fp_new}, f, indent=1)
    with open(os.path.join(RP, "models", "entity", "morph_fp_generated_legacy.geo.json"), "w") as f:
        json.dump(dict({"format_version": "1.8.0"}, **fp_legacy), f, indent=1)

    gen_anims["animation.morph.body.pitch"] = {"loop": True, "bones": {"head": {"rotation": ["query.property('morph:pitch')", 0, 0]}}}
    # ---------------- RP: animations + controller
    with open(os.path.join(RP, "animations", "morph_generated.animation.json"), "w") as f:
        json.dump({"format_version": "1.8.0", "animations": gen_anims}, f, indent=1)
    os.makedirs(os.path.join(RP, "animation_controllers"), exist_ok=True)
    with open(os.path.join(RP, "animation_controllers", "morph.animation_controllers.json"), "w") as f:
        json.dump({"format_version": "1.10.0", "animation_controllers": {
            "controller.animation.morph.forms": {"initial_state": "router", "states": states},
            "controller.animation.morph.body_forms": {"initial_state": "router", "states": body_states}}}, f, indent=1)

    # ---------------- RP: client entities
    pe = load(os.path.join(vanilla, "resource_pack", "entity", "player.entity.json"))
    desc = pe["minecraft:client_entity"]["description"]
    for m in forms:
        desc["textures"][f"morph_{m['key']}"] = m["texture_final"]
        desc["geometry"][f"morph_{m['key']}"] = m["geometry"]
        desc["geometry"][f"morph_fp_{m['key']}"] = m["fp_geometry"]
        desc["animations"].update(m.get("anim_map", {}))
    desc["animations"]["morph_forms"] = "controller.animation.morph.forms"
    s = desc["scripts"]
    s["scale"] = "variable.is_first_person ? 0.9375 : query.property('morph:r')"
    s["pre_animation"] += [
        "variable.morph_form = query.property('morph:form');",
        "variable.morph_absorb = query.property('morph:absorb');",
        "variable.morph_glow = variable.morph_absorb ? (0.35 + 0.25 * math.sin(query.life_time * 900.0)) : 0.0;",
    ]
    s["animate"] = ["root", "morph_forms"]
    # while riding our invisible body the vanilla sitting pose must not play
    for k in ("riding.arms", "riding.legs", "riding.root"):
        desc["animations"][k] = "animation.morph.noop"
    rcs = []
    for r in desc["render_controllers"]:
        k = next(iter(r))
        cond = next(iter(r.values()))
        if k == "controller.render.player.third_person":
            # inside a body the body draws the mob (standing on the ground); hide the shifted player model
            cond = f"({cond}) && !query.property('morph:in_body')"
        # keep the vanilla controller names: the game draws the first-person hand through
        # controller.render.player.first_person specifically, so we override that controller itself
        rcs.append({k: cond})
    desc["render_controllers"] = rcs
    with open(os.path.join(RP, "entity", "player.entity.json"), "w") as f:
        json.dump(pe, f, indent=1)

    skin = {"format_version": "1.10.0", "minecraft:client_entity": {"description": {
        "identifier": "morph:stolen_skin",
        "materials": {"default": "entity_alphatest"},
        "textures": {f"morph_{m['key']}": m["texture_final"] for m in forms},
        "geometry": {f"morph_{m['key']}": m["geometry"] for m in forms},
        "scripts": {
            "scale": "query.property('morph:r') * math.clamp(1.0 - math.pow(query.life_time / 1.6, 2.0), 0.12, 1.0)",
            "pre_animation": ["variable.morph_form = query.property('morph:form');",
                              "variable.morph_glow = math.clamp(query.life_time * 0.7, 0.15, 0.85);",
                              "variable.morph_pov = 0;"],
            "animate": [{f"peel{m['id_']}": f"variable.morph_form == {m['id_']}"} for m in
                        [dict(x, id_=i) for i, x in enumerate(forms)]],
        },
        "animations": {f"peel{i}": m["peel"] for i, m in enumerate(forms)},
        "render_controllers": ["controller.render.morph.stolen_skin"],
    }}}
    with open(os.path.join(RP, "entity", "stolen_skin.entity.json"), "w") as f:
        json.dump(skin, f, indent=1)

    # ---------------- RP: render controllers
    empty = "(query.get_equipped_item_name(0, 1) == '' || query.get_equipped_item_name(0, 1) == 'filled_map')"
    geo_arr = ["Geometry.morph_" + m["key"] for m in forms]
    tex_arr = {"Array.morph_tex": ["Texture.morph_" + m["key"] for m in forms]}
    overlay = {"r": "0.62", "g": "0.18", "b": "1.0", "a": "variable.morph_glow"}
    mule_ids = [i for i, m in enumerate(forms) if m["key"].replace("baby_", "") in MULE_EARS]
    is_mule = " || ".join(f"variable.morph_form == {i}" for i in mule_ids) or "0"
    vis = [{"*": True}] + [{b: False} for b in ALWAYS_HIDDEN]
    vis += [{"MuleEarL": is_mule}, {"MuleEarR": is_mule}, {"EarL": f"!({is_mule})"}, {"EarR": f"!({is_mule})"}]
    # the rider's own first-person camera sits exactly eye-height above the body's feet
    OWN_CAM = "(math.abs(query.distance_from_camera - query.property('morph:eye')) > 0.35)"
    rc = {"format_version": "1.8.0", "render_controllers": {
        "controller.render.player.third_person": {
            "arrays": {"geometries": {"Array.morph_geo": geo_arr}, "textures": tex_arr},
            "geometry": "Array.morph_geo[variable.morph_form]",
            "materials": [{"*": "Material.default"}],
            "textures": ["Array.morph_tex[variable.morph_form]"],
            "overlay_color": overlay, "part_visibility": vis},
        "controller.render.player.first_person": {
            "arrays": {"geometries": {"Array.morph_fp_geo": ["Geometry.morph_fp_" + m["key"] for m in forms]}, "textures": tex_arr},
            "geometry": "Array.morph_fp_geo[variable.morph_form]",
            "materials": [{"*": "Material.default"}],
            "textures": ["Array.morph_tex[variable.morph_form]"],
            "overlay_color": overlay, "part_visibility": [{"*": empty}]},
        "controller.render.morph.body": {
            "arrays": {"geometries": {"Array.morph_geo": geo_arr}, "textures": tex_arr},
            "geometry": "Array.morph_geo[variable.morph_form]",
            "materials": [{"*": "Material.default"}],
            "textures": ["Array.morph_tex[variable.morph_form]"],
            "overlay_color": overlay,
            "part_visibility": [{"*": OWN_CAM}] + [{b: False} for b in ALWAYS_HIDDEN] + [
                {"MuleEarL": f"({is_mule}) && {OWN_CAM}"}, {"MuleEarR": f"({is_mule}) && {OWN_CAM}"},
                {"EarL": f"!({is_mule}) && {OWN_CAM}"}, {"EarR": f"!({is_mule}) && {OWN_CAM}"}]},
        "controller.render.morph.stolen_skin": {
            "arrays": {"geometries": {"Array.morph_geo": geo_arr}, "textures": tex_arr},
            "geometry": "Array.morph_geo[variable.morph_form]",
            "materials": [{"*": "Material.default"}],
            "textures": ["Array.morph_tex[variable.morph_form]"],
            "overlay_color": overlay, "part_visibility": [{"*": True}] + [{b: False} for b in ALWAYS_HIDDEN],
            "is_hurt_color": {"r": "0", "g": "0", "b": "0", "a": "0"},
            "on_fire_color": {"r": "0", "g": "0", "b": "0", "a": "0"}},
    }}
    with open(os.path.join(RP, "render_controllers", "morph.render_controllers.json"), "w") as f:
        json.dump(rc, f, indent=1)

    # ---------------- BP: player + skin entity
    pj = load(os.path.join(vanilla, "behavior_pack", "entities", "player.json"))
    ent = pj["minecraft:entity"]
    n = len(forms) - 1
    ent["description"]["properties"] = {
        "morph:form": {"type": "int", "range": [0, n], "default": 0, "client_sync": True},
        "morph:absorb": {"type": "bool", "default": False, "client_sync": True},
        "morph:r": {"type": "float", "range": [0.0, 16.0], "default": 0.9375, "client_sync": True},
        "morph:in_body": {"type": "bool", "default": False, "client_sync": True},
    }
    hps = sorted({d["hp"] for d in data})
    groups = {f"morph:hp_{h}": {"minecraft:health": {"value": h, "max": h}} for h in hps}
    ent.setdefault("component_groups", {}).update(groups)
    for h in hps:
        ent.setdefault("events", {})[f"morph:hp_{h}"] = {"sequence": [
            {"remove": {"component_groups": [g for g in groups]}},
            {"add": {"component_groups": [f"morph:hp_{h}"]}}]}
    with open(os.path.join(BP, "entities", "player.json"), "w") as f:
        json.dump(pj, f, indent=1)

    sk = json.load(open(os.path.join(BP, "entities", "stolen_skin.json")))
    props = sk["minecraft:entity"]["description"]["properties"]
    props["morph:form"]["range"] = [0, n]
    props["morph:r"] = {"type": "float", "range": [0.0, 16.0], "default": 1.0, "client_sync": True}
    with open(os.path.join(BP, "entities", "stolen_skin.json"), "w") as f:
        json.dump(sk, f, indent=2)

    # ---------------- BP + RP: the invisible "body" the player rides so the real camera sits at mob eye height
    seats = {f"morph:seat_{i}": {"minecraft:rideable": {
        "seat_count": 1, "family_types": ["player"], "crouching_skip_interact": True, "pull_in_entities": False,
        "seats": [{"position": [0.0, round(SEAT_MIN + i * SEAT_STEP, 3), 0.0]}]}}
        for i in range(SEAT_COUNT)}
    sizes = {}
    for d in data:
        w = round(min(max(d["width"], 0.2), 3.0), 2)
        h = round(min(max(d["height"], 0.2), 4.5), 2)
        d["size"] = f"{int(w * 100)}_{int(h * 100)}"
        sizes[f"morph:size_{d['size']}"] = {"minecraft:collision_box": {"width": w, "height": h}}
    groups = dict(seats, **sizes)
    groups["morph:despawn"] = {"minecraft:instant_despawn": {}}
    body = {"format_version": "1.26.0", "minecraft:entity": {
        "description": {"identifier": "morph:body", "is_spawnable": False, "is_summonable": True},
        "component_groups": groups,
        "components": {
            "minecraft:type_family": {"family": ["morph_body", "inanimate"]},
            "minecraft:collision_box": {"width": 0.6, "height": 1.8},
            "minecraft:physics": {},
            "minecraft:movement": {"value": 0.13},
            "minecraft:movement.basic": {},
            "minecraft:jump.static": {},
            "minecraft:horse.jump_strength": {"value": 0.6},
            "minecraft:can_power_jump": {},
            "minecraft:input_ground_controlled": {},
            "minecraft:behavior.player_ride_tamed": {},
            "minecraft:is_tamed": {},
            "minecraft:is_saddled": {},
            "minecraft:rideable": seats[f"morph:seat_{seat_index(0.6)}"]["minecraft:rideable"],
            "minecraft:health": {"value": 1000, "max": 1000},
            "minecraft:damage_sensor": {"triggers": {"cause": "all", "deals_damage": "no"}},
            "minecraft:fire_immune": {},
            "minecraft:breathable": {"breathes_air": True, "breathes_water": True, "suffocate_time": -1, "total_supply": 15},
            "minecraft:knockback_resistance": {"value": 1.0},
            "minecraft:pushable": {"is_pushable": False, "is_pushable_by_piston": True},
            "minecraft:conditional_bandwidth_optimization": {},
        },
        "events": dict({k: {"add": {"component_groups": [k]}} for k in groups})}}
    body["minecraft:entity"]["description"]["properties"] = {
        "morph:form": {"type": "int", "range": [0, n], "default": 0, "client_sync": True},
        "morph:r": {"type": "float", "range": [0.0, 16.0], "default": 1.0, "client_sync": True},
        "morph:eye": {"type": "float", "range": [0.0, 16.0], "default": 1.62, "client_sync": True},
        "morph:pitch": {"type": "float", "range": [-90.0, 90.0], "default": 0.0, "client_sync": True},
        "morph:absorb": {"type": "bool", "default": False, "client_sync": True},
    }
    with open(os.path.join(BP, "entities", "morph_body.json"), "w") as f:
        json.dump(body, f, indent=1)
    body_anim_map = {}
    for m in forms:
        body_anim_map.update({k: v for k, v in m.get("anim_map", {}).items() if not k.endswith(("_absorb_fp", "_fpfit"))})
    body_anim_map["morph_body_forms"] = "controller.animation.morph.body_forms"
    with open(os.path.join(RP, "entity", "morph_body.entity.json"), "w") as f:
        json.dump({"format_version": "1.10.0", "minecraft:client_entity": {"description": {
            "identifier": "morph:body", "materials": {"default": "entity_alphatest"},
            "textures": {f"morph_{m['key']}": m["texture_final"] for m in forms},
            "geometry": {f"morph_{m['key']}": m["geometry"] for m in forms},
            "scripts": {
                "scale": "query.property('morph:r')",
                "pre_animation": [
                    "variable.is_first_person = 0.0;",
                    "variable.attack_time = 0.0;",
                    "variable.morph_form = query.property('morph:form');",
                    "variable.morph_absorb = query.property('morph:absorb');",
                    "variable.morph_glow = variable.morph_absorb ? (0.35 + 0.25 * math.sin(query.life_time * 900.0)) : 0.0;",
                    "variable.tcos0 = math.cos(query.modified_distance_moved * 38.17) * query.modified_move_speed * 57.3;",
                ],
                "animate": ["morph_body_forms"]},
            "animations": body_anim_map,
            "render_controllers": ["controller.render.morph.body"]}}}, f, indent=1)

    with open(os.path.join(BP, "scripts", "forms_data.js"), "w") as f:
        f.write("// Generated by tools/generate_forms.py - do not edit by hand.\n")
        f.write("export const FORM_DATA = " + json.dumps(data, indent=1) + ";\n")
        f.write(f"export const SEAT = {{ min: {SEAT_MIN}, step: {SEAT_STEP}, count: {SEAT_COUNT} }};\n")
    print(f"{len(forms)} forms, {len(gen_anims)} generated animations, hp values {hps}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/bedrock-samples")
