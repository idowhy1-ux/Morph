// Morph: Shapeshifter — main gameplay script
//
// You are a faceless shapeshifter. The ONLY way to change shape is to kill a mob:
// you rip its skin off, absorb it, and become it — its body, its health, its eye
// height, its hand in first person, and its powers. Die, and you lose the stolen body.
//
// Controls (touch friendly):
//   * Use (long-press) the Morph Core          -> your form's ability
//   * Sneak + use the Morph Core                -> form info
//
// Camera height: Bedrock hard-codes the player's eye height, so for any mob whose eyes are not at
// player height you ride an invisible, mob-sized "body" (morph:body). Its seat is placed so your real
// vanilla camera (first AND third person) sits exactly at the mob's eye height, and the body's hitbox
// is the mob's size. You steer it like walking; jump/fly/climb/swim go through the body.

import { world, system, ItemStack, MolangVariableMap, EntityDamageCause, InputButton, ButtonState } from "@minecraft/server";
import { FORM_DATA, SEAT } from "./forms_data.js";

const CORE_ID = "morph:morph_core";
const SKIN_ENTITY = "morph:stolen_skin";
const P_FORM = "morph:form";
const P_ABSORB = "morph:absorb";
const P_R = "morph:r";
const P_RIDE = "morph:ride_off";
const BODY_ID = "morph:body";
const DP_K = "morph:seat_k"; // world: measured (head height - seat height) for a rider
const DP_DIED = "morph:died";
const PLAYER_EYE = 1.62;

/** @typedef {{id:number,type:string|null,key:string,name:string,hp:number,eye:number,height:number,width:number,size:string,r:number,families:string[]}} Form */
/** @type {Form[]} */
const FORMS = FORM_DATA;
const FORM_BY_TYPE = new Map();
for (const f of FORMS) if (f.type) FORM_BY_TYPE.set(f.type, f);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const up = (a, y) => ({ x: a.x, y: a.y + y, z: a.z });
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return undefined;
  }
}

/** A stable colour per form for the skin flakes. */
function formColor(f) {
  if (f.id === 0) return { red: 0.6, green: 0.2, blue: 1 };
  let h = 0;
  for (const c of f.key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = (h % 360) / 60;
  const x = 1 - Math.abs((hue % 2) - 1);
  const [r, g, b] = hue < 1 ? [1, x, 0] : hue < 2 ? [x, 1, 0] : hue < 3 ? [0, 1, x] : hue < 4 ? [0, x, 1] : hue < 5 ? [x, 0, 1] : [1, 0, x];
  return { red: 0.25 + r * 0.75, green: 0.25 + g * 0.75, blue: 0.25 + b * 0.75 };
}

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

/** @param {import("@minecraft/server").Player} p */
function getForm(p) {
  const v = safe(() => p.getProperty(P_FORM));
  return typeof v === "number" && FORMS[v] ? FORMS[v] : FORMS[0];
}

function sound(p, id, pitch = 1, volume = 1) {
  safe(() => p.dimension.playSound(id, p.location, { pitch, volume }));
}

function particle(dim, id, loc, color) {
  safe(() => {
    const vars = new MolangVariableMap();
    if (color) vars.setColorRGB("variable.color", color);
    dim.spawnParticle(id, loc, vars);
  });
}

function bar(p, text) {
  safe(() => p.onScreenDisplay.setActionBar(text));
}

/** Mobs near p, excluding p and morph helper entities. */
function nearby(p, radius, players = false) {
  const opts = { location: feet(p), maxDistance: radius, excludeTypes: ["minecraft:item", "minecraft:xp_orb", SKIN_ENTITY] };
  return (safe(() => p.dimension.getEntities(opts)) ?? []).filter(
    (e) => e.id !== p.id && (players || e.typeId !== "minecraft:player") && safe(() => e.getComponent("minecraft:health"))
  );
}

function hurt(p, e, amount, cause = EntityDamageCause.entityAttack) {
  return safe(() => e.applyDamage(amount, { cause, damagingEntity: p }));
}

function lookTarget(p, range = 24) {
  const hits = safe(() => p.getEntitiesFromViewDirection({ maxDistance: range })) ?? [];
  return hits.map((h) => h.entity).find((e) => e.typeId !== SKIN_ENTITY && e.typeId !== "minecraft:item");
}

function shoot(p, type, speed, spread = 0, at) {
  const d = p.getViewDirection();
  const right = { x: -d.z, y: 0, z: d.x };
  const dir = add(d, scale(right, spread));
  const from = at ?? add(p.getHeadLocation(), scale(dir, 1.3));
  const e = safe(() => p.dimension.spawnEntity(type, from));
  if (!e) return undefined;
  const proj = safe(() => e.getComponent("minecraft:projectile"));
  if (proj) {
    safe(() => {
      proj.owner = p;
    });
    safe(() => proj.shoot(scale(dir, speed)));
  } else safe(() => e.applyImpulse(scale(dir, speed)));
  return e;
}

/** Push the player along where they look. */
function dash(p, power, vertical = 0.25) {
  const d = p.getViewDirection();
  const len = Math.hypot(d.x, d.z) || 1;
  push(p, (d.x / len) * power, (d.z / len) * power, vertical);
}

/** Knock the player (or the body they ride) around. */
function push(p, x, z, y) {
  const b = ridingBody(p);
  if (b) safe(() => b.applyImpulse({ x: x * 0.5, y: y * 0.9, z: z * 0.5 }));
  else safe(() => p.applyKnockback({ x, z }, y));
}

/** Where the player's feet really are (the body's feet when riding one). */
function feet(p) {
  return ridingBody(p)?.location ?? p.location;
}

// ---------------------------------------------------------------------------
// Abilities. Each entry: label, cooldown (ticks), run(player) -> false to refund
// ---------------------------------------------------------------------------
const AB = {
  veil: { label: "Shadow Veil", cd: 400, run: (p) => {
    safe(() => p.addEffect("invisibility", 160, { showParticles: false }));
    safe(() => p.addEffect("speed", 160, { amplifier: 1, showParticles: false }));
    particle(p.dimension, "morph:absorb_burst", up(p.location, 1));
  } },
  roar: { label: "Rotting Roar", cd: 160, run: (p) => {
    sound(p, "mob.zombie.say", 0.6, 1.5);
    for (const e of nearby(p, 5)) {
      hurt(p, e, 5);
      safe(() => e.addEffect("slowness", 100, { amplifier: 1 }));
      safe(() => e.addEffect("hunger", 200, { amplifier: 1 }));
    }
    particle(p.dimension, "morph:skin_flake", up(p.location, 1), { red: 0.3, green: 0.6, blue: 0.3 });
  } },
  ravage: { label: "Ravaging Roar", cd: 200, run: (p) => {
    sound(p, "mob.ravager.roar", 1, 2);
    for (const e of nearby(p, 6)) {
      hurt(p, e, 8);
      const v = { x: e.location.x - p.location.x, z: e.location.z - p.location.z };
      const l = Math.hypot(v.x, v.z) || 1;
      safe(() => e.applyKnockback({ x: (v.x / l) * 2.5, z: (v.z / l) * 2.5 }, 0.6));
    }
    particle(p.dimension, "morph:absorb_burst", up(p.location, 1));
  } },
  toss: { label: "Iron Toss", cd: 100, run: (p) => {
    sound(p, "mob.irongolem.throw", 1);
    for (const e of nearby(p, 4)) {
      hurt(p, e, 10);
      safe(() => e.applyKnockback({ x: 0, z: 0 }, 1.4));
    }
  } },
  arrows: { label: "Bone Volley", cd: 30, run: (p) => {
    [-0.12, 0, 0.12].forEach((s, i) => system.runTimeout(() => p.isValid && (shoot(p, "minecraft:arrow", 2.8, s), sound(p, "random.bow", 1 + i * 0.1)), i * 3));
  } },
  crossbow: { label: "Crossbow Bolt", cd: 25, run: (p) => {
    shoot(p, "minecraft:arrow", 3.6);
    sound(p, "crossbow.shoot", 1);
  } },
  witherStrike: { label: "Wither Strike", cd: 60, run: (p) => {
    const t = lookTarget(p, 5);
    if (!t) return false;
    hurt(p, t, 8);
    safe(() => t.addEffect("wither", 200, { amplifier: 1 }));
    sound(p, "mob.wither.hurt", 1.5);
  } },
  explode: { label: "Detonate", cd: 240, run: (p) => {
    const s = st(p);
    if (s.fusing) return false;
    s.fusing = true;
    sound(p, "random.fuse", 1);
    bar(p, "§aSsssss...");
    system.runTimeout(() => {
      s.fusing = false;
      if (!p.isValid) return;
      safe(() => p.addEffect("resistance", 30, { amplifier: 4, showParticles: false }));
      system.run(() => safe(() => p.dimension.createExplosion(feet(p), 4, { source: p, breaksBlocks: true, causesFire: false })));
    }, 30);
  } },
  web: { label: "Web Shot", cd: 80, run: (p) => {
    const t = lookTarget(p, 24);
    let spot = t?.location;
    if (!spot) {
      const bh = safe(() => p.getBlockFromViewDirection({ maxDistance: 24 }));
      if (bh) spot = up(bh.block.location, 1);
    }
    if (!spot) return false;
    const base = { x: Math.floor(spot.x), y: Math.floor(spot.y), z: Math.floor(spot.z) };
    const placed = [];
    for (const o of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const loc = { x: base.x + o[0], y: base.y + o[1], z: base.z + o[2] };
      const b = safe(() => p.dimension.getBlock(loc));
      if (b && b.isAir) {
        safe(() => b.setType("minecraft:web"));
        placed.push(loc);
      }
    }
    if (t && getForm(p).key === "cave_spider") safe(() => t.addEffect("poison", 140, { amplifier: 1 }));
    sound(p, "mob.spider.say", 1.2);
    system.runTimeout(() => {
      for (const loc of placed) {
        const b = safe(() => p.dimension.getBlock(loc));
        if (b?.typeId === "minecraft:web") safe(() => b.setType("minecraft:air"));
      }
    }, 200);
  } },
  blink: { label: "Ender Blink", cd: 30, run: (p) => blinkTo(p, 48) },
  miteBlink: { label: "Mite Hop", cd: 60, run: (p) => blinkTo(p, 10) },
  smallFire: { label: "Fireball Barrage", cd: 50, run: (p) => {
    for (let i = 0; i < 3; i++) system.runTimeout(() => p.isValid && (shoot(p, "minecraft:small_fireball", 1.6), sound(p, "mob.blaze.shoot", 1)), i * 4);
  } },
  bigFire: { label: "Ghast Fireball", cd: 60, run: (p) => {
    shoot(p, "minecraft:fireball", 1.2);
    sound(p, "mob.ghast.fireball", 1);
  } },
  skulls: { label: "Wither Skulls", cd: 40, run: (p) => {
    [-0.15, 0, 0.15].forEach((s, i) => system.runTimeout(() => p.isValid && (shoot(p, "minecraft:wither_skull", 1.5, s), sound(p, "mob.wither.shoot", 1)), i * 4));
  } },
  dragon: { label: "Dragon Breath", cd: 80, run: (p) => {
    shoot(p, "minecraft:dragon_fireball", 1.4);
    sound(p, "mob.enderdragon.growl", 1);
  } },
  wind: { label: "Wind Charge", cd: 30, run: (p) => {
    shoot(p, "minecraft:breeze_wind_charge_projectile", 1.5) ?? shoot(p, "minecraft:wind_charge_projectile", 1.5);
    sound(p, "mob.breeze.shoot", 1);
  } },
  spit: { label: "Spit", cd: 30, run: (p) => {
    shoot(p, "minecraft:llama_spit", 1.5);
    sound(p, "mob.llama.spit", 1);
  } },
  snow: { label: "Snowball Storm", cd: 30, run: (p) => {
    for (let i = 0; i < 6; i++) system.runTimeout(() => p.isValid && shoot(p, "minecraft:snowball", 1.6, (Math.random() - 0.5) * 0.2), i * 2);
  } },
  egg: { label: "Lay Egg", cd: 100, run: (p) => {
    shoot(p, "minecraft:egg", 1.2);
    sound(p, "mob.chicken.plop", 1);
  } },
  sonic: { label: "Sonic Boom", cd: 200, run: (p) => {
    const d = p.getViewDirection();
    const from = p.getHeadLocation();
    for (let i = 1; i <= 15; i++) particle(p.dimension, "minecraft:sonic_explosion", add(from, scale(d, i)));
    sound(p, "mob.warden.sonic_boom", 1, 2);
    const hit = safe(() => p.getEntitiesFromViewDirection({ maxDistance: 15 })) ?? [];
    for (const h of hit) hurt(p, h.entity, 10, EntityDamageCause.sonicBoom);
    for (const e of nearby(p, 12)) safe(() => e.addEffect("darkness", 120));
  } },
  fangs: { label: "Evoker Fangs", cd: 100, run: (p) => {
    const d = p.getViewDirection();
    const len = Math.hypot(d.x, d.z) || 1;
    for (let i = 2; i < 14; i++) {
      system.runTimeout(() => {
        if (!p.isValid) return;
        const f0 = feet(p);
        const at = { x: f0.x + (d.x / len) * i, y: f0.y, z: f0.z + (d.z / len) * i };
        safe(() => p.dimension.spawnEntity("minecraft:evocation_fang", at));
      }, i);
    }
    sound(p, "mob.evocation_illager.cast_spell", 1);
  } },
  potion: { label: "Hex Brew", cd: 120, run: (p) => {
    const t = lookTarget(p, 16);
    for (const e of t ? [t] : nearby(p, 5)) {
      safe(() => e.addEffect("poison", 120, { amplifier: 1 }));
      safe(() => e.addEffect("slowness", 120, { amplifier: 1 }));
      safe(() => e.addEffect("weakness", 120));
    }
    safe(() => p.addEffect("regeneration", 100, { amplifier: 1 }));
    sound(p, "mob.witch.throw", 1);
  } },
  lunge: { label: "Pounce", cd: 40, run: (p) => {
    dash(p, 2.2, 0.45);
    sound(p, "mob.wolf.bark", 1);
    system.runTimeout(() => p.isValid && nearby(p, 2.5).forEach((e) => hurt(p, e, 6)), 6);
  } },
  ram: { label: "Ram", cd: 60, run: (p) => {
    dash(p, 3, 0.1);
    sound(p, "mob.goat.ram_impact", 1);
    system.runTimeout(() => {
      if (!p.isValid) return;
      const d = p.getViewDirection();
      for (const e of nearby(p, 2.5)) {
        hurt(p, e, 7);
        safe(() => e.applyKnockback({ x: d.x * 3, z: d.z * 3 }, 0.6));
      }
    }, 6);
  } },
  leap: { label: "Super Leap", cd: 40, run: (p) => {
    push(p, 0, 0, 1.6);
    safe(() => p.addEffect("slow_falling", 60, { showParticles: false }));
    sound(p, "mob.slime.big", 1);
  } },
  gallop: { label: "Gallop", cd: 100, run: (p) => {
    safe(() => p.addEffect("speed", 160, { amplifier: 3, showParticles: false }));
    safe(() => p.addEffect("jump_boost", 160, { amplifier: 2, showParticles: false }));
    sound(p, "mob.horse.angry", 1);
  } },
  ink: { label: "Ink Cloud", cd: 100, run: (p) => {
    for (const e of nearby(p, 6, true)) safe(() => e.addEffect("blindness", 100));
    safe(() => p.addEffect("speed", 60, { amplifier: 2, showParticles: false }));
    particle(p.dimension, "morph:skin_flake", up(p.location, 0.5), { red: 0.05, green: 0.05, blue: 0.1 });
    sound(p, "mob.squid.ink_squirt", 1);
  } },
  laser: { label: "Guardian Beam", cd: 60, run: (p) => {
    const t = lookTarget(p, 16);
    if (!t) return false;
    const from = p.getHeadLocation();
    for (let i = 1; i <= 10; i++) particle(p.dimension, "morph:skin_flake", lerp(from, up(t.location, 1), i / 10), { red: 0.4, green: 1, blue: 0.9 });
    hurt(p, t, getForm(p).key === "elder_guardian" ? 10 : 6, EntityDamageCause.magic);
    if (getForm(p).key === "elder_guardian") for (const e of nearby(p, 12, true)) safe(() => e.addEffect("mining_fatigue", 600, { amplifier: 2 }));
    sound(p, "mob.guardian.attack_loop", 1);
  } },
  sting: { label: "Sting", cd: 60, run: (p) => {
    const t = lookTarget(p, 4);
    if (!t) return false;
    hurt(p, t, 3);
    safe(() => t.addEffect("poison", 200));
    sound(p, "mob.bee.sting", 1);
  } },
  milk: { label: "Fresh Milk", cd: 300, run: (p) => {
    for (const e of ["poison", "wither", "slowness", "weakness", "hunger", "nausea", "blindness", "mining_fatigue", "darkness", "levitation"]) safe(() => p.removeEffect(e));
    safe(() => p.addEffect("saturation", 20, { amplifier: 2, showParticles: false }));
    sound(p, "mob.cow.milk", 1);
  } },
  graze: { label: "Graze", cd: 200, run: (p) => {
    safe(() => p.addEffect("saturation", 20, { amplifier: 3, showParticles: false }));
    safe(() => p.addEffect("regeneration", 100, { amplifier: 1 }));
    sound(p, "mob.sheep.say", 1);
  } },
  dig: { label: "Sniff Out Seeds", cd: 400, run: (p) => {
    safe(() => p.dimension.spawnItem(new ItemStack(Math.random() < 0.5 ? "minecraft:torchflower_seeds" : "minecraft:pitcher_pod", 1), feet(p)));
    sound(p, "mob.sniffer.digging", 1);
  } },
  shell: { label: "Shell Up", cd: 300, run: (p) => {
    safe(() => p.addEffect("resistance", 120, { amplifier: 3 }));
    safe(() => p.addEffect("slowness", 120, { amplifier: 3, showParticles: false }));
    sound(p, "mob.armadillo.roll", 1);
  } },
  hero: { label: "Village Spirit", cd: 1200, run: (p) => {
    safe(() => p.addEffect("village_hero", 1200));
    safe(() => p.addEffect("regeneration", 100));
    sound(p, "mob.villager.yes", 1);
  } },
  vanish: { label: "Vanish", cd: 600, run: (p) => {
    safe(() => p.addEffect("invisibility", 400, { showParticles: false }));
    sound(p, "mob.wanderingtrader.drink_potion", 1);
  } },
  swoop: { label: "Swoop", cd: 40, run: (p) => {
    const d = p.getViewDirection();
    push(p, d.x * 2.5, d.z * 2.5, d.y * 1.2 + 0.2);
    system.runTimeout(() => p.isValid && nearby(p, 2.5).forEach((e) => hurt(p, e, 5)), 8);
    sound(p, "mob.phantom.swoop", 1);
  } },
  collect: { label: "Collect Items", cd: 100, run: (p) => {
    const items = safe(() => p.dimension.getEntities({ location: p.location, maxDistance: 16, type: "minecraft:item" })) ?? [];
    for (const it of items) safe(() => it.teleport(feet(p)));
    sound(p, "mob.allay.item_given", 1);
    if (!items.length) return false;
  } },
  heat: { label: "Heat Wave", cd: 120, run: (p) => {
    for (const e of nearby(p, 5)) safe(() => e.setOnFire(5, true));
    particle(p.dimension, "minecraft:basic_flame_particle", up(p.location, 1));
    sound(p, "mob.blaze.breathe", 1);
  } },
  puff: { label: "Puff Up", cd: 100, run: (p) => {
    for (const e of nearby(p, 3, true)) safe(() => e.addEffect("poison", 120, { amplifier: 1 }));
    sound(p, "mob.pufferfish.blow_up", 1);
  } },
  swimDash: { label: "Torpedo", cd: 30, run: (p) => {
    const d = p.getViewDirection();
    push(p, d.x * 2.5, d.z * 2.5, d.y * 1.5);
    sound(p, "mob.dolphin.attack", 1);
  } },
  healAura: { label: "Soothing Aura", cd: 300, run: (p) => {
    for (const e of [p, ...nearby(p, 8, true).filter((e) => e.typeId === "minecraft:player")]) safe(() => e.addEffect("regeneration", 160, { amplifier: 1 }));
    sound(p, "mob.ghast.affectionate_scream", 1);
  } },
  frenzy: { label: "Frenzy", cd: 300, run: (p) => {
    safe(() => p.addEffect("strength", 160, { amplifier: 2 }));
    safe(() => p.addEffect("speed", 160, { amplifier: 1 }));
    sound(p, "mob.vindicator.celebrate", 1);
  } },
  shulker: { label: "Levitation Bullet", cd: 80, run: (p) => {
    const t = lookTarget(p, 24);
    if (!t) return false;
    safe(() => t.addEffect("levitation", 100));
    hurt(p, t, 4);
    sound(p, "mob.shulker.shoot", 1);
  } },
  vex: { label: "Vex Charge", cd: 40, run: (p) => {
    const d = p.getViewDirection();
    push(p, d.x * 3, d.z * 3, d.y * 2);
    system.runTimeout(() => p.isValid && nearby(p, 2.5).forEach((e) => hurt(p, e, 7)), 6);
    sound(p, "mob.vex.charge", 1);
  } },
  barter: { label: "Battle Cry", cd: 200, run: (p) => {
    safe(() => p.addEffect("strength", 200, { amplifier: 1 }));
    sound(p, "mob.piglin.angry", 1);
  } },
  tongue: { label: "Tongue Snatch", cd: 60, run: (p) => {
    const t = lookTarget(p, 8);
    if (!t) return false;
    safe(() => t.teleport(add(feet(p), scale(p.getViewDirection(), 1.2))));
    hurt(p, t, 4);
    sound(p, "mob.frog.tongue", 1);
  } },
  hiss: { label: "Hiss", cd: 100, run: (p) => {
    for (const e of nearby(p, 8)) {
      if (e.typeId === "minecraft:creeper" || e.typeId === "minecraft:phantom") {
        const v = { x: e.location.x - p.location.x, z: e.location.z - p.location.z };
        const l = Math.hypot(v.x, v.z) || 1;
        safe(() => e.applyKnockback({ x: (v.x / l) * 2, z: (v.z / l) * 2 }, 0.4));
      }
    }
    safe(() => p.addEffect("speed", 100, { amplifier: 2, showParticles: false }));
    sound(p, "mob.cat.hiss", 1);
  } },
};

/** @param {import("@minecraft/server").Player} p @param {number} range */
function blinkTo(p, range) {
  const bh = safe(() => p.getBlockFromViewDirection({ maxDistance: range }));
  if (!bh) return false;
  const b = bh.block.location;
  for (let dy = 1; dy <= 3; dy++) {
    const a = safe(() => p.dimension.getBlock({ x: b.x, y: b.y + dy, z: b.z }));
    const a2 = safe(() => p.dimension.getBlock({ x: b.x, y: b.y + dy + 1, z: b.z }));
    if (a?.isAir && a2?.isAir) {
      particle(p.dimension, "morph:absorb_burst", up(p.location, 1));
      moveTo(p, { x: b.x + 0.5, y: b.y + dy, z: b.z + 0.5 });
      sound(p, "mob.endermen.portal", 1);
      return;
    }
  }
  return false;
}

// Passive flags: fly (hold jump to rise), climb (walls), water (breathing + swim speed), fire, nowither
// effects: [effectId, amplifier]
/** @type {Record<string, {ab: keyof typeof AB, fx?: [string, number][], fly?: boolean, climb?: boolean, water?: boolean, nowither?: boolean, hurtBlink?: boolean, text: string}>} */
const KIT = {
  shapeshifter: { ab: "veil", text: "No body of your own. Kill something and take theirs." },
  zombie: { ab: "roar", fx: [["strength", 0]], text: "Strength" },
  husk: { ab: "roar", fx: [["strength", 0], ["fire_resistance", 0]], text: "Strength, heat-proof" },
  drowned: { ab: "roar", fx: [["strength", 0]], water: true, text: "Strength, breathes underwater" },
  zombie_villager: { ab: "roar", fx: [["strength", 0]], text: "Strength" },
  zombie_villager_v2: { ab: "roar", fx: [["strength", 0]], text: "Strength" },
  zombie_pigman: { ab: "barter", fx: [["strength", 0], ["fire_resistance", 0]], text: "Strength, fire-proof" },
  zoglin: { ab: "ram", fx: [["strength", 1]], text: "Strength II" },
  hoglin: { ab: "ram", fx: [["strength", 1]], text: "Strength II" },
  skeleton: { ab: "arrows", fx: [["speed", 0]], text: "Speed" },
  stray: { ab: "arrows", fx: [["speed", 0]], text: "Speed" },
  bogged: { ab: "arrows", fx: [["speed", 0]], text: "Speed" },
  parched: { ab: "arrows", fx: [["speed", 0], ["fire_resistance", 0]], text: "Speed, heat-proof" },
  wither_skeleton: { ab: "witherStrike", fx: [["strength", 0], ["fire_resistance", 0]], nowither: true, text: "Strength, fire-proof, wither-proof" },
  pillager: { ab: "crossbow", text: "Crossbow marksman" },
  vindicator: { ab: "frenzy", fx: [["strength", 0]], text: "Strength" },
  evocation_illager: { ab: "fangs", text: "Spellcaster" },
  witch: { ab: "potion", fx: [["fire_resistance", 0]], text: "Potion resistance" },
  ravager: { ab: "ravage", fx: [["strength", 1], ["resistance", 0]], text: "Strength II, Resistance" },
  creeper: { ab: "explode", text: "Immune to your own blast" },
  spider: { ab: "web", fx: [["night_vision", 0]], climb: true, text: "Wall climbing, night vision" },
  cave_spider: { ab: "web", fx: [["night_vision", 0]], climb: true, text: "Wall climbing, poison webs" },
  enderman: { ab: "blink", fx: [["night_vision", 0]], hurtBlink: true, text: "Teleports away when hurt" },
  endermite: { ab: "miteBlink", fx: [["night_vision", 0]], text: "Night vision" },
  shulker: { ab: "shulker", fx: [["resistance", 1]], text: "Resistance II" },
  blaze: { ab: "smallFire", fx: [["fire_resistance", 0]], fly: true, text: "Flight, fire-proof" },
  ghast: { ab: "bigFire", fx: [["fire_resistance", 0]], fly: true, text: "Flight, fire-proof" },
  happy_ghast: { ab: "healAura", fly: true, text: "Flight" },
  wither: { ab: "skulls", fx: [["fire_resistance", 0], ["resistance", 1]], fly: true, nowither: true, text: "Flight, Resistance II, wither-proof" },
  ender_dragon: { ab: "dragon", fx: [["resistance", 1], ["strength", 1]], fly: true, text: "Flight, Strength II, Resistance II" },
  breeze: { ab: "wind", fx: [["jump_boost", 2]], text: "Huge jumps" },
  warden: { ab: "sonic", fx: [["strength", 3], ["resistance", 1]], text: "Strength IV, Resistance II" },
  iron_golem: { ab: "toss", fx: [["strength", 1], ["resistance", 1]], text: "Strength II, Resistance II" },
  copper_golem: { ab: "collect", text: "Item collector" },
  snow_golem: { ab: "snow", text: "Snowball thrower" },
  villager: { ab: "hero", text: "Village spirit" },
  villager_v2: { ab: "hero", text: "Village spirit" },
  wandering_trader: { ab: "vanish", text: "Trader's tricks" },
  piglin: { ab: "barter", fx: [["fire_resistance", 0]], text: "Fire-proof" },
  piglin_brute: { ab: "frenzy", fx: [["strength", 1], ["fire_resistance", 0]], text: "Strength II, fire-proof" },
  strider: { ab: "heat", fx: [["fire_resistance", 0]], text: "Fire-proof" },
  magma_cube: { ab: "leap", fx: [["fire_resistance", 0], ["jump_boost", 2]], text: "Fire-proof, big jumps" },
  slime: { ab: "leap", fx: [["jump_boost", 2]], text: "Big jumps" },
  sulfur_cube: { ab: "leap", fx: [["jump_boost", 1]], text: "Bouncy" },
  wolf: { ab: "lunge", fx: [["speed", 0], ["strength", 0]], text: "Speed, Strength" },
  fox: { ab: "lunge", fx: [["speed", 0], ["night_vision", 0], ["jump_boost", 0]], text: "Speed, night vision" },
  cat: { ab: "hiss", fx: [["speed", 0], ["night_vision", 0], ["jump_boost", 0]], text: "Speed, night vision" },
  ocelot: { ab: "hiss", fx: [["speed", 1], ["night_vision", 0]], text: "Speed II, night vision" },
  polar_bear: { ab: "ravage", fx: [["strength", 1]], water: true, text: "Strength II, swimmer" },
  panda: { ab: "graze", fx: [["strength", 0]], text: "Strength" },
  goat: { ab: "ram", fx: [["jump_boost", 2]], text: "Big jumps" },
  camel: { ab: "gallop", text: "Desert strider" },
  camel_husk: { ab: "gallop", text: "Desert strider" },
  horse: { ab: "gallop", fx: [["speed", 1], ["jump_boost", 1]], text: "Speed II, jump" },
  donkey: { ab: "gallop", fx: [["speed", 0], ["jump_boost", 0]], text: "Speed, jump" },
  mule: { ab: "gallop", fx: [["speed", 0], ["jump_boost", 0]], text: "Speed, jump" },
  skeleton_horse: { ab: "gallop", fx: [["speed", 1], ["jump_boost", 1]], water: true, text: "Speed II, breathes underwater" },
  zombie_horse: { ab: "gallop", fx: [["speed", 0], ["jump_boost", 1]], text: "Speed, jump" },
  llama: { ab: "spit", text: "Spitter" },
  trader_llama: { ab: "spit", text: "Spitter" },
  rabbit: { ab: "leap", fx: [["jump_boost", 2], ["speed", 0]], text: "Jump III, speed" },
  frog: { ab: "tongue", fx: [["jump_boost", 2]], water: true, text: "Big jumps, swimmer" },
  chicken: { ab: "egg", fx: [["slow_falling", 0]], text: "Slow falling" },
  parrot: { ab: "swoop", fly: true, text: "Flight" },
  bat: { ab: "swoop", fx: [["night_vision", 0]], fly: true, text: "Flight, night vision" },
  bee: { ab: "sting", fly: true, text: "Flight" },
  allay: { ab: "collect", fly: true, text: "Flight" },
  vex: { ab: "vex", fly: true, text: "Flight" },
  phantom: { ab: "swoop", fx: [["night_vision", 0]], fly: true, text: "Flight, night vision" },
  cow: { ab: "milk", text: "Fresh milk" },
  mooshroom: { ab: "milk", text: "Fresh milk" },
  sheep: { ab: "graze", text: "Grazer" },
  pig: { ab: "graze", text: "Truffle snout" },
  sniffer: { ab: "dig", text: "Ancient nose" },
  armadillo: { ab: "shell", fx: [["resistance", 0]], text: "Resistance" },
  turtle: { ab: "shell", fx: [["resistance", 0]], water: true, text: "Resistance, swimmer" },
  squid: { ab: "ink", water: true, text: "Swimmer" },
  glow_squid: { ab: "ink", fx: [["night_vision", 0]], water: true, text: "Swimmer, night vision" },
  dolphin: { ab: "swimDash", water: true, text: "Fast swimmer" },
  axolotl: { ab: "swimDash", fx: [["regeneration", 0]], water: true, text: "Regeneration, swimmer" },
  cod: { ab: "swimDash", water: true, text: "Swimmer" },
  salmon: { ab: "swimDash", water: true, text: "Swimmer" },
  tropicalfish: { ab: "swimDash", water: true, text: "Swimmer" },
  pufferfish: { ab: "puff", water: true, text: "Swimmer" },
  tadpole: { ab: "swimDash", water: true, text: "Swimmer" },
  nautilus: { ab: "swimDash", water: true, text: "Swimmer" },
  zombie_nautilus: { ab: "swimDash", water: true, text: "Swimmer" },
  guardian: { ab: "laser", water: true, text: "Swimmer" },
  elder_guardian: { ab: "laser", fx: [["resistance", 0]], water: true, text: "Swimmer, Resistance" },
  silverfish: { ab: "miteBlink", text: "Quick" },
};
const DEFAULT_KIT = { ab: "lunge", text: "Feral instincts" };
const kit = (f) => KIT[f.key] ?? DEFAULT_KIT;

const ALL_FX = ["strength", "speed", "night_vision", "fire_resistance", "slow_falling", "resistance", "jump_boost", "water_breathing", "regeneration", "conduit_power"];

/** @param {import("@minecraft/server").Player} p */
function clearPassives(p) {
  for (const e of ALL_FX) safe(() => p.removeEffect(e));
}

/** @param {import("@minecraft/server").Player} p @param {Form} f */
function applyPassives(p, f) {
  const k = kit(f);
  for (const [id, amp] of k.fx ?? []) safe(() => p.addEffect(id, id === "night_vision" ? 400 : 300, { amplifier: amp, showParticles: false }));
  const body = ridingBody(p);
  for (const [id, amp] of k.fx ?? []) if (body && id === "speed") safe(() => body.addEffect(id, 300, { amplifier: amp, showParticles: false }));
  if (k.water) {
    safe(() => p.addEffect("water_breathing", 300, { showParticles: false }));
    if (p.isInWater) safe(() => p.addEffect("conduit_power", 300, { showParticles: false }));
  }
  if (k.nowither) safe(() => p.removeEffect("wither"));
}

// ---------------------------------------------------------------------------
// Becoming a form
// ---------------------------------------------------------------------------
/** @param {import("@minecraft/server").Player} p @param {Form} f */
function setForm(p, f, freshBody = true) {
  clearPassives(p);
  safe(() => p.setProperty(P_FORM, f.id));
  safe(() => p.setProperty(P_R, f.r));
  if (freshBody) {
    safe(() => p.triggerEvent(`morph:hp_${f.hp}`));
    system.runTimeout(() => p.isValid && safe(() => p.getComponent("minecraft:health")?.resetToMaxValue()), 2);
  }
  const s = st(p);
  s.cooldownUntil = 0;
  s.lastForm = f.id;
  applyPassives(p, f);
  syncBody(p);
}

/**
 * The skin-steal sequence:
 *  1. a ghostly copy of the mob's skin peels off the corpse
 *  2. it spins and arcs into you, shedding flakes
 *  3. you levitate, arms spread, shaking inside a purple vortex
 *  4. purple flash, burst, and your body becomes the mob
 */
function stealSkin(p, f, from) {
  const s = st(p);
  const token = ++s.animToken;
  s.busy = true;
  const dim = p.dimension;
  const color = formColor(f);
  const DURATION = 32;

  safe(() => p.setProperty(P_ABSORB, true));
  safe(() => p.addEffect("slowness", DURATION + 10, { amplifier: 3, showParticles: false }));
  sound(p, "mob.endermen.portal", 0.55);
  sound(p, "mob.zombie.unfect", 1.6, 0.6);
  particle(dim, "morph:absorb_spiral", p.location);
  bar(p, `§5Tearing the skin off the ${f.name}...`);

  const skin = safe(() => dim.spawnEntity(SKIN_ENTITY, up(from, 0.1)));
  if (skin) {
    safe(() => skin.setProperty(P_FORM, f.id));
    safe(() => skin.setProperty(P_R, f.r));
  }
  for (let i = 1; i <= DURATION; i++) {
    system.runTimeout(() => {
      if (!p.isValid || s.animToken !== token) return;
      const t = i / DURATION;
      const pos = up(lerp(from, up(feet(p), getForm(p).eye * 0.6), easeInOut(t)), Math.sin(Math.PI * t) * 1.8);
      if (skin?.isValid) safe(() => skin.teleport(pos, { rotation: { x: 0, y: t * 720 } }));
      if (i % 2 === 0) particle(dim, "morph:skin_flake", pos, color);
      if (i === DURATION / 2) sound(p, "mob.endermen.portal", 1.4, 0.8);
    }, i);
  }
  system.runTimeout(() => {
    if (skin?.isValid) safe(() => skin.remove());
    if (!p.isValid || s.animToken !== token) return;
    const chest = up(feet(p), Math.min(f.eye, 3) * 0.6);
    particle(dim, "morph:absorb_burst", chest);
    particle(dim, "morph:skin_flake", chest, color);
    safe(() => p.camera.fade({ fadeColor: { red: 0.35, green: 0.05, blue: 0.55 }, fadeTime: { fadeInTime: 0.1, holdTime: 0.15, fadeOutTime: 0.6 } }));
    sound(p, "random.levelup", 0.6, 0.8);
    setForm(p, f);
    const k = kit(f);
    safe(() => p.onScreenDisplay.setTitle("§5§lSKIN STOLEN", {
      subtitle: `§dYou are now a ${f.name} §7(${f.hp / 2} hearts)`, fadeInDuration: 4, stayDuration: 40, fadeOutDuration: 12,
    }));
    safe(() => p.sendMessage(`§5[Morph]§r You became a §d${f.name}§r. §7Health: ${f.hp}. Passive: ${k.text}. Ability: ${AB[k.ab].label}.`));
  }, DURATION + 1);
  system.runTimeout(() => {
    if (s.animToken !== token) return;
    s.busy = false;
    if (p.isValid) safe(() => p.setProperty(P_ABSORB, false));
  }, DURATION + 18);
}

// The only way to change form: kill a mob.
world.afterEvents.entityDie.subscribe((ev) => {
  const dead = ev.deadEntity;
  if (dead.typeId === "minecraft:player") {
    safe(() => dead.setDynamicProperty(DP_DIED, true));
    removeBody(dead.id);
    return;
  }
  const killer = ev.damageSource.damagingEntity;
  if (!killer || killer.typeId !== "minecraft:player") return;
  const f = FORM_BY_TYPE.get(dead.typeId);
  if (!f) return;
  const p = /** @type {import("@minecraft/server").Player} */ (killer);
  const from = safe(() => dead.location) ?? p.location;
  if (getForm(p).id === f.id) {
    particle(p.dimension, "morph:skin_flake", up(from, 0.5), formColor(f));
    return;
  }
  stealSkin(p, f, from);
});

// ---------------------------------------------------------------------------
// Passive loops
// ---------------------------------------------------------------------------
function isSolid(b) {
  return !!b && !b.isAir && !b.isLiquid && b.typeId !== "minecraft:web";
}

// ---------------------------------------------------------------------------
// The invisible mob-sized body (puts the real camera at the mob's eye height)
// ---------------------------------------------------------------------------
/** playerId -> { body, formId, seat, mountedAt, calibrated } */
const bodies = new Map();
const needsBody = (f) => f.id !== 0 && Math.abs(f.eye - PLAYER_EYE) > 0.08;
const seatIndex = (y) => Math.min(Math.max(Math.round((y - SEAT.min) / SEAT.step), 0), SEAT.count - 1);

/** head height above the seat for a rider (measured once per world, then remembered) */
function riderK() {
  const v = world.getDynamicProperty(DP_K);
  return typeof v === "number" ? v : 1.1;
}

/** @param {import("@minecraft/server").Player} p */
function ridingBody(p) {
  const r = safe(() => p.getComponent("minecraft:riding")?.entityRidingOn);
  return r && r.typeId === BODY_ID ? r : undefined;
}

function removeBody(playerId) {
  const rec = bodies.get(playerId);
  if (rec?.body?.isValid) safe(() => rec.body.remove());
  bodies.delete(playerId);
}

/** @param {import("@minecraft/server").Player} p @param {import("@minecraft/server").Vector3} loc */
function moveTo(p, loc) {
  const rec = bodies.get(p.id);
  if (rec?.body?.isValid) safe(() => rec.body.teleport(loc));
  safe(() => p.teleport(loc));
}

/**
 * Make sure the player rides a body of the right size whose seat puts their eyes at the mob's
 * eye height. A fresh body is spawned for every form/seat change (component groups only add).
 * @param {import("@minecraft/server").Player} p
 */
function syncBody(p, seatOverride) {
  const f = getForm(p);
  if (!needsBody(f)) {
    removeBody(p.id);
    safe(() => p.setProperty(P_RIDE, 0));
    return;
  }
  const seat = seatOverride ?? f.eye - riderK();
  const rec = bodies.get(p.id);
  if (rec?.body?.isValid && rec.formId === f.id && Math.abs(rec.seat - seat) < SEAT.step / 2 && rec.body.dimension.id === p.dimension.id) return;
  const at = rec?.body?.isValid && rec.body.dimension.id === p.dimension.id ? rec.body.location : p.location;
  removeBody(p.id);
  const body = safe(() => p.dimension.spawnEntity(BODY_ID, at));
  if (!body) return;
  safe(() => body.triggerEvent(`morph:size_${f.size}`));
  safe(() => body.triggerEvent(`morph:seat_${seatIndex(seat)}`));
  safe(() => body.setDynamicProperty("owner", p.id));
  bodies.set(p.id, { body, formId: f.id, seat: SEAT.min + seatIndex(seat) * SEAT.step, mountedAt: -1, calibrated: seatOverride !== undefined });
  system.run(() => mount(p));
}

/** @param {import("@minecraft/server").Player} p */
function mount(p) {
  const rec = bodies.get(p.id);
  if (!rec?.body?.isValid || !p.isValid) return;
  const rideable = safe(() => rec.body.getComponent("minecraft:rideable"));
  if (!rideable) return;
  // nobody else may sit in your body
  for (const r of safe(() => rideable.getRiders()) ?? []) if (r.id !== p.id) safe(() => rideable.ejectRider(r));
  if (ridingBody(p)?.id === rec.body.id) return;
  safe(() => rec.body.teleport(p.location));
  if (safe(() => rideable.addRider(p))) rec.mountedAt = system.currentTick;
}

/** Runs every tick for players wearing a body: keep them seated, calibrate, and drive jump/fly/climb/swim. */
function driveBody(p) {
  const rec = bodies.get(p.id);
  const f = getForm(p);
  if (!rec?.body?.isValid || rec.body.dimension.id !== p.dimension.id) {
    syncBody(p);
    return;
  }
  const b = rec.body;
  if (ridingBody(p)?.id !== b.id) {
    // dismounted (sneak, dismount button, teleport...): hop straight back in
    if (system.currentTick % 2 === 0) mount(p);
    return;
  }
  const k = kit(f);
  // calibrate once: measure where the engine actually put the rider's eyes
  if (!rec.calibrated && rec.mountedAt >= 0 && system.currentTick - rec.mountedAt > 6) {
    rec.calibrated = true;
    const head = safe(() => p.getHeadLocation().y);
    if (typeof head === "number") {
      const measuredK = head - b.location.y - rec.seat;
      if (Math.abs(measuredK - riderK()) > 0.03) world.setDynamicProperty(DP_K, measuredK);
      const want = f.eye - measuredK;
      if (Math.abs(want - rec.seat) >= SEAT.step / 2) {
        system.run(() => syncBody(p, want));
        return;
      }
    }
  }
  if (system.currentTick % 10 === 0) safe(() => p.setProperty(P_RIDE, Math.round((p.location.y - b.location.y) * 100) / 100));

  const jump = safe(() => p.inputInfo.getButtonState(InputButton.Jump)) === ButtonState.Pressed;
  const v = safe(() => b.getVelocity()) ?? { x: 0, y: 0, z: 0 };
  const move = safe(() => p.inputInfo.getMovementVector()) ?? { x: 0, y: 0 };
  const inWater = b.isInWater;
  if (k.fly) {
    if (jump && v.y < 0.45) safe(() => b.applyImpulse({ x: 0, y: 0.12, z: 0 }));
    else if (!b.isOnGround && v.y < -0.12) safe(() => b.applyImpulse({ x: 0, y: 0.07, z: 0 }));
    if (!b.isOnGround && move.y > 0.2) {
      const d = p.getViewDirection();
      const len = Math.hypot(d.x, d.z) || 1;
      if (Math.hypot(v.x, v.z) < 0.5) safe(() => b.applyImpulse({ x: (d.x / len) * 0.06, y: 0, z: (d.z / len) * 0.06 }));
    }
  } else if (inWater) {
    if (jump && v.y < 0.25) safe(() => b.applyImpulse({ x: 0, y: 0.08, z: 0 }));
    if (k.water && move.y > 0.2) {
      const d = p.getViewDirection();
      if (Math.hypot(v.x, v.y, v.z) < 0.6) safe(() => b.applyImpulse(scale(d, 0.07)));
    }
  } else {
    // the jump itself is the body's own (horse-style) jump so the touch jump button stays a jump
    // button; Jump Boost forms get an extra push right after take-off
    const boost = (k.fx ?? []).find(([id]) => id === "jump_boost");
    if (boost && rec.wasOnGround && !b.isOnGround && v.y > 0.1) safe(() => b.applyImpulse({ x: 0, y: (boost[1] + 1) * 0.12, z: 0 }));
  }
  rec.wasOnGround = b.isOnGround;
  if (k.climb && move.y > 0.2) {
    const d = p.getViewDirection();
    const len = Math.hypot(d.x, d.z) || 1;
    const reach = Math.max(f.width / 2 + 0.3, 0.5);
    const at = (y) => safe(() => p.dimension.getBlock({ x: b.location.x + (d.x / len) * reach, y: b.location.y + y, z: b.location.z + (d.z / len) * reach }));
    if ((isSolid(at(0.2)) || isSolid(at(0.8))) && v.y < 0.25) safe(() => b.applyImpulse({ x: 0, y: 0.12, z: 0 }));
  }
}

/** Legacy path for player-height forms (no body): flying and climbing through effects. */
function drivePlayer(p) {
  const k = kit(getForm(p));
  if (k.fly) {
    if (p.isJumping && !p.isOnGround) safe(() => p.addEffect("levitation", 3, { amplifier: 2, showParticles: false }));
    else if (!p.isOnGround && !p.isSneaking) safe(() => p.addEffect("slow_falling", 3, { showParticles: false }));
  }
  if (k.climb) {
    const v = p.getViewDirection();
    const len = Math.hypot(v.x, v.z) || 1;
    const at = (y) => safe(() => p.dimension.getBlock({ x: p.location.x + (v.x / len) * 0.6, y: p.location.y + y, z: p.location.z + (v.z / len) * 0.6 }));
    if ((isSolid(at(0.2)) || isSolid(at(1.1))) && !p.isSneaking) safe(() => p.addEffect("levitation", 3, { amplifier: 3, showParticles: false }));
  }
}

system.runInterval(() => {
  for (const p of world.getPlayers()) {
    if (needsBody(getForm(p))) driveBody(p);
    else {
      if (bodies.has(p.id)) syncBody(p);
      drivePlayer(p);
    }
  }
}, 1);

// Clean up bodies whose owner is gone (e.g. after a crash or rejoin).
system.runInterval(() => {
  const live = new Set([...bodies.values()].map((r) => r.body?.isValid && r.body.id));
  for (const dimId of ["overworld", "nether", "the_end"]) {
    const list = safe(() => world.getDimension(dimId).getEntities({ type: BODY_ID })) ?? [];
    for (const e of list) if (!live.has(e.id)) safe(() => e.remove());
  }
}, 200);

system.runInterval(() => {
  for (const p of world.getPlayers()) {
    const f = getForm(p);
    const s = st(p);
    if (s.lastForm !== f.id) {
      clearPassives(p);
      s.lastForm = f.id;
    }
    applyPassives(p, f);
    if (!s.busy && safe(() => p.getProperty(P_ABSORB)) === true) safe(() => p.setProperty(P_ABSORB, false));
    const held = safe(() => p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex));
    if (held?.typeId === CORE_ID && !s.busy) {
      const left = Math.max(0, s.cooldownUntil - system.currentTick);
      const status = left > 0 ? `§c${(left / 20).toFixed(1)}s` : "§aREADY";
      bar(p, `§5${f.name} §8| §c${Math.ceil(safe(() => p.getComponent("minecraft:health").currentValue) ?? 0)}/${f.hp} HP §8| §7${AB[kit(f).ab].label}: ${status}`);
    }
  }
}, 20);

world.afterEvents.entityHurt.subscribe((ev) => {
  const p = /** @type {import("@minecraft/server").Player} */ (ev.hurtEntity);
  if (!kit(getForm(p)).hurtBlink) return;
  const s = st(p);
  if (system.currentTick < s.blinkUntil || Math.random() > 0.35) return;
  s.blinkUntil = system.currentTick + 60;
  system.run(() => {
    for (let tries = 0; tries < 16; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 6;
      const base = feet(p);
      const x = Math.floor(base.x + Math.cos(a) * r) + 0.5;
      const z = Math.floor(base.z + Math.sin(a) * r) + 0.5;
      for (let dy = 4; dy >= -4; dy--) {
        const y = Math.floor(base.y) + dy;
        const g = (yy) => safe(() => p.dimension.getBlock({ x, y: yy, z }));
        if (isSolid(g(y - 1)) && g(y)?.isAir && g(y + 1)?.isAir) {
          particle(p.dimension, "morph:absorb_burst", up(p.location, 1));
          moveTo(p, { x, y, z });
          sound(p, "mob.endermen.portal", 1);
          return;
        }
      }
    }
  });
}, { entityTypes: ["minecraft:player"] });

// ---------------------------------------------------------------------------
// Morph Core: ability / camera
// ---------------------------------------------------------------------------
world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack.typeId !== CORE_ID) return;
  const p = ev.source;
  if (p.isSneaking) {
    const f = getForm(p);
    const k = kit(f);
    safe(() => p.sendMessage(`§5[Morph] §d${f.name}§r §7- Health ${f.hp}, eye height ${f.eye.toFixed(2)} blocks\n§7Passive: §f${k.text}\n§7Ability: §f${AB[k.ab].label}\n§7Kill another mob to change shape.`));
    return;
  }
  const s = st(p);
  if (s.busy) return;
  const f = getForm(p);
  const ab = AB[kit(f).ab];
  const left = s.cooldownUntil - system.currentTick;
  if (left > 0) {
    bar(p, `§c${ab.label} recharging: ${(left / 20).toFixed(1)}s`);
    return;
  }
  const ok = safe(() => ab.run(p));
  if (ok !== false) s.cooldownUntil = system.currentTick + ab.cd;
});

// ---------------------------------------------------------------------------
// Spawning: hand out the core, restore camera, lose your stolen body on death
// ---------------------------------------------------------------------------
function ensureCore(p) {
  const inv = safe(() => p.getComponent("minecraft:inventory")?.container);
  if (!inv) return;
  for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === CORE_ID) return;
  const item = new ItemStack(CORE_ID, 1);
  item.setLore(["§7Use: form ability", "§7Sneak + use: form info"]);
  safe(() => inv.addItem(item));
}

world.afterEvents.playerSpawn.subscribe((ev) => {
  const p = ev.player;
  system.runTimeout(() => {
    if (!p.isValid) return;
    ensureCore(p);
    safe(() => p.setProperty(P_ABSORB, false));
    if (p.getDynamicProperty(DP_DIED) === true) {
      p.setDynamicProperty(DP_DIED, false);
      const was = getForm(p);
      setForm(p, FORMS[0]);
      if (was.id !== 0) safe(() => p.sendMessage(`§5[Morph]§r Your stolen ${was.name} body died with you. Kill something to wear a new skin.`));
    } else {
      // re-apply health/camera for the saved form (camera state is not saved by the game)
      setForm(p, getForm(p), false);
    }
    if (ev.initialSpawn) {
      const f = getForm(p);
      safe(() => p.onScreenDisplay.setTitle("§5§lSHAPESHIFTER", {
        subtitle: f.id === 0 ? "§dYou have no body. Kill a mob to steal one." : `§dWearing: ${f.name}`,
        fadeInDuration: 10, stayDuration: 60, fadeOutDuration: 20,
      }));
    }
  }, 20);
});

world.afterEvents.playerLeave.subscribe((ev) => {
  removeBody(ev.playerId);
  state.delete(ev.playerId);
});
