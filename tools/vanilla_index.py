"""Reads a checkout of github.com/Mojang/bedrock-samples and indexes every mob:
health, collision height, scale, client model/texture, usable animations, and geometry bones."""
import glob
import json
import os
import re


def load(path):
    txt = open(path, encoding="utf-8-sig").read()
    txt = re.sub(r'(?<![:"\\])//[^\n]*', "", txt)
    return json.loads(txt)


# entities that have a spawn egg but are not real mobs you could kill / become
EXCLUDE = {"minecraft:npc", "minecraft:agent", "minecraft:player", "minecraft:armor_stand",
           "minecraft:tripod_camera", "minecraft:creaking"}

SKIP_ANIM_WORDS = ("attack", "baby", "sit", "sleep", "eat", "death", "die", "roar", "sniff", "dig", "emerge",
                   "angry", "charg", "shoot", "sonic", "tame", "beg", "interact", "use", "hold", "cast",
                   "celebrat", "look", "riding", "ride", "admire", "danc", "scared", "ram", "spit", "sad",
                   "tongue", "croak", "inflate", "puff", "lay", "hurt", "stun", "dash", "roll", "peek",
                   "sneak", "crouch", "shake", "carry", "scary", "wag", "jump", "lie", "sitting", "milk",
                   "graz", "panic", "glid", "crawl", "brandish", "spear", "fang", "spell", "item", "bow",
                   "crossbow", "wave", "unroll", "open", "close", "drink", "throw", "harvest", "nod",
                   "head_bob_emote", "slam", "bark", "pounce", "stalk", "squash", "swell", "fuse",
                   "pose_up", "upside", "baby", "rear", "mouth", "tail_wag", "interest", "scratch")
SPEED_WORDS = ("walk", "run", "gallop", "move", "swim", "fly", "flap", "trot")


def index(root):
    bp_dir = os.path.join(root, "behavior_pack", "entities")
    rp_dir = os.path.join(root, "resource_pack")

    # ---- animations
    anims = {}
    for f in glob.glob(os.path.join(rp_dir, "animations", "*.json")):
        try:
            anims.update(load(f).get("animations", {}))
        except Exception:
            pass

    # ---- geometry
    raw = {}
    for f in [os.path.join(rp_dir, "models", "mobs.json")] + glob.glob(os.path.join(rp_dir, "models", "entity", "*.json")):
        try:
            d = load(f)
        except Exception:
            continue
        for k, v in d.items():
            if k == "format_version":
                continue
            if k == "minecraft:geometry":
                for g in v:
                    desc = g["description"]
                    raw[desc["identifier"]] = {"tw": desc.get("texture_width", 64), "th": desc.get("texture_height", 64),
                                               "bones": g.get("bones", []), "parent": None, "legacy": False}
            elif isinstance(v, dict):
                name, _, parent = k.partition(":")
                raw[name] = {"tw": v.get("texturewidth"), "th": v.get("textureheight"),
                             "bones": v.get("bones", []), "parent": parent or None, "legacy": True}

    def resolve(gid, depth=0):
        g = raw.get(gid)
        if not g or depth > 8:
            return None
        if g["parent"]:
            p = resolve(g["parent"], depth + 1)
            if p:
                bones = {b["name"].lower(): dict(b) for b in p["bones"]}
                order = [b["name"].lower() for b in p["bones"]]
                for b in g["bones"]:
                    key = b["name"].lower()
                    if key in bones:
                        merged = dict(bones[key]); merged.update(b); bones[key] = merged
                    else:
                        bones[key] = dict(b); order.append(key)
                return {"tw": g["tw"] or p["tw"] or 64, "th": g["th"] or p["th"] or 64,
                        "bones": [bones[k] for k in order], "legacy": g["legacy"]}
        return {"tw": g["tw"] or 64, "th": g["th"] or 64, "bones": g["bones"], "legacy": g["legacy"]}

    # ---- behavior side
    bp = {}
    for f in glob.glob(os.path.join(bp_dir, "*.json")):
        try:
            d = load(f)["minecraft:entity"]
        except Exception:
            continue
        ident = d["description"]["identifier"]
        comps = d.get("components", {})
        groups = d.get("component_groups", {})

        def pick(cname, prefer=("adult", "wild", "default", "normal", "large")):
            if cname in comps:
                return comps[cname]
            for word in prefer:
                for gname, g in groups.items():
                    if word in gname and cname in g:
                        return g[cname]
            for gname, g in groups.items():
                if cname in g and "baby" not in gname:
                    return g[cname]
            return None

        h = pick("minecraft:health")
        hp = None
        if h:
            vals = []
            for key in ("max", "value"):
                v = h.get(key)
                if isinstance(v, dict):
                    vals.append(v.get("range_max", v.get("range_min", 0)))
                elif isinstance(v, (int, float)):
                    vals.append(v)
            hp = max(vals) if vals else None
        cb = pick("minecraft:collision_box") or {}
        sc = pick("minecraft:scale") or {}
        baby = None
        for gname, g in groups.items():
            if "minecraft:is_baby" in g:
                bs = (g.get("minecraft:scale") or {}).get("value", 0.5)
                bcb = g.get("minecraft:collision_box") or cb
                bh = g.get("minecraft:health")
                bhp = None
                if bh:
                    v = bh.get("max", bh.get("value"))
                    bhp = v.get("range_max", v.get("range_min")) if isinstance(v, dict) else v
                baby = {"scale": bs if isinstance(bs, (int, float)) else 0.5,
                        "height": bcb.get("height", 1.8) * (bs if isinstance(bs, (int, float)) else 0.5),
                        "width": bcb.get("width", 0.6) * (bs if isinstance(bs, (int, float)) else 0.5),
                        "hp": bhp}
                break
        bp[ident] = {"baby": baby, "hp": hp, "height": cb.get("height", 1.8), "width": cb.get("width", 0.6),
                     "bp_scale": sc.get("value", 1.0) if isinstance(sc.get("value", 1.0), (int, float)) else 1.0,
                     "families": (comps.get("minecraft:type_family") or {}).get("family", [])}

    # ---- client side (prefer the newest file per identifier)
    clients = {}
    for f in sorted(glob.glob(os.path.join(rp_dir, "entity", "*.json"))):
        try:
            d = load(f)["minecraft:client_entity"]["description"]
        except Exception:
            continue
        ident = d["identifier"]
        score = (0 if "v1.0" in f else 1, f)
        if ident not in clients or score > clients[ident][0]:
            clients[ident] = (score, d)

    def eval_scale(expr, baby=False):
        if expr is None:
            return 1.0
        if isinstance(expr, (int, float)):
            return float(expr)
        e = str(expr)
        if "?" in e:
            cond, _, rest = e.partition("?")
            yes, _, no = rest.rpartition(":")
            if "is_baby" not in cond:
                yes = no
            e = yes if baby else no
        try:
            return float(eval(e, {"__builtins__": {}}))
        except Exception:
            return 1.0

    mobs = []
    for ident, b in sorted(bp.items()):
        if ident in EXCLUDE or not b["hp"] or ident not in clients:
            continue
        d = clients[ident][1]
        if "spawn_egg" not in d:
            continue
        tex = d.get("textures", {})
        geo_map = d.get("geometry", {})
        texture = tex.get("default") or tex.get("base") or next(iter(tex.values()), None)
        geometry = geo_map.get("default") or next(iter(geo_map.values()), None)
        if not texture or not geometry:
            continue
        g = resolve(geometry)
        if not g:
            print("no geometry for", ident, geometry)
            continue
        # animations usable on the player body
        chosen = []
        for key, aid in d.get("animations", {}).items():
            if aid.startswith("controller.") or aid not in anims:
                continue
            if aid.startswith(("animation.humanoid.", "animation.player.")):
                continue
            low = (key + " " + aid).lower()
            if any(w in low for w in SKIP_ANIM_WORDS):
                continue
            body = json.dumps(anims[aid])
            if "variable." in body.replace("variable.tcos0", ""):
                continue
            if "query.is_baby" in body or "query.is_sheared" in body:
                continue
            speed = any(w in low for w in SPEED_WORDS) and ("anim_time" in body or "modified_distance_moved" in body or "modified_move_speed" in body)
            chosen.append({"id": aid, "speed": speed})
        name = ident.split(":")[1]
        mobs.append({
            "type": ident, "key": name,
            "name": name.replace("_v2", "").replace("_", " ").title().replace("Evocation Illager", "Evoker")
                       .replace("Zombie Pigman", "Zombified Piglin").replace("Tropicalfish", "Tropical Fish"),
            "hp": b["hp"], "height": b["height"], "width": b["width"],
            "natural_scale": eval_scale(d.get("scripts", {}).get("scale")) * b["bp_scale"],
            "texture": texture, "geometry": geometry, "tw": g["tw"], "th": g["th"], "legacy": g["legacy"],
            "bones": g["bones"], "anims": chosen, "families": b["families"], "baby": False,
        })
        if b["baby"]:
            bb = b["baby"]
            bgeo = next((v for k, v in geo_map.items() if "baby" in k), geometry)
            btex = next((v for k, v in tex.items() if "baby" in k or "ghastling" in k), texture)
            bg = resolve(bgeo) or g
            adult = mobs[-1]
            mobs.append(dict(adult,
                key="baby_" + name, name="Baby " + adult["name"], baby=True,
                hp=bb["hp"] or b["hp"], height=bb["height"], width=bb["width"],
                natural_scale=eval_scale(d.get("scripts", {}).get("scale"), True) * bb["scale"],
                texture=btex, geometry=bgeo if resolve(bgeo) else geometry,
                tw=bg["tw"], th=bg["th"], legacy=bg["legacy"], bones=bg["bones"]))
    return mobs
