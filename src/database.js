const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'game.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      name TEXT UNIQUE NOT NULL,
      credits INTEGER DEFAULT 10000,
      alignment INTEGER DEFAULT 0,
      turns_remaining INTEGER DEFAULT 500,
      max_turns INTEGER DEFAULT 500,
      current_sector INTEGER DEFAULT 1,
      experience INTEGER DEFAULT 0,
      kills INTEGER DEFAULT 0,
      deaths INTEGER DEFAULT 0,
      last_login DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_turn_tick DATETIME DEFAULT CURRENT_TIMESTAMP,
      corp_id INTEGER,
      online INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ship_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      cargo_capacity INTEGER DEFAULT 50,
      fighter_capacity INTEGER DEFAULT 0,
      mine_capacity INTEGER DEFAULT 0,
      shield_capacity INTEGER DEFAULT 100,
      scanner_range INTEGER DEFAULT 1,
      has_transwarp INTEGER DEFAULT 0,
      has_photon INTEGER DEFAULT 0,
      combat_odds INTEGER DEFAULT 50,
      base_cost INTEGER DEFAULT 0,
      min_alignment INTEGER DEFAULT -999,
      max_alignment INTEGER DEFAULT 999
    );

    CREATE TABLE IF NOT EXISTS ships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      name TEXT DEFAULT 'Unnamed Vessel',
      ore INTEGER DEFAULT 0,
      organics INTEGER DEFAULT 0,
      equipment INTEGER DEFAULT 0,
      colonists INTEGER DEFAULT 0,
      fighters INTEGER DEFAULT 0,
      mines INTEGER DEFAULT 0,
      shields INTEGER DEFAULT 100,
      max_shields INTEGER DEFAULT 100,
      turns_used INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      FOREIGN KEY (player_id) REFERENCES players(id),
      FOREIGN KEY (type_id) REFERENCES ship_types(id)
    );

    CREATE TABLE IF NOT EXISTS sectors (
      id INTEGER PRIMARY KEY,
      beacon_text TEXT,
      is_nebula INTEGER DEFAULT 0,
      has_stardock INTEGER DEFAULT 0,
      region_name TEXT
    );

    CREATE TABLE IF NOT EXISTS sector_warps (
      from_sector INTEGER NOT NULL,
      to_sector INTEGER NOT NULL,
      PRIMARY KEY (from_sector, to_sector),
      FOREIGN KEY (from_sector) REFERENCES sectors(id),
      FOREIGN KEY (to_sector) REFERENCES sectors(id)
    );

    CREATE TABLE IF NOT EXISTS ports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sector_id INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      class INTEGER NOT NULL DEFAULT 1,
      ore_quantity INTEGER DEFAULT 1000,
      ore_buying INTEGER DEFAULT 1,
      organics_quantity INTEGER DEFAULT 1000,
      organics_buying INTEGER DEFAULT 1,
      equipment_quantity INTEGER DEFAULT 1000,
      equipment_buying INTEGER DEFAULT 1,
      ore_price INTEGER DEFAULT 10,
      organics_price INTEGER DEFAULT 15,
      equipment_price INTEGER DEFAULT 30,
      last_regen DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sector_id) REFERENCES sectors(id)
    );

    CREATE TABLE IF NOT EXISTS planets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sector_id INTEGER NOT NULL,
      owner_id INTEGER,
      name TEXT DEFAULT 'Unnamed Planet',
      class TEXT DEFAULT 'earth',
      ore INTEGER DEFAULT 0,
      organics INTEGER DEFAULT 0,
      equipment INTEGER DEFAULT 0,
      colonists INTEGER DEFAULT 0,
      fuel_ore INTEGER DEFAULT 0,
      fighters INTEGER DEFAULT 0,
      shields INTEGER DEFAULT 0,
      citadel_level INTEGER DEFAULT 0,
      treasury INTEGER DEFAULT 0,
      combat_computer INTEGER DEFAULT 0,
      quasar_cannon INTEGER DEFAULT 0,
      has_transwarp INTEGER DEFAULT 0,
      has_interdictor INTEGER DEFAULT 0,
      planetary_shields INTEGER DEFAULT 0,
      production_rate REAL DEFAULT 1.0,
      last_production DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sector_id) REFERENCES sectors(id),
      FOREIGN KEY (owner_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS corporations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      tag TEXT UNIQUE NOT NULL,
      ceo_id INTEGER NOT NULL,
      treasury INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ceo_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS corp_members (
      corp_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      rank TEXT DEFAULT 'member',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (corp_id, player_id),
      FOREIGN KEY (corp_id) REFERENCES corporations(id),
      FOREIGN KEY (player_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS sector_fighters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sector_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 0,
      mode TEXT DEFAULT 'defensive',
      FOREIGN KEY (sector_id) REFERENCES sectors(id),
      FOREIGN KEY (owner_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS sector_mines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sector_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 0,
      type TEXT DEFAULT 'regular',
      FOREIGN KEY (sector_id) REFERENCES sectors(id),
      FOREIGN KEY (owner_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS market_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      sector_id INTEGER NOT NULL,
      commodity TEXT NOT NULL,
      order_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price INTEGER NOT NULL,
      filled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (player_id) REFERENCES players(id),
      FOREIGN KEY (sector_id) REFERENCES sectors(id)
    );

    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      train_time_base INTEGER NOT NULL,
      max_level INTEGER DEFAULT 5
    );

    CREATE TABLE IF NOT EXISTS player_skills (
      player_id INTEGER NOT NULL,
      skill_id INTEGER NOT NULL,
      level INTEGER DEFAULT 0,
      training_start DATETIME,
      training_end DATETIME,
      PRIMARY KEY (player_id, skill_id),
      FOREIGN KEY (player_id) REFERENCES players(id),
      FOREIGN KEY (skill_id) REFERENCES skills(id)
    );

    CREATE TABLE IF NOT EXISTS skill_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      skill_id INTEGER NOT NULL,
      target_level INTEGER NOT NULL,
      queue_position INTEGER NOT NULL,
      FOREIGN KEY (player_id) REFERENCES players(id),
      FOREIGN KEY (skill_id) REFERENCES skills(id)
    );

    CREATE TABLE IF NOT EXISTS wormholes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sector_a INTEGER NOT NULL,
      sector_b INTEGER NOT NULL,
      stability REAL DEFAULT 1.0,
      discovered_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (sector_a) REFERENCES sectors(id),
      FOREIGN KEY (sector_b) REFERENCES sectors(id),
      FOREIGN KEY (discovered_by) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER,
      to_id INTEGER NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (from_id) REFERENCES players(id),
      FOREIGN KEY (to_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS combat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attacker_id INTEGER,
      defender_id INTEGER,
      sector_id INTEGER,
      result TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS npcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      sector_id INTEGER NOT NULL,
      strength INTEGER DEFAULT 50,
      behavior TEXT DEFAULT 'patrol',
      credits INTEGER DEFAULT 0,
      ore INTEGER DEFAULT 0,
      organics INTEGER DEFAULT 0,
      equipment INTEGER DEFAULT 0,
      last_move DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sector_id) REFERENCES sectors(id)
    );

    CREATE TABLE IF NOT EXISTS game_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sector_warps_from ON sector_warps(from_sector);
    CREATE INDEX IF NOT EXISTS idx_sector_warps_to ON sector_warps(to_sector);
    CREATE INDEX IF NOT EXISTS idx_ports_sector ON ports(sector_id);
    CREATE INDEX IF NOT EXISTS idx_planets_sector ON planets(sector_id);
    CREATE INDEX IF NOT EXISTS idx_ships_player ON ships(player_id);
    CREATE INDEX IF NOT EXISTS idx_sector_fighters_sector ON sector_fighters(sector_id);
    CREATE INDEX IF NOT EXISTS idx_sector_mines_sector ON sector_mines(sector_id);
    CREATE INDEX IF NOT EXISTS idx_market_orders_sector ON market_orders(sector_id);
    CREATE INDEX IF NOT EXISTS idx_market_orders_commodity ON market_orders(commodity, order_type);
    CREATE INDEX IF NOT EXISTS idx_npcs_sector ON npcs(sector_id);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, read);

    CREATE TABLE IF NOT EXISTS upgrade_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      stat_bonus TEXT NOT NULL,
      bonus_value REAL NOT NULL,
      max_stacks INTEGER DEFAULT 1,
      base_cost INTEGER NOT NULL,
      equipment_cost INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ship_upgrades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ship_id INTEGER NOT NULL,
      upgrade_type_id INTEGER NOT NULL,
      stacks INTEGER DEFAULT 1,
      installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ship_id) REFERENCES ships(id),
      FOREIGN KEY (upgrade_type_id) REFERENCES upgrade_types(id),
      UNIQUE(ship_id, upgrade_type_id)
    );

    CREATE TABLE IF NOT EXISTS companion_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      race TEXT NOT NULL,
      gender TEXT NOT NULL,
      description TEXT,
      personality TEXT,
      hire_cost INTEGER NOT NULL,
      home_sector INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS companions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      companion_type_id INTEGER NOT NULL,
      nickname TEXT,
      affinity INTEGER DEFAULT 50,
      mood INTEGER DEFAULT 50,
      hired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_interaction DATETIME,
      FOREIGN KEY (player_id) REFERENCES players(id),
      FOREIGN KEY (companion_type_id) REFERENCES companion_types(id),
      UNIQUE(player_id, companion_type_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ship_upgrades_ship ON ship_upgrades(ship_id);
    CREATE INDEX IF NOT EXISTS idx_companions_player ON companions(player_id);
  `);
}

function seedShipTypes() {
  const d = getDb();
  const count = d.prepare('SELECT COUNT(*) as c FROM ship_types').get().c;
  if (count > 0) return;

  const ships = [
    { name: 'Merchant Cruiser', desc: 'Standard starting vessel. Balanced for trading.', cargo: 75, fighters: 50, mines: 0, shields: 100, scanner: 1, transwarp: 0, photon: 0, combat: 50, cost: 0, minAlign: -999, maxAlign: 999 },
    { name: 'Scout Marauder', desc: 'Fast recon ship with extended scanners.', cargo: 30, fighters: 100, mines: 5, shields: 75, scanner: 3, transwarp: 0, photon: 0, combat: 55, cost: 15000, minAlign: -999, maxAlign: 999 },
    { name: 'Missile Frigate', desc: 'Heavily armed frigate with photon missiles.', cargo: 40, fighters: 200, mines: 15, shields: 200, scanner: 2, transwarp: 0, photon: 1, combat: 70, cost: 50000, minAlign: -999, maxAlign: 999 },
    { name: 'BattleShip', desc: 'Massive warship built for fleet combat.', cargo: 50, fighters: 500, mines: 30, shields: 500, scanner: 2, transwarp: 0, photon: 1, combat: 80, cost: 120000, minAlign: -999, maxAlign: 999 },
    { name: 'Corporate Flagship', desc: 'Premium vessel for corporation leaders.', cargo: 100, fighters: 300, mines: 20, shields: 400, scanner: 3, transwarp: 1, photon: 1, combat: 75, cost: 200000, minAlign: -999, maxAlign: 999 },
    { name: 'Colonial Transport', desc: 'Specialized for moving colonists to planets.', cargo: 200, fighters: 20, mines: 0, shields: 100, scanner: 1, transwarp: 0, photon: 0, combat: 30, cost: 30000, minAlign: -999, maxAlign: 999 },
    { name: 'CargoTran', desc: 'Maximum cargo capacity for serious traders.', cargo: 250, fighters: 10, mines: 0, shields: 75, scanner: 1, transwarp: 0, photon: 0, combat: 25, cost: 40000, minAlign: 0, maxAlign: 999 },
    { name: 'Merchant Freighter', desc: 'Large freighter with decent defenses.', cargo: 150, fighters: 50, mines: 5, shields: 150, scanner: 1, transwarp: 0, photon: 0, combat: 40, cost: 55000, minAlign: -999, maxAlign: 999 },
    { name: 'Imperial StarShip', desc: 'Top-of-the-line warship with transwarp drive.', cargo: 80, fighters: 750, mines: 50, shields: 750, scanner: 3, transwarp: 1, photon: 1, combat: 90, cost: 350000, minAlign: 100, maxAlign: 999 },
    { name: 'Havoc GunStar', desc: 'Pirate favorite. High firepower, low cargo.', cargo: 30, fighters: 400, mines: 40, shields: 300, scanner: 2, transwarp: 0, photon: 1, combat: 85, cost: 100000, minAlign: -999, maxAlign: -100 },
    { name: 'StarMaster', desc: 'Balanced advanced vessel for experienced traders.', cargo: 120, fighters: 200, mines: 15, shields: 300, scanner: 2, transwarp: 1, photon: 0, combat: 65, cost: 150000, minAlign: -999, maxAlign: 999 },
    { name: 'Constellation', desc: 'Versatile ship with good all-around stats.', cargo: 100, fighters: 150, mines: 10, shields: 200, scanner: 2, transwarp: 0, photon: 0, combat: 60, cost: 80000, minAlign: -999, maxAlign: 999 },
    { name: "T'Khasi Orion", desc: 'Alien-designed craft with unique capabilities.', cargo: 60, fighters: 350, mines: 25, shields: 350, scanner: 3, transwarp: 1, photon: 0, combat: 75, cost: 180000, minAlign: -999, maxAlign: 999 },
    { name: 'Tholian Sentinel', desc: 'Defensive powerhouse with massive shields.', cargo: 40, fighters: 100, mines: 50, shields: 600, scanner: 2, transwarp: 0, photon: 0, combat: 55, cost: 130000, minAlign: -999, maxAlign: 999 },
    { name: 'Interdictor Cruiser', desc: 'Specialized for sector denial and area control.', cargo: 60, fighters: 250, mines: 75, shields: 250, scanner: 3, transwarp: 1, photon: 0, combat: 65, cost: 160000, minAlign: -999, maxAlign: 999 },
  ];

  const stmt = d.prepare(`INSERT INTO ship_types (name, description, cargo_capacity, fighter_capacity, mine_capacity, shield_capacity, scanner_range, has_transwarp, has_photon, combat_odds, base_cost, min_alignment, max_alignment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const insertAll = d.transaction(() => {
    for (const s of ships) {
      stmt.run(s.name, s.desc, s.cargo, s.fighters, s.mines, s.shields, s.scanner, s.transwarp, s.photon, s.combat, s.cost, s.minAlign, s.maxAlign);
    }
  });
  insertAll();
}

function seedSkills() {
  const d = getDb();
  const count = d.prepare('SELECT COUNT(*) as c FROM skills').get().c;
  if (count > 0) return;

  const skills = [
    { name: 'Trade Efficiency', desc: 'Reduces port price markups and improves selling prices.', category: 'trading', time: 300, maxLvl: 5 },
    { name: 'Cargo Management', desc: 'Increases effective cargo capacity by 5% per level.', category: 'trading', time: 600, maxLvl: 5 },
    { name: 'Market Analytics', desc: 'See more market data and get better order fills.', category: 'trading', time: 450, maxLvl: 5 },
    { name: 'Combat Tactics', desc: 'Improves combat odds by 2% per level.', category: 'combat', time: 500, maxLvl: 5 },
    { name: 'Shield Management', desc: 'Increases shield effectiveness by 5% per level.', category: 'combat', time: 400, maxLvl: 5 },
    { name: 'Weapons Systems', desc: 'Increases fighter damage by 5% per level.', category: 'combat', time: 700, maxLvl: 5 },
    { name: 'Mine Warfare', desc: 'Mines are 10% more effective per level.', category: 'combat', time: 550, maxLvl: 5 },
    { name: 'Navigation', desc: 'Reduces turn cost for movement and improves pathfinding.', category: 'exploration', time: 350, maxLvl: 5 },
    { name: 'Scanner Operations', desc: 'Increases scanner range by 1 per level.', category: 'exploration', time: 500, maxLvl: 3 },
    { name: 'Wormhole Theory', desc: 'Allows detection and stabilization of wormholes.', category: 'exploration', time: 900, maxLvl: 3 },
    { name: 'Colonial Admin', desc: 'Increases planet production rates by 10% per level.', category: 'industry', time: 600, maxLvl: 5 },
    { name: 'Citadel Engineering', desc: 'Reduces citadel construction costs by 10% per level.', category: 'industry', time: 800, maxLvl: 5 },
    { name: 'Corporate Leadership', desc: 'Increases max corp size by 2 per level.', category: 'social', time: 700, maxLvl: 5 },
    { name: 'Diplomacy', desc: 'Improves alignment gains and reduces losses.', category: 'social', time: 400, maxLvl: 5 },
  ];

  const stmt = d.prepare('INSERT INTO skills (name, description, category, train_time_base, max_level) VALUES (?, ?, ?, ?, ?)');
  const insertAll = d.transaction(() => {
    for (const s of skills) {
      stmt.run(s.name, s.desc, s.category, s.time, s.maxLvl);
    }
  });
  insertAll();
}

function seedUpgradeTypes() {
  const d = getDb();
  const count = d.prepare('SELECT COUNT(*) as c FROM upgrade_types').get().c;
  if (count > 0) return;

  const upgrades = [
    // Engines
    { name: 'Ion Thrusters Mk I', category: 'engines', desc: 'Basic engine upgrade. Reduces turn cost by 10%.', stat: 'turn_cost', bonus: 0.10, stacks: 1, cost: 8000, eqCost: 20 },
    { name: 'Ion Thrusters Mk II', category: 'engines', desc: 'Advanced engines. Reduces turn cost by 20%.', stat: 'turn_cost', bonus: 0.20, stacks: 1, cost: 25000, eqCost: 50 },
    { name: 'Quantum Drive', category: 'engines', desc: 'Cutting-edge propulsion. Reduces turn cost by 35%.', stat: 'turn_cost', bonus: 0.35, stacks: 1, cost: 75000, eqCost: 100 },
    // Weapons
    { name: 'Phaser Array', category: 'weapons', desc: 'Adds +5% combat odds.', stat: 'combat_odds', bonus: 5, stacks: 1, cost: 10000, eqCost: 25 },
    { name: 'Plasma Cannons', category: 'weapons', desc: 'Adds +10% combat odds.', stat: 'combat_odds', bonus: 10, stacks: 1, cost: 35000, eqCost: 60 },
    { name: 'Quantum Torpedoes', category: 'weapons', desc: 'Adds +15% combat odds and enables photon capability.', stat: 'combat_odds', bonus: 15, stacks: 1, cost: 80000, eqCost: 120 },
    // Shields
    { name: 'Reinforced Plating', category: 'shields', desc: 'Adds +50 max shields.', stat: 'max_shields', bonus: 50, stacks: 3, cost: 5000, eqCost: 15 },
    { name: 'Deflector Array', category: 'shields', desc: 'Adds +150 max shields.', stat: 'max_shields', bonus: 150, stacks: 1, cost: 30000, eqCost: 50 },
    { name: 'Adaptive Shield Matrix', category: 'shields', desc: 'Adds +300 max shields.', stat: 'max_shields', bonus: 300, stacks: 1, cost: 100000, eqCost: 100 },
    // Scanners
    { name: 'Long-Range Sensors', category: 'scanners', desc: 'Adds +1 scanner range.', stat: 'scanner_range', bonus: 1, stacks: 2, cost: 12000, eqCost: 30 },
    { name: 'Deep Space Array', category: 'scanners', desc: 'Adds +3 scanner range.', stat: 'scanner_range', bonus: 3, stacks: 1, cost: 50000, eqCost: 80 },
    // Cargo
    { name: 'Cargo Expander', category: 'cargo', desc: 'Adds +25 cargo capacity.', stat: 'cargo_capacity', bonus: 25, stacks: 3, cost: 6000, eqCost: 15 },
    { name: 'Compression Bay', category: 'cargo', desc: 'Adds +75 cargo capacity.', stat: 'cargo_capacity', bonus: 75, stacks: 1, cost: 25000, eqCost: 40 },
    // Special
    { name: 'Cloaking Device', category: 'special', desc: 'Reduces chance of mine/fighter detection by 30%.', stat: 'stealth', bonus: 0.30, stacks: 1, cost: 120000, eqCost: 150 },
    { name: 'Emergency Warp Core', category: 'special', desc: 'Auto-escape on fatal damage (single use, then must re-buy).', stat: 'auto_escape', bonus: 1, stacks: 1, cost: 50000, eqCost: 80 },
  ];

  const stmt = d.prepare(`INSERT INTO upgrade_types (name, category, description, stat_bonus, bonus_value, max_stacks, base_cost, equipment_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  const insertAll = d.transaction(() => {
    for (const u of upgrades) {
      stmt.run(u.name, u.category, u.desc, u.stat, u.bonus, u.stacks, u.cost, u.eqCost);
    }
  });
  insertAll();
}

function seedCompanionTypes() {
  const d = getDb();
  const count = d.prepare('SELECT COUNT(*) as c FROM companion_types').get().c;
  if (count > 0) return;

  const companions = [
    // Female companions
    { name: 'Lyra Voss', race: 'Human', gender: 'female', desc: 'A sharp-witted ex-navigator who traded military life for the stars. Her knowledge of warp routes is unmatched.', personality: 'witty', cost: 5000 },
    { name: "Zh'kira", race: 'Zelthari', gender: 'female', desc: 'A blue-skinned telepathic diplomat from the Zelthari homeworld. She speaks softly but sees through every lie.', personality: 'serene', cost: 8000 },
    { name: 'Nyx Shadowpaw', race: 'Krynnari', gender: 'female', desc: 'A fierce feline bounty hunter who retired after one too many close calls. Still keeps her claws sharp.', personality: 'fierce', cost: 7000 },
    { name: 'Ssirath', race: 'Vossk', gender: 'female', desc: 'A reptilian merchant princess exiled from the Vossk trading guilds. She can appraise anything at a glance.', personality: 'cunning', cost: 6000 },
    { name: 'Aelindra', race: 'Aelari', gender: 'female', desc: 'A luminous, ethereal being who communicates through song. Her star-singing calms even the most troubled minds.', personality: 'ethereal', cost: 10000 },
    // Male companions
    { name: 'Rex Harlan', race: 'Human', gender: 'male', desc: 'A grizzled retired Commander who has seen every corner of the galaxy. Full of war stories and hard-earned wisdom.', personality: 'gruff', cost: 5000 },
    { name: "Thal'zen", race: 'Zelthari', gender: 'male', desc: 'A psychic scholar obsessed with mapping the consciousness of deep space. Oddly calming presence.', personality: 'contemplative', cost: 8000 },
    { name: "Grr'mak Ironclaw", race: 'Krynnari', gender: 'male', desc: 'A massive feline weapons master who lives for the thrill of combat. Surprisingly gentle off the battlefield.', personality: 'boisterous', cost: 7000 },
    { name: 'Vosskrath', race: 'Vossk', gender: 'male', desc: 'A smooth-scaled smuggler pilot who knows every hidden route and black market in the sector.', personality: 'sly', cost: 6000 },
    { name: 'Luminex', race: 'Aelari', gender: 'male', desc: 'A wandering mystic whose body pulses with starlight. He speaks in riddles but his advice is always prescient.', personality: 'mystical', cost: 10000 },
  ];

  const stmt = d.prepare(`INSERT INTO companion_types (name, race, gender, description, personality, hire_cost)
    VALUES (?, ?, ?, ?, ?, ?)`);

  const insertAll = d.transaction(() => {
    for (const c of companions) {
      stmt.run(c.name, c.race, c.gender, c.desc, c.personality, c.cost);
    }
  });
  insertAll();
}

module.exports = { getDb, seedShipTypes, seedSkills, seedUpgradeTypes, seedCompanionTypes };
