// Morph: Shapeshifter — main gameplay script
//
// You are a faceless shapeshifter. Kill a mob and you rip its skin off, absorb it,
// and become that mob — with its body, its hand in first person, and its powers.
//
// Controls (works on touch / mobile):
//   * Use (long-press) the Morph Core           -> use your current form's ability
//   * Sneak + use the Morph Core                 -> open the morph menu (pick any stolen skin)

import { world, system, ItemStack, MolangVariableMap, EntityDamageCause } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

const CORE_ID = "morph:morph_core";
const SKIN_ENTITY = "morph:stolen_skin";
const PROP_FORM = "morph:form";
const PROP_ABSORB = "morph:absorb";
const DP_UNLOCKED = "morph:unlocked";
const DP_AUTO = "morph:auto_morph";

/**
 * Every form the shapeshifter can take. `id` must match the index used by the resource pack
 * render controllers (Array.morph_geo / Array.morph_tex).
 * @type {{id:number,key:string,name:string,mobs:string[],color:{red:number,green:number,blue:number},
 *   passive:string,ability:string,cooldown:number}[]}
 */
const FORMS = [
  {
    id: 0, key: "shapeshifter", name: "Shapeshifter", mobs: [],
    color: { red: 0.6, green: 0.2, blue: 1.0 },
    passive: "No body of your own. Steal one.",
    ability: "Shadow Veil - turn invisible and fast for 8s", cooldown: 400,
  },
  {
    id: 1, key: "zombie", name: "Zombie",
    mobs: ["minecraft:zombie", "minecraft:husk", "minecraft:drowned", "minecraft:zombie_villager", "minecraft:zombie_villager_v2"],
    color: { red: 0.25, green: 0.55, blue: 0.3 },
    passive: "Strength I",
    ability: "Rotting Roar - damage, slow and starve nearby mobs", cooldown: 160,
  },
  {
    id: 2, key: "skeleton", name: "Skeleton",
    mobs: ["minecraft:skeleton", "minecraft:stray", "minecraft:bogged"],
    color: { red: 0.9, green: 0.9, blue: 0.85 },
    passive: "Speed I",
    ability: "Bone Volley - fire 3 arrows", cooldown: 30,
  },
  {
    id: 3, key: "creeper", name: "Creeper", mobs: ["minecraft:creeper"],
    color: { red: 0.25, green: 0.85, blue: 0.3 },
    passive: "Immune to your own blast",
    ability: "Detonate - hiss, then explode", cooldown: 240,
  },
  {
    id: 4, key: "spider", name: "Spider", mobs: ["minecraft:spider", "minecraft:cave_spider"],
    color: { red: 0.5, green: 0.08, blue: 0.08 },
    passive: "Climb walls (walk into them), Night Vision",
    ability: "Web Shot - trap what you look at in cobweb", cooldown: 80,
  },
  {
    id: 5, key: "enderman", name: "Enderman", mobs: ["minecraft:enderman"],
    color: { red: 0.45, green: 0.1, blue: 0.65 },
    passive: "Chance to blink away when hurt",
    ability: "Ender Blink - teleport where you look", cooldown: 30,
  },
  {
    id: 6, key: "blaze", name: "Blaze", mobs: ["minecraft:blaze"],
    color: { red: 1.0, green: 0.7, blue: 0.1 },
    passive: "Fire immunity, slow fall, hold jump to hover",
    ability: "Fireball Barrage - launch 3 fireballs", cooldown: 50,
  },
];

/** mob type id -> form */
const MOB_TO_FORM = new Map();
for (const f of FORMS) for (const m of f.mobs) MOB_TO_FORM.set(m, f);

/** Effects that forms grant; cleared whenever you change shape. */
const PASSIVE_EFFECTS = ["strength", "speed", "night_vision", "fire_resistance", "slow_falling"];

/** Per-player runtime state (not saved). */
const state = new Map();
/** @param {import("@minecraft/server").Player} p */
function st(p) {
  let s = state.get(p.id);
  if (!s) {
    s = { cooldownUntil: 0, animToken: 0, busy: false, lastForm: -1, blinkUntil: 0, fusing: false };
    state.set(p.id, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Run fn, swallow errors (entity unloaded, API differences, etc). */
function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return undefined;
  }
}

/** @param {import("@minecraft/server").Player} p */
function getForm(p) {
  const v = safe(() => p.getProperty(PROP_FORM));
  return typeof v === "number" && FORMS[v] ? v : 0;
}

/** @param {import("@minecraft/server").Player} p */
function getUnlocked(p) {
  const raw = p.getDynamicProperty(DP_UNLOCKED);
  let arr = [];
  if (typeof raw === "string") arr = safe(() => JSON.parse(raw)) ?? [];
  if (!arr.includes(0)) arr.unshift(0);
  return arr.filter((i) => FORMS[i]);
}

/** @param {import("@minecraft/server").Player} p @param {number} id */
function unlock(p, id) {
  const arr = getUnlocked(p);
  const isNew = !arr.includes(id);
  if (isNew) {
    arr.push(id);
    p.setDynamicProperty(DP_UNLOCKED, JSON.stringify(arr));
  }
  return isNew;
}

/** @param {import("@minecraft/server").Player} p */
function autoMorph(p) {
  return p.getDynamicProperty(DP_AUTO) !== false;
}

/** @param {import("@minecraft/server").Player} p @param {string} sound */
function sound(p, sound, pitch = 1, volume = 1) {
  safe(() => p.dimension.playSound(sound, p.location, { pitch, volume }));
}

/** @param {import("@minecraft/server").Dimension} dim */
function particle(dim, id, loc, color) {
  safe(() => {
    const vars = new MolangVariableMap();
    if (color) vars.setColorRGB("variable.color", color);
    dim.spawnParticle(id, loc, vars);
  });
}

/** @param {import("@minecraft/server").Player} p */
function clearPassives(p) {
  for (const e of PASSIVE_EFFECTS) safe(() => p.removeEffect(e));
}

/** @param {import("@minecraft/server").Player} p @param {number} id */
function setForm(p, id) {
  clearPassives(p);
  p.setProperty(PROP_FORM, id);
  st(p).cooldownUntil = 0;
  st(p).lastForm = id;
  applyPassives(p, id);
}

// ---------------------------------------------------------------------------
// The skin-steal / transformation sequence
// ---------------------------------------------------------------------------

/**
 * Full "steal the skin" animation:
 *  1. the dead mob's skin peels off as a ghostly copy of the mob (morph:stolen_skin)
 *  2. it spins, crumples and arcs through the air into the shapeshifter, shedding flakes
 *  3. the shapeshifter levitates, arms spread, shaking, in a purple vortex (player animation)
 *  4. impact: purple flash on screen, particle burst, body swaps to the new form
 *
 * @param {import("@minecraft/server").Player} p
 * @param {(typeof FORMS)[number]} form
 * @param {import("@minecraft/server").Vector3} from where the mob died
 * @param {boolean} becomeIt whether to actually swap into the form at the end
 * @param {boolean} isNew first time this skin was stolen
 */
function stealSkin(p, form, from, becomeIt, isNew) {
  const s = st(p);
  const token = ++s.animToken;
  s.busy = true;
  const dim = p.dimension;
  const DURATION = 32; // ticks the skin takes to fly into you

  safe(() => p.setProperty(PROP_ABSORB, true));
  safe(() => p.addEffect("slowness", DURATION + 10, { amplifier: 3, showParticles: false }));
  sound(p, "mob.endermen.portal", 0.55);
  sound(p, "mob.zombie.unfect", 1.6, 0.6);
  particle(dim, "morph:absorb_spiral", p.location);

  /** @type {import("@minecraft/server").Entity | undefined} */
  const skin = safe(() => dim.spawnEntity(SKIN_ENTITY, add(from, { x: 0, y: 0.1, z: 0 })));
  if (skin) safe(() => skin.setProperty(PROP_FORM, form.id));

  safe(() => p.onScreenDisplay.setActionBar(`§5Tearing the skin off the ${form.name}...`));

  for (let i = 1; i <= DURATION; i++) {
    system.runTimeout(() => {
      if (!p.isValid || s.animToken !== token) return;
      const t = i / DURATION;
      const e = easeInOut(t);
      const target = add(p.location, { x: 0, y: 0.9, z: 0 });
      const pos = add(lerp(from, target, e), { x: 0, y: Math.sin(Math.PI * t) * 1.8, z: 0 });
      if (skin && skin.isValid) safe(() => skin.teleport(pos, { rotation: { x: 0, y: t * 720 } }));
      if (i % 2 === 0) particle(dim, "morph:skin_flake", pos, form.color);
      if (i === Math.floor(DURATION / 2)) sound(p, "mob.endermen.portal", 1.4, 0.8);
    }, i);
  }

  system.runTimeout(() => {
    if (skin && skin.isValid) safe(() => skin.remove());
    if (!p.isValid || s.animToken !== token) return;
    const chest = add(p.location, { x: 0, y: 1, z: 0 });
    particle(dim, "morph:absorb_burst", chest);
    particle(dim, "morph:skin_flake", chest, form.color);
    safe(() =>
      p.camera.fade({
        fadeColor: { red: 0.35, green: 0.05, blue: 0.55 },
        fadeTime: { fadeInTime: 0.1, holdTime: 0.15, fadeOutTime: 0.6 },
      })
    );
    sound(p, "random.levelup", 0.6, 0.8);
    sound(p, "mob.wither.break_block", 1.8, 0.4);
    if (becomeIt) setForm(p, form.id);
    safe(() =>
      p.onScreenDisplay.setTitle(isNew ? "§5§lSKIN STOLEN" : "§5§lSHIFTED", {
        subtitle: becomeIt ? `§dYou are now a ${form.name}` : `§d${form.name} skin added to your collection`,
        fadeInDuration: 4,
        stayDuration: 35,
        fadeOutDuration: 12,
      })
    );
    if (isNew) {
      safe(() => p.sendMessage(`§5[Morph]§r Stole the §d${form.name}§r skin! §7Passive: ${form.passive}. Ability: ${form.ability}.`));
    }
  }, DURATION + 1);

  system.runTimeout(() => {
    if (s.animToken !== token) return;
    s.busy = false;
    if (p.isValid) safe(() => p.setProperty(PROP_ABSORB, false));
  }, DURATION + 18);
}

/**
 * Shorter shift used from the menu (no corpse): the vortex + flash only.
 * @param {import("@minecraft/server").Player} p @param {(typeof FORMS)[number]} form
 */
function quickShift(p, form) {
  const s = st(p);
  const token = ++s.animToken;
  s.busy = true;
  safe(() => p.setProperty(PROP_ABSORB, true));
  particle(p.dimension, "morph:absorb_spiral", p.location);
  sound(p, "mob.endermen.portal", 0.8);
  system.runTimeout(() => {
    if (!p.isValid || s.animToken !== token) return;
    particle(p.dimension, "morph:absorb_burst", add(p.location, { x: 0, y: 1, z: 0 }));
    particle(p.dimension, "morph:skin_flake", add(p.location, { x: 0, y: 1, z: 0 }), form.color);
    safe(() =>
      p.camera.fade({
        fadeColor: { red: 0.35, green: 0.05, blue: 0.55 },
        fadeTime: { fadeInTime: 0.1, holdTime: 0.05, fadeOutTime: 0.4 },
      })
    );
    sound(p, "random.levelup", 1.4, 0.5);
    setForm(p, form.id);
    safe(() => p.onScreenDisplay.setActionBar(`§dYou shift into a ${form.name}`));
  }, 16);
  system.runTimeout(() => {
    if (s.animToken !== token) return;
    s.busy = false;
    if (p.isValid) safe(() => p.setProperty(PROP_ABSORB, false));
  }, 28);
}

// Kill a mob -> steal its skin.
world.afterEvents.entityDie.subscribe((ev) => {
  const killer = ev.damageSource.damagingEntity;
  if (!killer || killer.typeId !== "minecraft:player") return;
  const form = MOB_TO_FORM.get(ev.deadEntity.typeId);
  if (!form) return;
  const p = /** @type {import("@minecraft/server").Player} */ (killer);
  const from = safe(() => ev.deadEntity.location) ?? p.location;
  const isNew = unlock(p, form.id);
  const becomeIt = autoMorph(p) && getForm(p) !== form.id;
  if (!isNew && !becomeIt) {
    // already have it and already are it: small flourish only
    particle(p.dimension, "morph:skin_flake", add(from, { x: 0, y: 0.5, z: 0 }), form.color);
    return;
  }
  stealSkin(p, form, from, becomeIt, isNew);
});

// ---------------------------------------------------------------------------
// Passive abilities
// ---------------------------------------------------------------------------

/** @param {import("@minecraft/server").Player} p @param {number} id */
function applyPassives(p, id) {
  const opts = { amplifier: 0, showParticles: false };
  switch (id) {
    case 1:
      safe(() => p.addEffect("strength", 300, opts));
      break;
    case 2:
      safe(() => p.addEffect("speed", 300, opts));
      break;
    case 4:
      safe(() => p.addEffect("night_vision", 400, opts));
      break;
    case 6:
      safe(() => p.addEffect("fire_resistance", 300, opts));
      break;
  }
}

/** @param {import("@minecraft/server").Block | undefined} b */
function isSolid(b) {
  return !!b && !b.isAir && !b.isLiquid && b.typeId !== "minecraft:web";
}

// Fast loop: wall climbing / hovering need per-tick response.
system.runInterval(() => {
  for (const p of world.getPlayers()) {
    const form = getForm(p);
    if (form === 4) spiderClimb(p);
    else if (form === 6) blazeHover(p);
  }
}, 1);

/** @param {import("@minecraft/server").Player} p */
function spiderClimb(p) {
  const v = p.getViewDirection();
  const len = Math.hypot(v.x, v.z) || 1;
  const dx = v.x / len, dz = v.z / len;
  const loc = p.location;
  const feet = safe(() => p.dimension.getBlock({ x: loc.x + dx * 0.6, y: loc.y + 0.2, z: loc.z + dz * 0.6 }));
  const chest = safe(() => p.dimension.getBlock({ x: loc.x + dx * 0.6, y: loc.y + 1.1, z: loc.z + dz * 0.6 }));
  if (!isSolid(feet) && !isSolid(chest)) return;
  const move = safe(() => p.inputInfo.getMovementVector());
  const pushing = move ? move.y > 0.2 : !p.isSneaking;
  if (p.isSneaking) {
    // cling to the wall
    safe(() => p.addEffect("slow_falling", 3, { amplifier: 0, showParticles: false }));
  } else if (pushing) {
    safe(() => p.addEffect("levitation", 3, { amplifier: 3, showParticles: false }));
  }
}

/** @param {import("@minecraft/server").Player} p */
function blazeHover(p) {
  if (p.isJumping && !p.isOnGround) {
    safe(() => p.addEffect("levitation", 3, { amplifier: 1, showParticles: false }));
    if (system.currentTick % 3 === 0) particle(p.dimension, "minecraft:basic_flame_particle", p.location);
  } else if (!p.isOnGround && !p.isSneaking) {
    safe(() => p.addEffect("slow_falling", 3, { amplifier: 0, showParticles: false }));
  }
}

// Slow loop: keep passives up, sanity-check state, show HUD.
system.runInterval(() => {
  for (const p of world.getPlayers()) {
    const form = getForm(p);
    const s = st(p);
    if (s.lastForm !== form) {
      clearPassives(p);
      s.lastForm = form;
    }
    applyPassives(p, form);
    if (!s.busy && safe(() => p.getProperty(PROP_ABSORB)) === true) safe(() => p.setProperty(PROP_ABSORB, false));

    const held = safe(() => p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex));
    if (held && held.typeId === CORE_ID && !s.busy) {
      const left = Math.max(0, s.cooldownUntil - system.currentTick);
      const status = left > 0 ? `§c${(left / 20).toFixed(1)}s` : "§aREADY";
      safe(() => p.onScreenDisplay.setActionBar(`§5${FORMS[form].name} §8| §7Ability: ${status} §8| §7Sneak+use: menu`));
    }
  }
}, 20);

// Enderman passive: chance to blink away when hurt.
world.afterEvents.entityHurt.subscribe((ev) => {
  const p = ev.hurtEntity;
  if (p.typeId !== "minecraft:player") return;
  const pl = /** @type {import("@minecraft/server").Player} */ (p);
  if (getForm(pl) !== 5) return;
  const s = st(pl);
  if (system.currentTick < s.blinkUntil || Math.random() > 0.35) return;
  s.blinkUntil = system.currentTick + 60;
  system.run(() => randomBlink(pl));
}, { entityTypes: ["minecraft:player"] });

/** @param {import("@minecraft/server").Player} p */
function randomBlink(p) {
  const dim = p.dimension;
  for (let tries = 0; tries < 16; tries++) {
    const ang = Math.random() * Math.PI * 2;
    const r = 4 + Math.random() * 6;
    const x = Math.floor(p.location.x + Math.cos(ang) * r) + 0.5;
    const z = Math.floor(p.location.z + Math.sin(ang) * r) + 0.5;
    for (let dy = 4; dy >= -4; dy--) {
      const y = Math.floor(p.location.y) + dy;
      const below = safe(() => dim.getBlock({ x, y: y - 1, z }));
      const at = safe(() => dim.getBlock({ x, y, z }));
      const above = safe(() => dim.getBlock({ x, y: y + 1, z }));
      if (isSolid(below) && at?.isAir && above?.isAir) {
        particle(dim, "morph:absorb_burst", add(p.location, { x: 0, y: 1, z: 0 }));
        safe(() => p.teleport({ x, y, z }));
        sound(p, "mob.endermen.portal", 1.0);
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Active abilities (use the Morph Core)
// ---------------------------------------------------------------------------

/** @param {import("@minecraft/server").Player} p */
function useAbility(p) {
  const s = st(p);
  if (s.busy) return;
  const form = FORMS[getForm(p)];
  const left = s.cooldownUntil - system.currentTick;
  if (left > 0) {
    safe(() => p.onScreenDisplay.setActionBar(`§c${form.name} ability recharging: ${(left / 20).toFixed(1)}s`));
    return;
  }
  const ok = ABILITIES[form.id](p);
  if (ok !== false) s.cooldownUntil = system.currentTick + form.cooldown;
}

/** @type {((p: import("@minecraft/server").Player) => boolean | void)[]} */
const ABILITIES = [
  // 0 Shapeshifter: Shadow Veil
  (p) => {
    safe(() => p.addEffect("invisibility", 160, { amplifier: 0, showParticles: false }));
    safe(() => p.addEffect("speed", 160, { amplifier: 1, showParticles: false }));
    particle(p.dimension, "morph:absorb_burst", add(p.location, { x: 0, y: 1, z: 0 }));
    sound(p, "mob.endermen.portal", 0.5);
    safe(() => p.onScreenDisplay.setActionBar("§5You dissolve into shadow..."));
  },
  // 1 Zombie: Rotting Roar
  (p) => {
    sound(p, "mob.zombie.say", 0.6, 1.5);
    sound(p, "mob.ravager.roar", 1.4, 0.6);
    particle(p.dimension, "morph:skin_flake", add(p.location, { x: 0, y: 1, z: 0 }), FORMS[1].color);
    const targets = p.dimension.getEntities({ location: p.location, maxDistance: 5, excludeTypes: ["minecraft:player", "minecraft:item", SKIN_ENTITY] });
    for (const t of targets) {
      safe(() => t.applyDamage(5, { cause: EntityDamageCause.entityAttack, damagingEntity: p }));
      safe(() => t.addEffect("slowness", 100, { amplifier: 1 }));
      safe(() => t.addEffect("hunger", 200, { amplifier: 1 }));
      particle(p.dimension, "morph:skin_flake", add(t.location, { x: 0, y: 1, z: 0 }), FORMS[1].color);
    }
  },
  // 2 Skeleton: Bone Volley
  (p) => {
    const dir = p.getViewDirection();
    const right = { x: -dir.z, y: 0, z: dir.x };
    [-0.12, 0, 0.12].forEach((spread, i) => {
      system.runTimeout(() => {
        if (!p.isValid) return;
        const d = add(dir, scale(right, spread));
        shoot(p, "minecraft:arrow", add(p.getHeadLocation(), scale(d, 1.2)), scale(d, 2.8));
        sound(p, "random.bow", 1 + i * 0.1);
      }, i * 3);
    });
  },
  // 3 Creeper: Detonate
  (p) => {
    const s = st(p);
    if (s.fusing) return false;
    s.fusing = true;
    sound(p, "random.fuse", 1);
    safe(() => p.onScreenDisplay.setActionBar("§aSsssss..."));
    for (let i = 0; i < 30; i += 5) {
      system.runTimeout(() => p.isValid && particle(p.dimension, "morph:skin_flake", add(p.location, { x: 0, y: 1, z: 0 }), { red: 1, green: 1, blue: 1 }), i);
    }
    system.runTimeout(() => {
      s.fusing = false;
      if (!p.isValid || getForm(p) !== 3) return;
      safe(() => p.addEffect("resistance", 30, { amplifier: 4, showParticles: false }));
      system.run(() => {
        safe(() => p.dimension.createExplosion(p.location, 4, { source: p, breaksBlocks: true, causesFire: false }));
      });
    }, 30);
  },
  // 4 Spider: Web Shot
  (p) => {
    const dim = p.dimension;
    let spot;
    const hit = safe(() => p.getEntitiesFromViewDirection({ maxDistance: 24 }))?.find((h) => h.entity.typeId !== SKIN_ENTITY);
    if (hit) spot = hit.entity.location;
    else {
      const bh = safe(() => p.getBlockFromViewDirection({ maxDistance: 24 }));
      if (bh) {
        const f = bh.face;
        const off = { Up: [0, 1, 0], Down: [0, -1, 0], North: [0, 0, -1], South: [0, 0, 1], East: [1, 0, 0], West: [-1, 0, 0] }[f] ?? [0, 1, 0];
        spot = { x: bh.block.location.x + off[0], y: bh.block.location.y + off[1], z: bh.block.location.z + off[2] };
      }
    }
    if (!spot) return false;
    sound(p, "mob.spider.say", 1.2);
    const base = { x: Math.floor(spot.x), y: Math.floor(spot.y), z: Math.floor(spot.z) };
    const placed = [];
    for (const o of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const loc = { x: base.x + o[0], y: base.y + o[1], z: base.z + o[2] };
      const b = safe(() => dim.getBlock(loc));
      if (b && b.isAir) {
        safe(() => b.setType("minecraft:web"));
        placed.push(loc);
      }
    }
    // trail of white flakes from you to the target
    const from = p.getHeadLocation();
    for (let i = 1; i <= 8; i++) particle(dim, "morph:skin_flake", lerp(from, add(base, { x: 0.5, y: 0.5, z: 0.5 }), i / 8), { red: 1, green: 1, blue: 1 });
    system.runTimeout(() => {
      for (const loc of placed) {
        const b = safe(() => dim.getBlock(loc));
        if (b && (b.typeId === "minecraft:web" || b.typeId === "minecraft:cobweb")) safe(() => b.setType("minecraft:air"));
      }
    }, 200);
  },
  // 5 Enderman: Ender Blink
  (p) => {
    const bh = safe(() => p.getBlockFromViewDirection({ maxDistance: 48 }));
    if (!bh) {
      safe(() => p.onScreenDisplay.setActionBar("§7Nothing to blink to."));
      return false;
    }
    const b = bh.block.location;
    const dim = p.dimension;
    let dest;
    for (let dy = 1; dy <= 3 && !dest; dy++) {
      const a = safe(() => dim.getBlock({ x: b.x, y: b.y + dy, z: b.z }));
      const a2 = safe(() => dim.getBlock({ x: b.x, y: b.y + dy + 1, z: b.z }));
      if (a?.isAir && a2?.isAir) dest = { x: b.x + 0.5, y: b.y + dy, z: b.z + 0.5 };
    }
    if (!dest) return false;
    particle(dim, "morph:absorb_burst", add(p.location, { x: 0, y: 1, z: 0 }));
    sound(p, "mob.endermen.portal", 1);
    safe(() => p.teleport(dest));
    system.run(() => {
      particle(dim, "morph:absorb_burst", add(dest, { x: 0, y: 1, z: 0 }));
      sound(p, "mob.endermen.portal", 1.2);
    });
  },
  // 6 Blaze: Fireball Barrage
  (p) => {
    for (let i = 0; i < 3; i++) {
      system.runTimeout(() => {
        if (!p.isValid) return;
        const d = p.getViewDirection();
        shoot(p, "minecraft:small_fireball", add(p.getHeadLocation(), scale(d, 1.4)), scale(d, 1.6));
        sound(p, "mob.blaze.shoot", 1 + i * 0.1);
      }, i * 4);
    }
  },
];

/**
 * @param {import("@minecraft/server").Player} p
 * @param {string} type
 * @param {import("@minecraft/server").Vector3} at
 * @param {import("@minecraft/server").Vector3} velocity
 */
function shoot(p, type, at, velocity) {
  const e = safe(() => p.dimension.spawnEntity(type, at));
  if (!e) return;
  const proj = safe(() => e.getComponent("minecraft:projectile"));
  if (proj) {
    safe(() => {
      proj.owner = p;
    });
    safe(() => proj.shoot(velocity));
  } else {
    safe(() => e.applyImpulse(velocity));
  }
}

// ---------------------------------------------------------------------------
// Morph menu
// ---------------------------------------------------------------------------

/** @param {import("@minecraft/server").Player} p */
function openMenu(p) {
  const unlocked = getUnlocked(p);
  const current = getForm(p);
  const form = new ActionFormData()
    .title("§5Morph")
    .body(`§7You are: §d${FORMS[current].name}\n§7Stolen skins: §f${unlocked.length - 1}/${FORMS.length - 1}\n§7Kill a mob to steal its skin.`);
  /** @type {(() => void)[]} */
  const actions = [];
  for (const f of FORMS) {
    const have = unlocked.includes(f.id);
    const label = have
      ? `${f.id === current ? "§2> " : "§0"}${f.name}\n§8${f.ability.split(" - ")[0]}`
      : `§8??? (${f.name})\n§8Kill one to unlock`;
    form.button(label);
    actions.push(() => {
      if (!have) {
        safe(() => p.sendMessage(`§5[Morph]§r Kill a §d${f.name}§r to steal its skin.`));
        return;
      }
      if (f.id === current) return;
      quickShift(p, f);
    });
  }
  form.button(`§0Auto-morph on kill: ${autoMorph(p) ? "§2ON" : "§4OFF"}`);
  actions.push(() => {
    p.setDynamicProperty(DP_AUTO, !autoMorph(p));
    safe(() => p.sendMessage(`§5[Morph]§r Auto-morph on kill is now ${autoMorph(p) ? "§aON" : "§cOFF"}§r.`));
  });
  form.button("§0Form info");
  actions.push(() => {
    const f = FORMS[getForm(p)];
    safe(() => p.sendMessage(`§5[Morph] §d${f.name}§r\n§7Passive: §f${f.passive}\n§7Ability: §f${f.ability}`));
  });

  form.show(p).then((res) => {
    if (res.canceled || res.selection === undefined) return;
    actions[res.selection]?.();
  });
}

world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack.typeId !== CORE_ID) return;
  const p = ev.source;
  if (p.isSneaking) system.run(() => openMenu(p));
  else useAbility(p);
});

// Fallback for anyone who prefers commands: /scriptevent morph:menu
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const p = ev.sourceEntity;
  if (!p || p.typeId !== "minecraft:player") return;
  const pl = /** @type {import("@minecraft/server").Player} */ (p);
  if (ev.id === "morph:menu") openMenu(pl);
  if (ev.id === "morph:unlock_all") {
    for (const f of FORMS) unlock(pl, f.id);
    safe(() => pl.sendMessage("§5[Morph]§r All skins unlocked."));
  }
});

// ---------------------------------------------------------------------------
// Joining: hand out the Morph Core, restore state
// ---------------------------------------------------------------------------

/** @param {import("@minecraft/server").Player} p */
function ensureCore(p) {
  const inv = safe(() => p.getComponent("minecraft:inventory")?.container);
  if (!inv) return;
  for (let i = 0; i < inv.size; i++) {
    if (inv.getItem(i)?.typeId === CORE_ID) return;
  }
  const item = new ItemStack(CORE_ID, 1);
  item.setLore(["§7Use: form ability", "§7Sneak + use: morph menu"]);
  safe(() => inv.addItem(item));
}

world.afterEvents.playerSpawn.subscribe((ev) => {
  const p = ev.player;
  system.runTimeout(() => {
    if (!p.isValid) return;
    ensureCore(p);
    safe(() => p.setProperty(PROP_ABSORB, false));
    if (ev.initialSpawn) {
      const form = FORMS[getForm(p)];
      safe(() =>
        p.onScreenDisplay.setTitle("§5§lSHAPESHIFTER", {
          subtitle: form.id === 0 ? "§dYou have no body. Kill a mob to steal one." : `§dWearing: ${form.name}`,
          fadeInDuration: 10,
          stayDuration: 60,
          fadeOutDuration: 20,
        })
      );
    }
  }, 20);
});

world.afterEvents.playerLeave.subscribe((ev) => state.delete(ev.playerId));
