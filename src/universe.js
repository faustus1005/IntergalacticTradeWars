'use strict';

// ---------------------------------------------------------------------------
// universe.js – Universe generation for Intergalactic Trade Wars
// ---------------------------------------------------------------------------

// ── helpers ----------------------------------------------------------------

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── port name generation ---------------------------------------------------

const PORT_PREFIXES = [
  'Star', 'Nova', 'Quantum', 'Nebula', 'Astro',
  'Solar', 'Lunar', 'Cosmic', 'Void', 'Hyper',
  'Deep', 'Omega', 'Alpha', 'Delta', 'Sigma',
];

const PORT_SUFFIXES = [
  'Port', 'Station', 'Hub', 'Depot', 'Terminal',
  'Exchange', 'Bazaar', 'Market', 'Dock', 'Haven',
  'Gate', 'Nexus', 'Post', 'Base', 'Outpost',
];

function generatePortName(usedNames) {
  let name;
  let attempts = 0;
  do {
    name = pick(PORT_PREFIXES) + ' ' + pick(PORT_SUFFIXES);
    attempts++;
    // After many collisions append a number to guarantee uniqueness
    if (attempts > 50) {
      name += ' ' + randInt(1, 9999);
    }
  } while (usedNames.has(name));
  usedNames.add(name);
  return name;
}

// ── port class definitions -------------------------------------------------
// Each entry: [oreBuying, orgBuying, equBuying]
// 1 = port is BUYING from player, 0 = port is SELLING to player

const PORT_CLASS_CONFIG = {
  1: { ore: 1, org: 1, equ: 0 },  // Buy Ore, Buy Org, Sell Equ
  2: { ore: 1, org: 0, equ: 1 },  // Buy Ore, Sell Org, Buy Equ
  3: { ore: 1, org: 1, equ: 0 },  // Buy Ore, Buy Org, Sell Equ (different prices)
  4: { ore: 0, org: 0, equ: 1 },  // Sell Ore, Sell Org, Buy Equ
  5: { ore: 0, org: 1, equ: 0 },  // Sell Ore, Buy Org, Sell Equ
  6: { ore: 0, org: 1, equ: 1 },  // Sell Ore, Buy Org, Buy Equ
  7: { ore: 0, org: 0, equ: 0 },  // Sell Ore, Sell Org, Sell Equ
  8: { ore: 1, org: 1, equ: 1 },  // Buy Ore, Buy Org, Buy Equ (special/rare)
};

/**
 * Pick a port class using the specified distribution:
 * classes 1-6 each ~15%, class 7 ~5%, class 8 ~5%
 */
function randomPortClass() {
  const roll = Math.random() * 100;
  if (roll < 15) return 1;
  if (roll < 30) return 2;
  if (roll < 45) return 3;
  if (roll < 60) return 4;
  if (roll < 75) return 5;
  if (roll < 90) return 6;
  if (roll < 95) return 7;
  return 8;
}

// ── planet classes ---------------------------------------------------------

const PLANET_CLASSES = [
  { name: 'earth',       rate: 1.0 },
  { name: 'oceanic',     rate: 0.9 },
  { name: 'mountainous', rate: 0.8 },
  { name: 'volcanic',    rate: 0.7 },
  { name: 'glacial',     rate: 0.6 },
  { name: 'desert',      rate: 0.5 },
  { name: 'gaseous',     rate: 1.2 },
];

// ── region names -----------------------------------------------------------

const REGION_NAMES = [
  'Federation Space', 'The Frontier', 'Outer Rim', 'Core Worlds',
  'Nebula Expanse', 'Void Sector', 'Trader Corridor', 'Pirate Territories',
  'Uncharted Reaches', 'Industrial Zone', 'Colonial Fringe', 'Deep Space',
  'Astral Drift', 'Quantum Fields', 'Stellar Nursery', 'Omega Quadrant',
  'Delta Passage', 'Sigma Rift', 'Nova Cluster', 'Dark Expanse',
  'Galactic Edge', 'Hyperion Belt', 'Crimson Nebula', 'Crystal Shoals',
  'Warp Nexus', 'Shadow Reach', 'Titan Corridor', 'Pulsar Heights',
  'Obsidian Void', 'Celestial Arc',
];

// ── NPC name pools ---------------------------------------------------------

const FED_NAMES = [
  'Commander Voss', 'Admiral Kira', 'Captain Holt', 'Lieutenant Tarn',
  'Commander Reyes', 'Admiral Chen', 'Captain Orin', 'Lieutenant Graves',
];

const FERRENGI_NAMES = [
  'Grok the Ruthless', 'Zax Plunderer', 'Drek Ironjaw', 'Vor Shadowblade',
  'Krell Darkstar', 'Thax Bonecrusher', 'Nix Bloodfang', 'Gorr Skullsplitter',
  'Rax Deathweaver', 'Balg the Merciless',
];

const TRADER_NAMES = [
  'Zylox of Andara', 'Kree Merchant', "T'vok the Bartered",
  'Xenith Trader', 'Pallax Broker', 'Dreel of Omicron',
  'Quorix Exchange', 'Jorel the Wanderer', 'Selk Emissary',
];

// ===========================================================================
// generateUniverse
// ===========================================================================

function generateUniverse(db, numSectors = 500) {
  const insertSector   = db.prepare('INSERT INTO sectors (id, is_nebula, has_stardock, region_name) VALUES (?, ?, ?, ?)');
  const insertWarp     = db.prepare('INSERT OR IGNORE INTO sector_warps (from_sector, to_sector) VALUES (?, ?)');
  const insertPort     = db.prepare(`INSERT INTO ports
    (sector_id, name, class, ore_quantity, ore_buying, organics_quantity, organics_buying,
     equipment_quantity, equipment_buying, ore_price, organics_price, equipment_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertPlanet   = db.prepare(`INSERT INTO planets
    (sector_id, name, class, production_rate)
    VALUES (?, ?, ?, ?)`);

  const generate = db.transaction(() => {
    // ── 1. Decide which sectors get what ──────────────────────────────────
    const nebulaSectors = new Set();
    const portSectors   = new Set();
    const planetSectors = new Set();

    for (let s = 2; s <= numSectors; s++) {
      if (Math.random() < 0.10) nebulaSectors.add(s);
      if (Math.random() < 0.60) portSectors.add(s);
      if (Math.random() < 0.15) planetSectors.add(s);
    }

    // ── 7. Assign region names to groups of sectors ──────────────────────
    const regionSize = Math.max(10, Math.ceil(numSectors / REGION_NAMES.length));
    function regionFor(sectorId) {
      const idx = Math.floor((sectorId - 1) / regionSize);
      return REGION_NAMES[Math.min(idx, REGION_NAMES.length - 1)];
    }

    // ── 1 & 6. Create sectors ────────────────────────────────────────────
    for (let s = 1; s <= numSectors; s++) {
      const isNebula    = nebulaSectors.has(s) ? 1 : 0;
      const hasStardock = s === 1 ? 1 : 0;
      insertSector.run(s, isNebula, hasStardock, regionFor(s));
    }

    // ── 2. Generate warp connections (spanning tree + extras) ─────────────
    // Build a random spanning tree so the graph is connected,
    // then add random edges until every sector has 2-6 warps.

    const adj = new Map(); // sectorId -> Set of neighbours
    for (let s = 1; s <= numSectors; s++) adj.set(s, new Set());

    function addWarpPair(a, b) {
      adj.get(a).add(b);
      adj.get(b).add(a);
    }

    // Random spanning tree via random permutation walk
    const order = shuffle(Array.from({ length: numSectors }, (_, i) => i + 1));
    for (let i = 1; i < order.length; i++) {
      const parent = order[randInt(0, i - 1)];
      addWarpPair(order[i], parent);
    }

    // Add extra warps so each sector has at least 2 connections,
    // up to a maximum of 6.
    const allSectors = Array.from({ length: numSectors }, (_, i) => i + 1);
    for (const s of allSectors) {
      const desired = randInt(2, 6);
      let attempts = 0;
      while (adj.get(s).size < desired && attempts < 20) {
        attempts++;
        const target = randInt(1, numSectors);
        if (target === s) continue;
        if (adj.get(s).has(target)) continue;
        if (adj.get(target).size >= 6) continue;
        addWarpPair(s, target);
      }
    }

    // Persist warps (both directions)
    for (const [from, neighbours] of adj) {
      for (const to of neighbours) {
        insertWarp.run(from, to);
      }
    }

    // ── 4. Place ports ───────────────────────────────────────────────────
    const usedPortNames = new Set();
    for (const s of portSectors) {
      const cls  = randomPortClass();
      const cfg  = PORT_CLASS_CONFIG[cls];
      const name = generatePortName(usedPortNames);

      insertPort.run(
        s,
        name,
        cls,
        randInt(500, 2000), cfg.ore,          // ore
        randInt(500, 2000), cfg.org,          // organics
        randInt(500, 2000), cfg.equ,          // equipment
        randInt(8, 15),                        // ore price
        randInt(12, 25),                       // organics price
        randInt(25, 50),                       // equipment price
      );
    }

    // ── 5. Place planets ─────────────────────────────────────────────────
    for (const s of planetSectors) {
      const pc = pick(PLANET_CLASSES);
      insertPlanet.run(s, 'Unnamed Planet', pc.name, pc.rate);
    }
  });

  generate();
}

// ===========================================================================
// spawnNPCs
// ===========================================================================

function spawnNPCs(db, numSectors = 500) {
  const insertNPC = db.prepare(`INSERT INTO npcs
    (type, name, sector_id, strength, behavior, credits, ore, organics, equipment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const spawn = db.transaction(() => {
    const usedFedNames     = new Set();
    const usedFerNames     = new Set();
    const usedTraderNames  = new Set();

    function pickUnique(pool, used) {
      const available = pool.filter(n => !used.has(n));
      if (available.length === 0) return pool[randInt(0, pool.length - 1)];
      const name = pick(available);
      used.add(name);
      return name;
    }

    // 3-5 Federation officers
    const numFed = randInt(3, 5);
    for (let i = 0; i < numFed; i++) {
      insertNPC.run(
        'federation',
        pickUnique(FED_NAMES, usedFedNames),
        randInt(1, numSectors),
        randInt(80, 100),
        'patrol',
        randInt(5000, 20000),
        0, 0, 0,
      );
    }

    // 5-8 Ferrengi pirates
    const numFer = randInt(5, 8);
    for (let i = 0; i < numFer; i++) {
      insertNPC.run(
        'ferrengi',
        pickUnique(FERRENGI_NAMES, usedFerNames),
        randInt(1, numSectors),
        randInt(50, 80),
        'hunt',
        randInt(1000, 10000),
        0, 0, 0,
      );
    }

    // 3-6 Alien traders (carry random cargo)
    const numTraders = randInt(3, 6);
    for (let i = 0; i < numTraders; i++) {
      insertNPC.run(
        'alien_trader',
        pickUnique(TRADER_NAMES, usedTraderNames),
        randInt(1, numSectors),
        randInt(30, 50),
        'trade',
        randInt(2000, 15000),
        randInt(0, 200),   // ore
        randInt(0, 200),   // organics
        randInt(0, 100),   // equipment
      );
    }
  });

  spawn();
}

// ===========================================================================
// spawnWormholes
// ===========================================================================

function spawnWormholes(db, numSectors = 500) {
  const insertWormhole = db.prepare(`INSERT INTO wormholes
    (sector_a, sector_b, stability, expires_at)
    VALUES (?, ?, ?, ?)`);

  const spawn = db.transaction(() => {
    const numWormholes = randInt(3, 5);
    for (let i = 0; i < numWormholes; i++) {
      let a, b;
      // Pick two sectors that are "distant" – at least 30% of the universe apart
      const minDist = Math.floor(numSectors * 0.3);
      let attempts = 0;
      do {
        a = randInt(1, numSectors);
        b = randInt(1, numSectors);
        attempts++;
      } while ((a === b || Math.abs(a - b) < minDist) && attempts < 100);

      const hoursFromNow = randInt(2, 8);
      const expiresAt = new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString();
      const stability = Math.round((0.5 + Math.random() * 0.5) * 100) / 100; // 0.50 – 1.00

      insertWormhole.run(a, b, stability, expiresAt);
    }
  });

  spawn();
}

// ===========================================================================

module.exports = { generateUniverse, spawnNPCs, spawnWormholes };
