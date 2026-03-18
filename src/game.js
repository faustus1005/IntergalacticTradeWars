// Game logic module

// ============================================================
// TRADING
// ============================================================

function tradeAtPort(db, playerId, action, commodity, amount) {
  if (!['buy', 'sell'].includes(action)) return { success: false, message: 'Invalid action.' };
  if (!['ore', 'organics', 'equipment'].includes(commodity)) return { success: false, message: 'Invalid commodity.' };
  amount = Math.floor(amount);
  if (amount <= 0) return { success: false, message: 'Amount must be positive.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const port = db.prepare('SELECT * FROM ports WHERE sector_id = ?').get(player.current_sector);
  if (!port) return { success: false, message: 'No port in this sector.' };

  const ship = db.prepare(`SELECT s.*, st.cargo_capacity FROM ships s JOIN ship_types st ON s.type_id = st.id WHERE s.player_id = ? AND s.active = 1`).get(playerId);
  if (!ship) return { success: false, message: 'No active ship.' };

  const totalCargo = getTotalCargo(ship);
  const priceCol = commodity + '_price';
  const qtyCol = commodity + '_quantity';
  const buyingCol = commodity + '_buying';
  const unitPrice = port[priceCol];

  if (action === 'buy') {
    // Player buys from port: port must be selling (buying=0) and have stock
    if (port[buyingCol] === 1) return { success: false, message: `Port is not selling ${commodity}.` };
    if (port[qtyCol] < amount) return { success: false, message: `Port only has ${port[qtyCol]} ${commodity}.` };
    const freeSpace = ship.cargo_capacity - totalCargo;
    if (freeSpace < amount) return { success: false, message: `Only ${freeSpace} cargo space available.` };
    const cost = unitPrice * amount;
    if (player.credits < cost) return { success: false, message: `Need ${cost} credits, you have ${player.credits}.` };

    const exec = db.transaction(() => {
      db.prepare(`UPDATE players SET credits = credits - ? WHERE id = ?`).run(cost, playerId);
      db.prepare(`UPDATE ships SET ${commodity} = ${commodity} + ? WHERE id = ?`).run(amount, ship.id);
      db.prepare(`UPDATE ports SET ${qtyCol} = ${qtyCol} - ? WHERE sector_id = ?`).run(amount, player.current_sector);
      // Alignment: class 8 = underground
      const alignDelta = port.class === 8 ? -1 : 1;
      db.prepare('UPDATE players SET alignment = alignment + ?, experience = experience + ? WHERE id = ?').run(alignDelta, amount, playerId);
    });
    exec();

    const updated = db.prepare('SELECT credits FROM players WHERE id = ?').get(playerId);
    const updatedShip = db.prepare('SELECT ore, organics, equipment, colonists FROM ships WHERE id = ?').get(ship.id);
    return { success: true, message: `Bought ${amount} ${commodity} for ${unitPrice * amount} credits.`, credits: updated.credits, cargo: updatedShip };
  } else {
    // Player sells to port: port must be buying (buying=1)
    if (port[buyingCol] === 0) return { success: false, message: `Port is not buying ${commodity}.` };
    if (ship[commodity] < amount) return { success: false, message: `You only have ${ship[commodity]} ${commodity}.` };
    const revenue = unitPrice * amount;

    const exec = db.transaction(() => {
      db.prepare('UPDATE players SET credits = credits + ? WHERE id = ?').run(revenue, playerId);
      db.prepare(`UPDATE ships SET ${commodity} = ${commodity} - ? WHERE id = ?`).run(amount, ship.id);
      db.prepare(`UPDATE ports SET ${qtyCol} = ${qtyCol} + ? WHERE sector_id = ?`).run(amount, player.current_sector);
      const alignDelta = port.class === 8 ? -1 : 1;
      db.prepare('UPDATE players SET alignment = alignment + ?, experience = experience + ? WHERE id = ?').run(alignDelta, amount, playerId);
    });
    exec();

    const updated = db.prepare('SELECT credits FROM players WHERE id = ?').get(playerId);
    const updatedShip = db.prepare('SELECT ore, organics, equipment, colonists FROM ships WHERE id = ?').get(ship.id);
    return { success: true, message: `Sold ${amount} ${commodity} for ${revenue} credits.`, credits: updated.credits, cargo: updatedShip };
  }
}

function getPortInfo(db, sectorId) {
  return db.prepare('SELECT * FROM ports WHERE sector_id = ?').get(sectorId) || null;
}

function regenPorts(db) {
  const ports = db.prepare('SELECT * FROM ports').all();
  const maxStock = 1000;
  const regenRate = 0.05;
  const update = db.prepare(`UPDATE ports SET ore_quantity = MIN(?, ore_quantity + ?), organics_quantity = MIN(?, organics_quantity + ?), equipment_quantity = MIN(?, equipment_quantity + ?), last_regen = CURRENT_TIMESTAMP WHERE id = ?`);

  const exec = db.transaction(() => {
    for (const port of ports) {
      const oreGain = Math.floor(maxStock * regenRate);
      const orgGain = Math.floor(maxStock * regenRate);
      const eqGain = Math.floor(maxStock * regenRate);
      update.run(maxStock, oreGain, maxStock, orgGain, maxStock, eqGain, port.id);
    }
  });
  exec();
}

// ============================================================
// PLAYER MARKET (EVE-style)
// ============================================================

function placeMarketOrder(db, playerId, commodity, orderType, quantity, price) {
  if (!['buy', 'sell'].includes(orderType)) return { success: false, message: 'Invalid order type.' };
  if (!['ore', 'organics', 'equipment'].includes(commodity)) return { success: false, message: 'Invalid commodity.' };
  quantity = Math.floor(quantity);
  price = Math.floor(price);
  if (quantity <= 0 || price <= 0) return { success: false, message: 'Quantity and price must be positive.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const ship = db.prepare(`SELECT s.*, st.cargo_capacity FROM ships s JOIN ship_types st ON s.type_id = st.id WHERE s.player_id = ? AND s.active = 1`).get(playerId);
  if (!ship) return { success: false, message: 'No active ship.' };

  if (orderType === 'sell') {
    if (ship[commodity] < quantity) return { success: false, message: `Insufficient ${commodity} on ship.` };
  } else {
    const totalCost = quantity * price;
    if (player.credits < totalCost) return { success: false, message: `Need ${totalCost} credits.` };
  }

  const result = db.transaction(() => {
    if (orderType === 'sell') {
      db.prepare(`UPDATE ships SET ${commodity} = ${commodity} - ? WHERE id = ?`).run(quantity, ship.id);
    } else {
      db.prepare('UPDATE players SET credits = credits - ? WHERE id = ?').run(quantity * price, playerId);
    }

    db.prepare(`INSERT INTO market_orders (player_id, sector_id, commodity, order_type, quantity, price) VALUES (?, ?, ?, ?, ?, ?)`).run(playerId, player.current_sector, commodity, orderType, quantity, price);
    const orderId = db.prepare('SELECT last_insert_rowid() as id').get().id;

    processMarketMatches(db, player.current_sector, commodity);
    return { success: true, message: 'Order placed.', orderId };
  })();

  return result;
}

function getMarketOrders(db, sectorId, commodity) {
  return db.prepare(`SELECT mo.*, p.name as player_name FROM market_orders mo JOIN players p ON mo.player_id = p.id WHERE mo.sector_id = ? AND mo.commodity = ? AND mo.quantity > mo.filled ORDER BY mo.price ASC, mo.created_at ASC`).all(sectorId, commodity);
}

function cancelMarketOrder(db, playerId, orderId) {
  const order = db.prepare('SELECT * FROM market_orders WHERE id = ? AND player_id = ?').get(orderId, playerId);
  if (!order) return { success: false, message: 'Order not found.' };
  const remaining = order.quantity - order.filled;
  if (remaining <= 0) return { success: false, message: 'Order already fully filled.' };

  const exec = db.transaction(() => {
    if (order.order_type === 'sell') {
      db.prepare(`UPDATE ships SET ${order.commodity} = ${order.commodity} + ? WHERE player_id = ? AND active = 1`).run(remaining, playerId);
    } else {
      db.prepare('UPDATE players SET credits = credits + ? WHERE id = ?').run(remaining * order.price, playerId);
    }
    db.prepare('DELETE FROM market_orders WHERE id = ?').run(orderId);
  });
  exec();

  return { success: true, message: `Order cancelled. ${remaining} ${order.commodity} returned.` };
}

function processMarketMatches(db, sectorId, commodity) {
  const buyOrders = db.prepare(`SELECT * FROM market_orders WHERE sector_id = ? AND commodity = ? AND order_type = 'buy' AND quantity > filled ORDER BY price DESC, created_at ASC`).all(sectorId, commodity);
  const sellOrders = db.prepare(`SELECT * FROM market_orders WHERE sector_id = ? AND commodity = ? AND order_type = 'sell' AND quantity > filled ORDER BY price ASC, created_at ASC`).all(sectorId, commodity);

  for (const buy of buyOrders) {
    let buyRemaining = buy.quantity - buy.filled;
    for (const sell of sellOrders) {
      if (buyRemaining <= 0) break;
      if (sell.price > buy.price) break;
      let sellRemaining = sell.quantity - sell.filled;
      if (sellRemaining <= 0) continue;

      const matchQty = Math.min(buyRemaining, sellRemaining);
      const matchPrice = sell.price; // Seller's price (earlier order)

      db.prepare('UPDATE market_orders SET filled = filled + ? WHERE id = ?').run(matchQty, buy.id);
      db.prepare('UPDATE market_orders SET filled = filled + ? WHERE id = ?').run(matchQty, sell.id);

      // Deliver goods to buyer's ship
      db.prepare(`UPDATE ships SET ${commodity} = ${commodity} + ? WHERE player_id = ? AND active = 1`).run(matchQty, buy.player_id);
      // Pay seller
      db.prepare('UPDATE players SET credits = credits + ? WHERE id = ?').run(matchQty * matchPrice, sell.player_id);
      // Refund buyer price difference
      const refund = (buy.price - matchPrice) * matchQty;
      if (refund > 0) {
        db.prepare('UPDATE players SET credits = credits + ? WHERE id = ?').run(refund, buy.player_id);
      }

      buyRemaining -= matchQty;
      sell.filled += matchQty;
    }
  }

  // Clean up fully filled orders
  db.prepare(`DELETE FROM market_orders WHERE sector_id = ? AND commodity = ? AND quantity <= filled`).run(sectorId, commodity);
}

// ============================================================
// SHIPS
// ============================================================

function getShipTypes(db) {
  return db.prepare('SELECT * FROM ship_types').all();
}

function getPlayerShip(db, playerId) {
  return db.prepare(`SELECT s.*, st.name as type_name, st.cargo_capacity, st.fighter_capacity, st.mine_capacity, st.shield_capacity, st.scanner_range, st.has_transwarp, st.has_photon, st.combat_odds, st.base_cost FROM ships s JOIN ship_types st ON s.type_id = st.id WHERE s.player_id = ? AND s.active = 1`).get(playerId) || null;
}

function buyShip(db, playerId, shipTypeId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const sector = db.prepare('SELECT * FROM sectors WHERE id = ?').get(player.current_sector);
  if (!sector || !sector.has_stardock) return { success: false, message: 'Must be at StarDock to buy ships.' };

  const newType = db.prepare('SELECT * FROM ship_types WHERE id = ?').get(shipTypeId);
  if (!newType) return { success: false, message: 'Ship type not found.' };

  if (player.alignment < newType.min_alignment || player.alignment > newType.max_alignment) {
    return { success: false, message: `Alignment must be between ${newType.min_alignment} and ${newType.max_alignment}.` };
  }

  const oldShip = db.prepare(`SELECT s.*, st.base_cost as old_cost FROM ships s JOIN ship_types st ON s.type_id = st.id WHERE s.player_id = ? AND s.active = 1`).get(playerId);

  const tradeInValue = oldShip ? Math.floor(oldShip.old_cost * 0.6) : 0;
  const netCost = newType.base_cost - tradeInValue;

  if (player.credits < netCost) return { success: false, message: `Need ${netCost} credits (after trade-in of ${tradeInValue}).` };

  const exec = db.transaction(() => {
    db.prepare('UPDATE players SET credits = credits - ? WHERE id = ?').run(netCost, playerId);

    if (oldShip) {
      db.prepare('UPDATE ships SET active = 0 WHERE id = ?').run(oldShip.id);
    }

    const carryOre = oldShip ? Math.min(oldShip.ore, newType.cargo_capacity) : 0;
    const carryOrg = oldShip ? Math.min(oldShip.organics, newType.cargo_capacity - carryOre) : 0;
    const carryEq = oldShip ? Math.min(oldShip.equipment, newType.cargo_capacity - carryOre - carryOrg) : 0;
    const carryCol = oldShip ? Math.min(oldShip.colonists, newType.cargo_capacity - carryOre - carryOrg - carryEq) : 0;
    const carryFighters = oldShip ? Math.min(oldShip.fighters, newType.fighter_capacity) : 0;
    const carryMines = oldShip ? Math.min(oldShip.mines, newType.mine_capacity) : 0;

    db.prepare(`INSERT INTO ships (player_id, type_id, name, ore, organics, equipment, colonists, fighters, mines, shields, max_shields, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
      playerId, shipTypeId, oldShip ? oldShip.name : 'Unnamed Vessel',
      carryOre, carryOrg, carryEq, carryCol,
      carryFighters, carryMines,
      newType.shield_capacity, newType.shield_capacity
    );
  });
  exec();

  return { success: true, message: `Purchased ${newType.name}. Trade-in value: ${tradeInValue}.` };
}

function getTotalCargo(ship) {
  return (ship.ore || 0) + (ship.organics || 0) + (ship.equipment || 0) + (ship.colonists || 0);
}

// ============================================================
// MOVEMENT
// ============================================================

function moveToSector(db, playerId, targetSector) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const navSkill = getSkillBonus(db, playerId, 'Navigation');
  const turnCost = navSkill >= 1 ? 0.5 : 1;
  if (player.turns_remaining < turnCost) return { success: false, message: 'Not enough turns.' };

  // Check warp connection or wormhole
  const warp = db.prepare('SELECT * FROM sector_warps WHERE from_sector = ? AND to_sector = ?').get(player.current_sector, targetSector);
  const wormhole = db.prepare(`SELECT * FROM wormholes WHERE ((sector_a = ? AND sector_b = ?) OR (sector_a = ? AND sector_b = ?)) AND expires_at > CURRENT_TIMESTAMP`).get(player.current_sector, targetSector, targetSector, player.current_sector);

  if (!warp && !wormhole) return { success: false, message: 'No warp connection to that sector.' };

  const events = [];

  const result = db.transaction(() => {
    // Deduct turns (store fractional as integer: multiply by 2 for half-turn support)
    const turnsToDeduct = Math.ceil(turnCost);
    db.prepare('UPDATE players SET turns_remaining = turns_remaining - ?, current_sector = ? WHERE id = ?').run(turnsToDeduct, targetSector, playerId);

    // Check for mines
    const mines = db.prepare('SELECT * FROM sector_mines WHERE sector_id = ? AND owner_id != ?').all(targetSector, playerId);
    const mineSkill = getSkillBonus(db, playerId, 'Mine Warfare');
    for (const mineGroup of mines) {
      // Also skip corp-mate mines
      const mineOwner = db.prepare('SELECT corp_id FROM players WHERE id = ?').get(mineGroup.owner_id);
      if (player.corp_id && mineOwner && mineOwner.corp_id === player.corp_id) continue;

      const baseDamage = mineGroup.type === 'armored' ? mineGroup.quantity * 3 : mineGroup.quantity * 2;
      const reduction = mineSkill * 0.1;
      const damage = Math.floor(baseDamage * (1 - reduction));

      if (damage > 0) {
        db.prepare('UPDATE ships SET shields = MAX(0, shields - ?) WHERE player_id = ? AND active = 1').run(damage, playerId);
        events.push({ type: 'mine_hit', damage, mineType: mineGroup.type, quantity: mineGroup.quantity });

        // Remove some mines on hit
        const minesDestroyed = Math.floor(mineGroup.quantity * 0.25);
        db.prepare('UPDATE sector_mines SET quantity = quantity - ? WHERE id = ?').run(minesDestroyed, mineGroup.id);
        db.prepare('DELETE FROM sector_mines WHERE quantity <= 0').run();
      }

      // Check if ship destroyed
      const shipAfter = db.prepare('SELECT shields FROM ships WHERE player_id = ? AND active = 1').get(playerId);
      if (shipAfter && shipAfter.shields <= 0) {
        respawnPlayer(db, playerId);
        events.push({ type: 'destroyed', message: 'Your ship was destroyed by mines!' });
        return { success: false, message: 'Ship destroyed by mines!', sector: 1, events };
      }
    }

    // Check for enemy fighters
    const fighters = db.prepare(`SELECT * FROM sector_fighters WHERE sector_id = ? AND owner_id != ? AND mode = 'offensive'`).all(targetSector, playerId);
    for (const fg of fighters) {
      const fgOwner = db.prepare('SELECT corp_id FROM players WHERE id = ?').get(fg.owner_id);
      if (player.corp_id && fgOwner && fgOwner.corp_id === player.corp_id) continue;

      const damage = fg.quantity;
      db.prepare('UPDATE ships SET shields = MAX(0, shields - ?) WHERE player_id = ? AND active = 1').run(damage, playerId);
      const lost = Math.floor(fg.quantity * 0.1);
      db.prepare('UPDATE sector_fighters SET quantity = quantity - ? WHERE id = ?').run(lost, fg.id);
      db.prepare('DELETE FROM sector_fighters WHERE quantity <= 0').run();
      events.push({ type: 'fighter_attack', damage, owner: fg.owner_id });

      const shipAfter = db.prepare('SELECT shields FROM ships WHERE player_id = ? AND active = 1').get(playerId);
      if (shipAfter && shipAfter.shields <= 0) {
        respawnPlayer(db, playerId);
        events.push({ type: 'destroyed', message: 'Your ship was destroyed by sector fighters!' });
        return { success: false, message: 'Ship destroyed by fighters!', sector: 1, events };
      }
    }

    return { success: true, message: `Moved to sector ${targetSector}.`, sector: targetSector, events };
  })();

  return result;
}

function getSectorInfo(db, sectorId, playerId) {
  const sector = db.prepare('SELECT * FROM sectors WHERE id = ?').get(sectorId);
  if (!sector) return null;

  const warps = db.prepare('SELECT to_sector FROM sector_warps WHERE from_sector = ?').all(sectorId).map(r => r.to_sector);
  const port = db.prepare('SELECT * FROM ports WHERE sector_id = ?').get(sectorId) || null;
  const planets = db.prepare('SELECT p.id, p.name, p.class, p.owner_id, p.citadel_level, pl.name as owner_name FROM planets p LEFT JOIN players pl ON p.owner_id = pl.id WHERE p.sector_id = ?').all(sectorId);
  const shipsPresent = db.prepare(`SELECT p.id, p.name, p.alignment FROM players p WHERE p.current_sector = ? AND p.id != ? AND p.online = 1`).all(sectorId, playerId);
  const fighters = db.prepare('SELECT sf.*, p.name as owner_name FROM sector_fighters sf JOIN players p ON sf.owner_id = p.id WHERE sf.sector_id = ?').all(sectorId);
  const mines = db.prepare('SELECT sm.*, p.name as owner_name FROM sector_mines sm JOIN players p ON sm.owner_id = p.id WHERE sm.sector_id = ?').all(sectorId);
  const wormholes = db.prepare(`SELECT * FROM wormholes WHERE (sector_a = ? OR sector_b = ?) AND expires_at > CURRENT_TIMESTAMP`).all(sectorId, sectorId);
  const npcsPresent = db.prepare('SELECT id, type, name FROM npcs WHERE sector_id = ?').all(sectorId);

  // Scanner range - show nearby sectors
  let scannedSectors = null;
  if (playerId) {
    const ship = getPlayerShip(db, playerId);
    if (ship) {
      const scanRange = ship.scanner_range + getSkillBonus(db, playerId, 'Scanner Operations');
      if (scanRange > 0) {
        scannedSectors = scanNearbySectors(db, sectorId, scanRange);
      }
    }
  }

  return {
    ...sector,
    warps,
    port,
    planets,
    ships: shipsPresent,
    fighters,
    mines,
    beacon: sector.beacon_text,
    wormholes,
    npcs: npcsPresent,
    scannedSectors
  };
}

function scanNearbySectors(db, sectorId, range) {
  const visited = new Set([sectorId]);
  let frontier = [sectorId];
  const result = [];

  for (let depth = 1; depth <= range; depth++) {
    const next = [];
    for (const sid of frontier) {
      const warps = db.prepare('SELECT to_sector FROM sector_warps WHERE from_sector = ?').all(sid);
      for (const w of warps) {
        if (!visited.has(w.to_sector)) {
          visited.add(w.to_sector);
          next.push(w.to_sector);
          const port = db.prepare('SELECT class FROM ports WHERE sector_id = ?').get(w.to_sector);
          const shipCount = db.prepare(`SELECT COUNT(*) as c FROM players WHERE current_sector = ? AND online = 1`).get(w.to_sector).c;
          result.push({ sectorId: w.to_sector, distance: depth, hasPort: !!port, portClass: port ? port.class : null, ships: shipCount });
        }
      }
    }
    frontier = next;
  }
  return result;
}

// ============================================================
// COMBAT
// ============================================================

function attackPlayer(db, attackerId, defenderId) {
  const attacker = db.prepare('SELECT * FROM players WHERE id = ?').get(attackerId);
  const defender = db.prepare('SELECT * FROM players WHERE id = ?').get(defenderId);
  if (!attacker || !defender) return { success: false, message: 'Player not found.' };
  if (attacker.current_sector !== defender.current_sector) return { success: false, message: 'Target not in your sector.' };

  const aShip = getPlayerShip(db, attackerId);
  const dShip = getPlayerShip(db, defenderId);
  if (!aShip || !dShip) return { success: false, message: 'Ship not found.' };

  const aCombatSkill = getSkillBonus(db, attackerId, 'Combat Tactics');
  const dCombatSkill = getSkillBonus(db, defenderId, 'Combat Tactics');
  const aWeaponsSkill = getSkillBonus(db, attackerId, 'Weapons Systems');
  const dWeaponsSkill = getSkillBonus(db, defenderId, 'Weapons Systems');
  const aShieldSkill = getSkillBonus(db, attackerId, 'Shield Management');
  const dShieldSkill = getSkillBonus(db, defenderId, 'Shield Management');

  const combatLog = [];
  let aShields = aShip.shields;
  let dShields = dShip.shields;
  let aFighters = aShip.fighters;
  let dFighters = dShip.fighters;

  const maxRounds = 20;
  for (let round = 1; round <= maxRounds; round++) {
    // Attacker's turn
    const aHitChance = (aShip.combat_odds + aCombatSkill * 2) / 100;
    if (Math.random() < aHitChance) {
      const baseDmg = Math.max(1, Math.floor(aFighters * 0.1 * (1 + aWeaponsSkill * 0.05)));
      const shieldReduction = dShieldSkill * 0.05;
      const dmg = Math.max(1, Math.floor(baseDmg * (1 - shieldReduction)));
      dShields -= dmg;
      const fLost = Math.floor(Math.random() * Math.max(1, Math.floor(dFighters * 0.05)));
      dFighters = Math.max(0, dFighters - fLost);
      combatLog.push({ round, actor: 'attacker', hit: true, damage: dmg, fightersLost: fLost });
    } else {
      combatLog.push({ round, actor: 'attacker', hit: false });
    }

    if (dShields <= 0) break;

    // Defender's turn
    const dHitChance = (dShip.combat_odds + dCombatSkill * 2) / 100;
    if (Math.random() < dHitChance) {
      const baseDmg = Math.max(1, Math.floor(dFighters * 0.1 * (1 + dWeaponsSkill * 0.05)));
      const shieldReduction = aShieldSkill * 0.05;
      const dmg = Math.max(1, Math.floor(baseDmg * (1 - shieldReduction)));
      aShields -= dmg;
      const fLost = Math.floor(Math.random() * Math.max(1, Math.floor(aFighters * 0.05)));
      aFighters = Math.max(0, aFighters - fLost);
      combatLog.push({ round, actor: 'defender', hit: true, damage: dmg, fightersLost: fLost });
    } else {
      combatLog.push({ round, actor: 'defender', hit: false });
    }

    if (aShields <= 0) break;
  }

  const result = db.transaction(() => {
    let winner, loser, winnerIsAttacker;
    if (dShields <= 0) {
      winner = attacker; loser = defender; winnerIsAttacker = true;
    } else if (aShields <= 0) {
      winner = defender; loser = attacker; winnerIsAttacker = false;
    } else {
      // Draw - both survive with remaining shields
      db.prepare('UPDATE ships SET shields = ?, fighters = ? WHERE id = ?').run(Math.max(0, aShields), aFighters, aShip.id);
      db.prepare('UPDATE ships SET shields = ?, fighters = ? WHERE id = ?').run(Math.max(0, dShields), dFighters, dShip.id);
      db.prepare(`INSERT INTO combat_log (attacker_id, defender_id, sector_id, result, details) VALUES (?, ?, ?, 'draw', ?)`).run(attackerId, defenderId, attacker.current_sector, JSON.stringify(combatLog));
      return { success: true, result: 'draw', message: 'Combat ended in a draw.', log: combatLog };
    }

    // Alignment change
    let alignDelta;
    if (loser.alignment >= 0) {
      alignDelta = -50; // Killed a good/neutral player
    } else {
      alignDelta = 10; // Killed an evil player
    }
    db.prepare('UPDATE players SET alignment = alignment + ?, kills = kills + ?, experience = experience + 100 WHERE id = ?').run(alignDelta, 1, winner.id);
    db.prepare('UPDATE players SET deaths = deaths + 1 WHERE id = ?').run(loser.id);

    // Update winner ship
    const winShipId = winnerIsAttacker ? aShip.id : dShip.id;
    const winShields = winnerIsAttacker ? aShields : dShields;
    const winFighters = winnerIsAttacker ? aFighters : dFighters;
    db.prepare('UPDATE ships SET shields = ?, fighters = ? WHERE id = ?').run(Math.max(1, winShields), winFighters, winShipId);

    // Respawn loser
    respawnPlayer(db, loser.id);

    db.prepare(`INSERT INTO combat_log (attacker_id, defender_id, sector_id, result, details) VALUES (?, ?, ?, ?, ?)`).run(
      attackerId, defenderId, attacker.current_sector,
      winnerIsAttacker ? 'attacker_wins' : 'defender_wins',
      JSON.stringify(combatLog)
    );

    return {
      success: true,
      result: winnerIsAttacker ? 'attacker_wins' : 'defender_wins',
      winner: winner.name,
      loser: loser.name,
      alignmentChange: alignDelta,
      log: combatLog
    };
  })();

  return result;
}

function respawnPlayer(db, playerId) {
  // Deactivate old ship
  db.prepare('UPDATE ships SET active = 0 WHERE player_id = ? AND active = 1').run(playerId);
  // Give Merchant Cruiser (type 1) and 5000 credits
  const mcType = db.prepare("SELECT id FROM ship_types WHERE name = 'Merchant Cruiser'").get();
  const typeId = mcType ? mcType.id : 1;
  db.prepare(`INSERT INTO ships (player_id, type_id, name, shields, max_shields, active) VALUES (?, ?, 'Escape Pod', 100, 100, 1)`).run(playerId, typeId);
  db.prepare('UPDATE players SET credits = 5000, current_sector = 1 WHERE id = ?').run(playerId);
}

function deployFighters(db, playerId, quantity, mode) {
  if (!['offensive', 'defensive'].includes(mode)) return { success: false, message: 'Mode must be offensive or defensive.' };
  quantity = Math.floor(quantity);
  if (quantity <= 0) return { success: false, message: 'Quantity must be positive.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const ship = getPlayerShip(db, playerId);
  if (!ship) return { success: false, message: 'No active ship.' };
  if (ship.fighters < quantity) return { success: false, message: `Only have ${ship.fighters} fighters.` };

  const exec = db.transaction(() => {
    db.prepare('UPDATE ships SET fighters = fighters - ? WHERE id = ?').run(quantity, ship.id);
    const existing = db.prepare('SELECT * FROM sector_fighters WHERE sector_id = ? AND owner_id = ? AND mode = ?').get(player.current_sector, playerId, mode);
    if (existing) {
      db.prepare('UPDATE sector_fighters SET quantity = quantity + ? WHERE id = ?').run(quantity, existing.id);
    } else {
      db.prepare('INSERT INTO sector_fighters (sector_id, owner_id, quantity, mode) VALUES (?, ?, ?, ?)').run(player.current_sector, playerId, quantity, mode);
    }
  });
  exec();

  return { success: true, message: `Deployed ${quantity} ${mode} fighters in sector ${player.current_sector}.` };
}

function deployMines(db, playerId, quantity, type) {
  if (!['regular', 'armored'].includes(type)) return { success: false, message: 'Type must be regular or armored.' };
  quantity = Math.floor(quantity);
  if (quantity <= 0) return { success: false, message: 'Quantity must be positive.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const ship = getPlayerShip(db, playerId);
  if (!ship) return { success: false, message: 'No active ship.' };
  if (ship.mines < quantity) return { success: false, message: `Only have ${ship.mines} mines.` };

  const exec = db.transaction(() => {
    db.prepare('UPDATE ships SET mines = mines - ? WHERE id = ?').run(quantity, ship.id);
    const existing = db.prepare('SELECT * FROM sector_mines WHERE sector_id = ? AND owner_id = ? AND type = ?').get(player.current_sector, playerId, type);
    if (existing) {
      db.prepare('UPDATE sector_mines SET quantity = quantity + ? WHERE id = ?').run(quantity, existing.id);
    } else {
      db.prepare('INSERT INTO sector_mines (sector_id, owner_id, quantity, type) VALUES (?, ?, ?, ?)').run(player.current_sector, playerId, quantity, type);
    }
  });
  exec();

  return { success: true, message: `Deployed ${quantity} ${type} mines in sector ${player.current_sector}.` };
}

function collectFighters(db, playerId, quantity) {
  quantity = Math.floor(quantity);
  if (quantity <= 0) return { success: false, message: 'Quantity must be positive.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const ship = getPlayerShip(db, playerId);
  if (!ship) return { success: false, message: 'No active ship.' };

  const deployed = db.prepare('SELECT * FROM sector_fighters WHERE sector_id = ? AND owner_id = ?').all(player.current_sector, playerId);
  const totalAvailable = deployed.reduce((sum, f) => sum + f.quantity, 0);
  if (totalAvailable < quantity) return { success: false, message: `Only ${totalAvailable} fighters available.` };

  const spaceAvailable = ship.fighter_capacity - ship.fighters;
  if (spaceAvailable < quantity) return { success: false, message: `Only room for ${spaceAvailable} more fighters.` };

  const exec = db.transaction(() => {
    let remaining = quantity;
    for (const fg of deployed) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, fg.quantity);
      db.prepare('UPDATE sector_fighters SET quantity = quantity - ? WHERE id = ?').run(take, fg.id);
      remaining -= take;
    }
    db.prepare('DELETE FROM sector_fighters WHERE quantity <= 0').run();
    db.prepare('UPDATE ships SET fighters = fighters + ? WHERE id = ?').run(quantity, ship.id);
  });
  exec();

  return { success: true, message: `Collected ${quantity} fighters.` };
}

// ============================================================
// PLANETS
// ============================================================

function landOnPlanet(db, playerId, planetId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const planet = db.prepare('SELECT p.*, pl.name as owner_name FROM planets p LEFT JOIN players pl ON p.owner_id = pl.id WHERE p.id = ?').get(planetId);
  if (!planet) return { success: false, message: 'Planet not found.' };
  if (planet.sector_id !== player.current_sector) return { success: false, message: 'Planet is not in your sector.' };

  return { success: true, planet };
}

function claimPlanet(db, playerId, planetId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };
  if (player.credits < 1000) return { success: false, message: 'Need 1000 credits to claim a planet.' };

  const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(planetId);
  if (!planet) return { success: false, message: 'Planet not found.' };
  if (planet.sector_id !== player.current_sector) return { success: false, message: 'Planet is not in your sector.' };
  if (planet.owner_id) return { success: false, message: 'Planet is already owned.' };

  const exec = db.transaction(() => {
    db.prepare('UPDATE players SET credits = credits - 1000 WHERE id = ?').run(playerId);
    db.prepare('UPDATE planets SET owner_id = ? WHERE id = ?').run(playerId, planetId);
  });
  exec();

  return { success: true, message: 'Planet claimed!' };
}

function renamePlanet(db, playerId, planetId, newName) {
  if (!newName || typeof newName !== 'string') return { success: false, message: 'Invalid name.' };
  newName = newName.trim();
  if (newName.length === 0 || newName.length > 30) return { success: false, message: 'Name must be 1-30 characters.' };

  const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(planetId);
  if (!planet) return { success: false, message: 'Planet not found.' };
  if (planet.owner_id !== playerId) return { success: false, message: 'You do not own this planet.' };

  db.prepare('UPDATE planets SET name = ? WHERE id = ?').run(newName, planetId);
  return { success: true, message: `Planet renamed to ${newName}.` };
}

function transferToPlanet(db, playerId, planetId, commodity, amount) {
  if (!['ore', 'organics', 'equipment', 'colonists', 'fuel_ore', 'fighters'].includes(commodity)) {
    return { success: false, message: 'Invalid commodity.' };
  }
  amount = Math.floor(amount);
  if (amount <= 0) return { success: false, message: 'Amount must be positive.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(planetId);
  if (!planet) return { success: false, message: 'Planet not found.' };
  if (planet.sector_id !== player.current_sector) return { success: false, message: 'Planet not in your sector.' };
  if (planet.owner_id !== playerId) {
    // Check corp ownership
    if (!player.corp_id) return { success: false, message: 'Not your planet.' };
    const owner = db.prepare('SELECT corp_id FROM players WHERE id = ?').get(planet.owner_id);
    if (!owner || owner.corp_id !== player.corp_id) return { success: false, message: 'Not your planet.' };
  }

  const ship = getPlayerShip(db, playerId);
  if (!ship) return { success: false, message: 'No active ship.' };

  const shipCol = commodity === 'fuel_ore' ? 'ore' : commodity;
  if (ship[shipCol] < amount) return { success: false, message: `Only ${ship[shipCol]} ${commodity} on ship.` };

  const exec = db.transaction(() => {
    db.prepare(`UPDATE ships SET ${shipCol} = ${shipCol} - ? WHERE id = ?`).run(amount, ship.id);
    db.prepare(`UPDATE planets SET ${commodity} = ${commodity} + ? WHERE id = ?`).run(amount, planetId);
  });
  exec();

  return { success: true, message: `Transferred ${amount} ${commodity} to planet.` };
}

function transferFromPlanet(db, playerId, planetId, commodity, amount) {
  if (!['ore', 'organics', 'equipment', 'colonists', 'fuel_ore', 'fighters'].includes(commodity)) {
    return { success: false, message: 'Invalid commodity.' };
  }
  amount = Math.floor(amount);
  if (amount <= 0) return { success: false, message: 'Amount must be positive.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(planetId);
  if (!planet) return { success: false, message: 'Planet not found.' };
  if (planet.sector_id !== player.current_sector) return { success: false, message: 'Planet not in your sector.' };
  if (planet.owner_id !== playerId) {
    if (!player.corp_id) return { success: false, message: 'Not your planet.' };
    const owner = db.prepare('SELECT corp_id FROM players WHERE id = ?').get(planet.owner_id);
    if (!owner || owner.corp_id !== player.corp_id) return { success: false, message: 'Not your planet.' };
  }

  if (planet[commodity] < amount) return { success: false, message: `Only ${planet[commodity]} ${commodity} on planet.` };

  const ship = getPlayerShip(db, playerId);
  if (!ship) return { success: false, message: 'No active ship.' };

  const shipCol = commodity === 'fuel_ore' ? 'ore' : commodity;
  if (['ore', 'organics', 'equipment', 'colonists'].includes(commodity)) {
    const totalCargo = getTotalCargo(ship);
    if (totalCargo + amount > ship.cargo_capacity) return { success: false, message: 'Not enough cargo space.' };
  } else if (commodity === 'fighters') {
    if (ship.fighters + amount > ship.fighter_capacity) return { success: false, message: 'Not enough fighter capacity.' };
  }

  const exec = db.transaction(() => {
    db.prepare(`UPDATE planets SET ${commodity} = ${commodity} - ? WHERE id = ?`).run(amount, planetId);
    db.prepare(`UPDATE ships SET ${shipCol} = ${shipCol} + ? WHERE id = ?`).run(amount, ship.id);
  });
  exec();

  return { success: true, message: `Transferred ${amount} ${commodity} from planet.` };
}

function buildCitadel(db, playerId, planetId) {
  const costs = { 1: 50000, 2: 100000, 3: 200000, 4: 500000, 5: 1000000 };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(planetId);
  if (!planet) return { success: false, message: 'Planet not found.' };
  if (planet.owner_id !== playerId) return { success: false, message: 'Not your planet.' };
  if (planet.sector_id !== player.current_sector) return { success: false, message: 'Planet not in your sector.' };

  const nextLevel = planet.citadel_level + 1;
  if (nextLevel > 5) return { success: false, message: 'Citadel already at maximum level.' };

  const citadelSkill = getSkillBonus(db, playerId, 'Citadel Engineering');
  const discount = citadelSkill * 0.1;
  const cost = Math.floor(costs[nextLevel] * (1 - discount));

  if (player.credits < cost) return { success: false, message: `Need ${cost} credits.` };

  const eqRequired = nextLevel * 100;
  if (planet.equipment < eqRequired) return { success: false, message: `Need ${eqRequired} equipment on planet.` };

  const exec = db.transaction(() => {
    db.prepare('UPDATE players SET credits = credits - ? WHERE id = ?').run(cost, playerId);
    db.prepare('UPDATE planets SET citadel_level = ?, equipment = equipment - ? WHERE id = ?').run(nextLevel, eqRequired, planetId);
  });
  exec();

  return { success: true, message: `Citadel upgraded to level ${nextLevel}.` };
}

function upgradeCitadelModule(db, playerId, planetId, module) {
  const modules = {
    combat_computer: { creditCost: 25000, eqCost: 50, maxLevel: 5 },
    quasar_cannon: { creditCost: 50000, eqCost: 100, maxLevel: 5 },
    transwarp: { creditCost: 100000, eqCost: 200, maxLevel: 1 },
    interdictor: { creditCost: 75000, eqCost: 150, maxLevel: 1 },
    planetary_shields: { creditCost: 30000, eqCost: 75, maxLevel: 5 }
  };

  if (!modules[module]) return { success: false, message: 'Invalid module.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(planetId);
  if (!planet) return { success: false, message: 'Planet not found.' };
  if (planet.owner_id !== playerId) return { success: false, message: 'Not your planet.' };
  if (planet.citadel_level < 1) return { success: false, message: 'Must build a citadel first.' };

  const mod = modules[module];
  const isBoolean = mod.maxLevel === 1;
  const currentLevel = isBoolean ? planet[module] : (planet[module] || 0);

  if (isBoolean && currentLevel >= 1) return { success: false, message: `${module} already installed.` };
  if (!isBoolean && currentLevel >= mod.maxLevel) return { success: false, message: `${module} already at max level.` };

  const levelMultiplier = isBoolean ? 1 : currentLevel + 1;
  const creditCost = mod.creditCost * levelMultiplier;
  const eqCost = mod.eqCost * levelMultiplier;

  if (player.credits < creditCost) return { success: false, message: `Need ${creditCost} credits.` };
  if (planet.equipment < eqCost) return { success: false, message: `Need ${eqCost} equipment on planet.` };

  const colName = module === 'transwarp' ? 'has_transwarp' : module === 'interdictor' ? 'has_interdictor' : module;

  const exec = db.transaction(() => {
    db.prepare('UPDATE players SET credits = credits - ? WHERE id = ?').run(creditCost, playerId);
    db.prepare(`UPDATE planets SET ${colName} = ${colName} + 1, equipment = equipment - ? WHERE id = ?`).run(eqCost, planetId);
  });
  exec();

  return { success: true, message: `${module} upgraded.` };
}

function runPlanetProduction(db) {
  const planets = db.prepare('SELECT * FROM planets WHERE owner_id IS NOT NULL AND colonists > 0').all();

  const update = db.prepare(`UPDATE planets SET ore = ore + ?, organics = organics + ?, equipment = equipment + ?, fuel_ore = fuel_ore + ?, treasury = treasury + ?, last_production = CURRENT_TIMESTAMP WHERE id = ?`);

  const exec = db.transaction(() => {
    for (const planet of planets) {
      const owner = db.prepare('SELECT id FROM players WHERE id = ?').get(planet.owner_id);
      if (!owner) continue;

      const adminSkill = getSkillBonus(db, planet.owner_id, 'Colonial Admin');
      const rate = planet.production_rate * (1 + adminSkill * 0.1);
      const colonistUnits = Math.floor(planet.colonists / 100);
      if (colonistUnits <= 0) continue;

      const oreGain = Math.floor(3 * rate * colonistUnits);
      const orgGain = Math.floor(2 * rate * colonistUnits);
      const eqGain = Math.floor(1 * rate * colonistUnits);
      const fuelGain = Math.floor(2 * rate * colonistUnits);
      const creditGain = 10 * colonistUnits;

      update.run(oreGain, orgGain, eqGain, fuelGain, creditGain, planet.id);
    }
  });
  exec();
}

// ============================================================
// CORPORATIONS
// ============================================================

function createCorporation(db, playerId, name, tag) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };
  if (player.corp_id) return { success: false, message: 'Already in a corporation.' };
  if (player.credits < 10000) return { success: false, message: 'Need 10000 credits.' };
  if (!tag || tag.length < 3 || tag.length > 5) return { success: false, message: 'Tag must be 3-5 characters.' };

  const existing = db.prepare('SELECT id FROM corporations WHERE name = ? OR tag = ?').get(name, tag);
  if (existing) return { success: false, message: 'Corporation name or tag already taken.' };

  const result = db.transaction(() => {
    db.prepare('UPDATE players SET credits = credits - 10000 WHERE id = ?').run(playerId);
    const info = db.prepare('INSERT INTO corporations (name, tag, ceo_id) VALUES (?, ?, ?)').run(name, tag, playerId);
    const corpId = info.lastInsertRowid;
    db.prepare('INSERT INTO corp_members (corp_id, player_id, rank) VALUES (?, ?, ?)').run(corpId, playerId, 'ceo');
    db.prepare('UPDATE players SET corp_id = ? WHERE id = ?').run(corpId, playerId);
    return { success: true, message: `Corporation [${tag}] ${name} created.`, corpId };
  })();

  return result;
}

function inviteToCorp(db, ceoId, targetPlayerId) {
  const corp = db.prepare('SELECT * FROM corporations WHERE ceo_id = ?').get(ceoId);
  if (!corp) return { success: false, message: 'You are not a CEO.' };

  const target = db.prepare('SELECT * FROM players WHERE id = ?').get(targetPlayerId);
  if (!target) return { success: false, message: 'Player not found.' };
  if (target.corp_id) return { success: false, message: 'Player is already in a corporation.' };

  // Send invitation as a message
  sendMessage(db, ceoId, targetPlayerId, 'Corporation Invitation',
    `You have been invited to join [${corp.tag}] ${corp.name}. Use the join corporation command with corp ID ${corp.id} to accept.`);

  return { success: true, message: `Invitation sent to ${target.name}.` };
}

function joinCorporation(db, playerId, corpId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };
  if (player.corp_id) return { success: false, message: 'Already in a corporation.' };

  const corp = db.prepare('SELECT * FROM corporations WHERE id = ?').get(corpId);
  if (!corp) return { success: false, message: 'Corporation not found.' };

  const exec = db.transaction(() => {
    db.prepare('INSERT INTO corp_members (corp_id, player_id, rank) VALUES (?, ?, ?)').run(corpId, playerId, 'member');
    db.prepare('UPDATE players SET corp_id = ? WHERE id = ?').run(corpId, playerId);
  });
  exec();

  return { success: true, message: `Joined [${corp.tag}] ${corp.name}.` };
}

function leaveCorporation(db, playerId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };
  if (!player.corp_id) return { success: false, message: 'Not in a corporation.' };

  const corp = db.prepare('SELECT * FROM corporations WHERE id = ?').get(player.corp_id);
  if (corp && corp.ceo_id === playerId) return { success: false, message: 'CEO cannot leave. Disband the corporation instead.' };

  const exec = db.transaction(() => {
    db.prepare('DELETE FROM corp_members WHERE corp_id = ? AND player_id = ?').run(player.corp_id, playerId);
    db.prepare('UPDATE players SET corp_id = NULL WHERE id = ?').run(playerId);
  });
  exec();

  return { success: true, message: 'Left corporation.' };
}

function disbandCorporation(db, ceoId) {
  const corp = db.prepare('SELECT * FROM corporations WHERE ceo_id = ?').get(ceoId);
  if (!corp) return { success: false, message: 'You are not a CEO.' };

  const exec = db.transaction(() => {
    // Return treasury to CEO
    if (corp.treasury > 0) {
      db.prepare('UPDATE players SET credits = credits + ? WHERE id = ?').run(corp.treasury, ceoId);
    }
    // Remove all members
    db.prepare('UPDATE players SET corp_id = NULL WHERE corp_id = ?').run(corp.id);
    db.prepare('DELETE FROM corp_members WHERE corp_id = ?').run(corp.id);
    db.prepare('DELETE FROM corporations WHERE id = ?').run(corp.id);
  });
  exec();

  return { success: true, message: `Corporation ${corp.name} disbanded.` };
}

function corpDeposit(db, playerId, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { success: false, message: 'Amount must be positive.' };

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };
  if (!player.corp_id) return { success: false, message: 'Not in a corporation.' };
  if (player.credits < amount) return { success: false, message: 'Insufficient credits.' };

  const exec = db.transaction(() => {
    db.prepare('UPDATE players SET credits = credits - ? WHERE id = ?').run(amount, playerId);
    db.prepare('UPDATE corporations SET treasury = treasury + ? WHERE id = ?').run(amount, player.corp_id);
  });
  exec();

  return { success: true, message: `Deposited ${amount} credits.` };
}

function corpWithdraw(db, ceoId, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { success: false, message: 'Amount must be positive.' };

  const corp = db.prepare('SELECT * FROM corporations WHERE ceo_id = ?').get(ceoId);
  if (!corp) return { success: false, message: 'You are not a CEO.' };
  if (corp.treasury < amount) return { success: false, message: 'Insufficient treasury funds.' };

  const exec = db.transaction(() => {
    db.prepare('UPDATE corporations SET treasury = treasury - ? WHERE id = ?').run(amount, corp.id);
    db.prepare('UPDATE players SET credits = credits + ? WHERE id = ?').run(amount, ceoId);
  });
  exec();

  return { success: true, message: `Withdrew ${amount} credits.` };
}

function getCorpInfo(db, corpId) {
  const corp = db.prepare('SELECT * FROM corporations WHERE id = ?').get(corpId);
  if (!corp) return null;

  const members = db.prepare(`SELECT p.id, p.name, p.alignment, p.experience, cm.rank, cm.joined_at FROM corp_members cm JOIN players p ON cm.player_id = p.id WHERE cm.corp_id = ?`).all(corpId);

  return { ...corp, members };
}

// ============================================================
// ALIGNMENT
// ============================================================

function getAlignmentTitle(alignment) {
  if (alignment >= 500) return 'Federation Admiral';
  if (alignment >= 200) return 'Federation Captain';
  if (alignment >= 100) return 'Lawful Trader';
  if (alignment >= 0) return 'Neutral';
  if (alignment >= -100) return 'Smuggler';
  if (alignment >= -200) return 'Pirate';
  return 'Dread Pirate';
}

function checkFederationProtection(db, sectorId, playerId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player || player.alignment < 100) return { protected: false };

  // Look for Federation NPCs in adjacent sectors
  const adjacent = db.prepare('SELECT to_sector FROM sector_warps WHERE from_sector = ?').all(sectorId).map(r => r.to_sector);
  adjacent.push(sectorId);

  const placeholders = adjacent.map(() => '?').join(',');
  const fedNPCs = db.prepare(`SELECT * FROM npcs WHERE type = 'federation' AND sector_id IN (${placeholders})`).all(...adjacent);

  if (fedNPCs.length > 0) {
    return { protected: true, message: 'Federation patrols are nearby and will respond to attacks.', npcs: fedNPCs };
  }
  return { protected: false };
}

// ============================================================
// SKILLS (EVE-style passive training)
// ============================================================

function getPlayerSkills(db, playerId) {
  const allSkills = db.prepare('SELECT * FROM skills').all();
  const playerSkills = db.prepare('SELECT * FROM player_skills WHERE player_id = ?').all(playerId);
  const queue = db.prepare('SELECT * FROM skill_queue WHERE player_id = ? ORDER BY queue_position ASC').all(playerId);

  const psMap = {};
  for (const ps of playerSkills) psMap[ps.skill_id] = ps;

  return allSkills.map(skill => {
    const ps = psMap[skill.id] || { level: 0, training_start: null, training_end: null };
    const queued = queue.find(q => q.skill_id === skill.id);
    return {
      ...skill,
      currentLevel: ps.level,
      training: ps.training_end ? { start: ps.training_start, end: ps.training_end } : null,
      queued: queued ? queued.queue_position : null
    };
  });
}

function startTraining(db, playerId, skillId) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  if (!skill) return { success: false, message: 'Skill not found.' };

  let ps = db.prepare('SELECT * FROM player_skills WHERE player_id = ? AND skill_id = ?').get(playerId, skillId);
  if (!ps) {
    db.prepare('INSERT INTO player_skills (player_id, skill_id, level) VALUES (?, ?, 0)').run(playerId, skillId);
    ps = { level: 0, training_start: null, training_end: null };
  }

  if (ps.level >= skill.max_level) return { success: false, message: 'Skill already at max level.' };

  // Check if already training this skill
  if (ps.training_end) return { success: false, message: 'Already training this skill.' };

  // Check queue size
  const queueCount = db.prepare('SELECT COUNT(*) as c FROM skill_queue WHERE player_id = ?').get(playerId).c;
  const currentlyTraining = db.prepare('SELECT COUNT(*) as c FROM player_skills WHERE player_id = ? AND training_end IS NOT NULL').get(playerId).c;

  if (currentlyTraining === 0) {
    // Start immediately
    const trainTime = skill.train_time_base * (ps.level + 1);
    const now = new Date();
    const end = new Date(now.getTime() + trainTime * 1000);
    db.prepare('UPDATE player_skills SET training_start = ?, training_end = ? WHERE player_id = ? AND skill_id = ?')
      .run(now.toISOString(), end.toISOString(), playerId, skillId);
    return { success: true, message: `Training ${skill.name} to level ${ps.level + 1}. Completes at ${end.toISOString()}.` };
  }

  // Add to queue (max 3 in queue)
  if (queueCount >= 3) return { success: false, message: 'Training queue full (max 3).' };

  db.prepare('INSERT INTO skill_queue (player_id, skill_id, target_level, queue_position) VALUES (?, ?, ?, ?)')
    .run(playerId, skillId, ps.level + 1, queueCount + 1);

  return { success: true, message: `${skill.name} added to training queue at position ${queueCount + 1}.` };
}

function cancelTraining(db, playerId, skillId) {
  const ps = db.prepare('SELECT * FROM player_skills WHERE player_id = ? AND skill_id = ?').get(playerId, skillId);

  if (ps && ps.training_end) {
    db.prepare('UPDATE player_skills SET training_start = NULL, training_end = NULL WHERE player_id = ? AND skill_id = ?').run(playerId, skillId);
    // Start next in queue
    startNextInQueue(db, playerId);
    return { success: true, message: 'Training cancelled.' };
  }

  // Check queue
  const queued = db.prepare('SELECT * FROM skill_queue WHERE player_id = ? AND skill_id = ?').get(playerId, skillId);
  if (queued) {
    db.prepare('DELETE FROM skill_queue WHERE player_id = ? AND skill_id = ?').run(playerId, skillId);
    // Reorder queue
    const remaining = db.prepare('SELECT * FROM skill_queue WHERE player_id = ? ORDER BY queue_position ASC').all(playerId);
    for (let i = 0; i < remaining.length; i++) {
      db.prepare('UPDATE skill_queue SET queue_position = ? WHERE id = ?').run(i + 1, remaining[i].id);
    }
    return { success: true, message: 'Removed from training queue.' };
  }

  return { success: false, message: 'Not training or queued.' };
}

function processSkillTraining(db) {
  const now = new Date().toISOString();
  const completed = db.prepare('SELECT * FROM player_skills WHERE training_end IS NOT NULL AND training_end <= ?').all(now);

  const exec = db.transaction(() => {
    for (const ps of completed) {
      db.prepare('UPDATE player_skills SET level = level + 1, training_start = NULL, training_end = NULL WHERE player_id = ? AND skill_id = ?')
        .run(ps.player_id, ps.skill_id);
      startNextInQueue(db, ps.player_id);
    }
  });
  exec();
}

function startNextInQueue(db, playerId) {
  // Check if anything is currently training
  const active = db.prepare('SELECT COUNT(*) as c FROM player_skills WHERE player_id = ? AND training_end IS NOT NULL').get(playerId).c;
  if (active > 0) return;

  const next = db.prepare('SELECT * FROM skill_queue WHERE player_id = ? ORDER BY queue_position ASC LIMIT 1').get(playerId);
  if (!next) return;

  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(next.skill_id);
  if (!skill) return;

  let ps = db.prepare('SELECT * FROM player_skills WHERE player_id = ? AND skill_id = ?').get(playerId, next.skill_id);
  if (!ps) {
    db.prepare('INSERT INTO player_skills (player_id, skill_id, level) VALUES (?, ?, 0)').run(playerId, next.skill_id);
    ps = { level: 0 };
  }

  const trainTime = skill.train_time_base * (ps.level + 1);
  const now = new Date();
  const end = new Date(now.getTime() + trainTime * 1000);

  db.prepare('UPDATE player_skills SET training_start = ?, training_end = ? WHERE player_id = ? AND skill_id = ?')
    .run(now.toISOString(), end.toISOString(), playerId, next.skill_id);
  db.prepare('DELETE FROM skill_queue WHERE id = ?').run(next.id);

  // Reorder remaining queue
  const remaining = db.prepare('SELECT * FROM skill_queue WHERE player_id = ? ORDER BY queue_position ASC').all(playerId);
  for (let i = 0; i < remaining.length; i++) {
    db.prepare('UPDATE skill_queue SET queue_position = ? WHERE id = ?').run(i + 1, remaining[i].id);
  }
}

function getSkillBonus(db, playerId, skillName) {
  const row = db.prepare(`SELECT ps.level FROM player_skills ps JOIN skills s ON ps.skill_id = s.id WHERE ps.player_id = ? AND s.name = ?`).get(playerId, skillName);
  return row ? row.level : 0;
}

// ============================================================
// MESSAGES
// ============================================================

function sendMessage(db, fromId, toId, subject, body) {
  db.prepare('INSERT INTO messages (from_id, to_id, subject, body) VALUES (?, ?, ?, ?)').run(fromId, toId, subject, body);
  return { success: true, message: 'Message sent.' };
}

function getMessages(db, playerId) {
  return db.prepare(`SELECT m.*, p.name as from_name FROM messages m LEFT JOIN players p ON m.from_id = p.id WHERE m.to_id = ? AND m.read = 0 ORDER BY m.created_at DESC`).all(playerId);
}

function readMessage(db, playerId, messageId) {
  const msg = db.prepare('SELECT m.*, p.name as from_name FROM messages m LEFT JOIN players p ON m.from_id = p.id WHERE m.id = ? AND m.to_id = ?').get(messageId, playerId);
  if (!msg) return null;
  db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(messageId);
  return msg;
}

// ============================================================
// NPCs
// ============================================================

function moveNPCs(db) {
  const npcs = db.prepare('SELECT * FROM npcs').all();

  const exec = db.transaction(() => {
    for (const npc of npcs) {
      if (npc.type === 'federation') {
        // Random patrol
        const warps = db.prepare('SELECT to_sector FROM sector_warps WHERE from_sector = ?').all(npc.sector_id);
        if (warps.length > 0) {
          const target = warps[Math.floor(Math.random() * warps.length)].to_sector;
          db.prepare('UPDATE npcs SET sector_id = ?, last_move = CURRENT_TIMESTAMP WHERE id = ?').run(target, npc.id);
        }
      } else if (npc.type === 'ferrengi') {
        // Hunt toward players, prefer evil ones
        const nearby = db.prepare('SELECT to_sector FROM sector_warps WHERE from_sector = ?').all(npc.sector_id);
        if (nearby.length === 0) continue;

        // Check for evil players in adjacent sectors
        const sectorIds = nearby.map(w => w.to_sector);
        const placeholders = sectorIds.map(() => '?').join(',');
        const evilPlayer = db.prepare(`SELECT current_sector FROM players WHERE current_sector IN (${placeholders}) AND alignment < 0 AND online = 1 ORDER BY alignment ASC LIMIT 1`).get(...sectorIds);

        if (evilPlayer) {
          db.prepare('UPDATE npcs SET sector_id = ?, last_move = CURRENT_TIMESTAMP WHERE id = ?').run(evilPlayer.current_sector, npc.id);
        } else {
          const target = sectorIds[Math.floor(Math.random() * sectorIds.length)];
          db.prepare('UPDATE npcs SET sector_id = ?, last_move = CURRENT_TIMESTAMP WHERE id = ?').run(target, npc.id);
        }
      } else if (npc.type === 'alien_trader') {
        // Move randomly and restock
        const warps = db.prepare('SELECT to_sector FROM sector_warps WHERE from_sector = ?').all(npc.sector_id);
        if (warps.length > 0 && Math.random() < 0.3) {
          const target = warps[Math.floor(Math.random() * warps.length)].to_sector;
          db.prepare('UPDATE npcs SET sector_id = ?, last_move = CURRENT_TIMESTAMP WHERE id = ?').run(target, npc.id);
        }
        // Restock
        db.prepare('UPDATE npcs SET ore = MIN(500, ore + 10), organics = MIN(500, organics + 10), equipment = MIN(500, equipment + 10) WHERE id = ?').run(npc.id);
      }
    }
  });
  exec();
}

function npcInteraction(db, playerId, npcId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const npc = db.prepare('SELECT * FROM npcs WHERE id = ?').get(npcId);
  if (!npc) return { success: false, message: 'NPC not found.' };
  if (npc.sector_id !== player.current_sector) return { success: false, message: 'NPC not in your sector.' };

  if (npc.type === 'federation') {
    if (player.alignment < 0) {
      // Combat with Federation
      const ship = getPlayerShip(db, playerId);
      if (!ship) return { success: false, message: 'No ship.' };

      const damage = Math.floor(npc.strength * 1.5);
      db.prepare('UPDATE ships SET shields = MAX(0, shields - ?) WHERE id = ?').run(damage, ship.id);

      const after = db.prepare('SELECT shields FROM ships WHERE id = ?').get(ship.id);
      if (after.shields <= 0) {
        respawnPlayer(db, playerId);
        return { success: false, message: `Federation patrol destroyed your ship! You lost ${damage} shields.`, destroyed: true };
      }
      return { success: true, message: `Federation patrol attacked! Took ${damage} damage.`, damage };
    }
    return { success: true, message: 'Federation patrol salutes you, captain.', friendly: true };
  }

  if (npc.type === 'ferrengi') {
    const ship = getPlayerShip(db, playerId);
    if (!ship) return { success: false, message: 'No ship.' };

    const damage = Math.floor(npc.strength * 2);
    db.prepare('UPDATE ships SET shields = MAX(0, shields - ?) WHERE id = ?').run(damage, ship.id);

    // Player fights back
    const playerDmg = Math.floor(ship.fighters * 0.2);
    const npcSurvives = npc.strength > playerDmg;

    if (!npcSurvives) {
      const bounty = npc.credits || 500;
      db.prepare('UPDATE players SET credits = credits + ?, experience = experience + 50 WHERE id = ?').run(bounty, playerId);
      db.prepare('DELETE FROM npcs WHERE id = ?').run(npcId);
      return { success: true, message: `Destroyed Ferrengi ${npc.name}! Earned ${bounty} credits.`, bounty };
    }

    db.prepare('UPDATE npcs SET strength = strength - ? WHERE id = ?').run(playerDmg, npcId);

    const after = db.prepare('SELECT shields FROM ships WHERE id = ?').get(ship.id);
    if (after.shields <= 0) {
      respawnPlayer(db, playerId);
      return { success: false, message: `Ferrengi ${npc.name} destroyed your ship!`, destroyed: true };
    }
    return { success: true, message: `Ferrengi battle! Took ${damage} damage, dealt ${playerDmg} to enemy.`, damage, dealt: playerDmg };
  }

  if (npc.type === 'alien_trader') {
    return {
      success: true,
      message: `Alien trader ${npc.name} offers exotic goods.`,
      trader: true,
      stock: { ore: npc.ore, organics: npc.organics, equipment: npc.equipment }
    };
  }

  return { success: false, message: 'Unknown NPC type.' };
}

// ============================================================
// UTILITY
// ============================================================

function addTurns(db) {
  db.prepare('UPDATE players SET turns_remaining = MIN(max_turns, turns_remaining + 1)').run();
}

function getLeaderboard(db) {
  return db.prepare(`SELECT p.id, p.name, p.experience, p.credits, p.kills, p.deaths, p.alignment, (p.experience + p.credits) as score FROM players p ORDER BY score DESC LIMIT 20`).all();
}

// ============================================================
// EXPORTS
// ============================================================

// ============================================================
// SHIP CUSTOMIZATION
// ============================================================

function renameShip(db, playerId, newName) {
  if (!newName || typeof newName !== 'string') return { success: false, message: 'Invalid ship name.' };
  newName = newName.trim();
  if (newName.length < 1 || newName.length > 30) return { success: false, message: 'Ship name must be 1-30 characters.' };

  const ship = db.prepare('SELECT id FROM ships WHERE player_id = ? AND active = 1').get(playerId);
  if (!ship) return { success: false, message: 'No active ship.' };

  db.prepare('UPDATE ships SET name = ? WHERE id = ?').run(newName, ship.id);
  return { success: true, message: `Ship renamed to "${newName}".` };
}

function getUpgradeTypes(db) {
  return db.prepare('SELECT * FROM upgrade_types ORDER BY category, base_cost').all();
}

function getShipUpgrades(db, playerId) {
  const ship = db.prepare('SELECT id FROM ships WHERE player_id = ? AND active = 1').get(playerId);
  if (!ship) return [];
  return db.prepare(`SELECT su.*, ut.name, ut.category, ut.description, ut.stat_bonus, ut.bonus_value, ut.max_stacks, ut.base_cost, ut.equipment_cost
    FROM ship_upgrades su JOIN upgrade_types ut ON su.upgrade_type_id = ut.id WHERE su.ship_id = ?`).all(ship.id);
}

function installUpgrade(db, playerId, upgradeTypeId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const sector = db.prepare('SELECT has_stardock FROM sectors WHERE id = ?').get(player.current_sector);
  if (!sector || !sector.has_stardock) return { success: false, message: 'Must be at a StarDock to install upgrades.' };

  const ship = db.prepare('SELECT * FROM ships WHERE player_id = ? AND active = 1').get(playerId);
  if (!ship) return { success: false, message: 'No active ship.' };

  const upgrade = db.prepare('SELECT * FROM upgrade_types WHERE id = ?').get(upgradeTypeId);
  if (!upgrade) return { success: false, message: 'Unknown upgrade type.' };

  if (player.credits < upgrade.base_cost) return { success: false, message: `Need ${upgrade.base_cost} credits (have ${player.credits}).` };
  if (ship.equipment < upgrade.equipment_cost) return { success: false, message: `Need ${upgrade.equipment_cost} equipment (have ${ship.equipment}).` };

  const existing = db.prepare('SELECT * FROM ship_upgrades WHERE ship_id = ? AND upgrade_type_id = ?').get(ship.id, upgradeTypeId);

  if (existing) {
    if (existing.stacks >= upgrade.max_stacks) return { success: false, message: `Maximum stacks (${upgrade.max_stacks}) already installed.` };

    // Check for conflicting upgrades in same category (higher tier replaces lower within non-stackable)
    const exec = db.transaction(() => {
      db.prepare('UPDATE players SET credits = credits - ? WHERE id = ?').run(upgrade.base_cost, playerId);
      db.prepare('UPDATE ships SET equipment = equipment - ? WHERE id = ?').run(upgrade.equipment_cost, ship.id);
      db.prepare('UPDATE ship_upgrades SET stacks = stacks + 1 WHERE id = ?').run(existing.id);
    });
    exec();
  } else {
    const exec = db.transaction(() => {
      db.prepare('UPDATE players SET credits = credits - ? WHERE id = ?').run(upgrade.base_cost, playerId);
      db.prepare('UPDATE ships SET equipment = equipment - ? WHERE id = ?').run(upgrade.equipment_cost, ship.id);
      db.prepare('INSERT INTO ship_upgrades (ship_id, upgrade_type_id, stacks) VALUES (?, ?, 1)').run(ship.id, upgradeTypeId);
    });
    exec();
  }

  // Apply shield upgrades immediately
  if (upgrade.stat_bonus === 'max_shields') {
    const totalBonus = upgrade.bonus_value;
    db.prepare('UPDATE ships SET max_shields = max_shields + ?, shields = shields + ? WHERE id = ?').run(totalBonus, totalBonus, ship.id);
  }

  return { success: true, message: `Installed ${upgrade.name}! (-${upgrade.base_cost} credits, -${upgrade.equipment_cost} equipment)` };
}

function removeUpgrade(db, playerId, upgradeTypeId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const sector = db.prepare('SELECT has_stardock FROM sectors WHERE id = ?').get(player.current_sector);
  if (!sector || !sector.has_stardock) return { success: false, message: 'Must be at a StarDock to remove upgrades.' };

  const ship = db.prepare('SELECT * FROM ships WHERE player_id = ? AND active = 1').get(playerId);
  if (!ship) return { success: false, message: 'No active ship.' };

  const existing = db.prepare(`SELECT su.*, ut.name, ut.stat_bonus, ut.bonus_value, ut.base_cost
    FROM ship_upgrades su JOIN upgrade_types ut ON su.upgrade_type_id = ut.id
    WHERE su.ship_id = ? AND su.upgrade_type_id = ?`).get(ship.id, upgradeTypeId);
  if (!existing) return { success: false, message: 'Upgrade not installed.' };

  const refund = Math.floor(existing.base_cost * existing.stacks * 0.4);

  const exec = db.transaction(() => {
    // Remove shield bonus if applicable
    if (existing.stat_bonus === 'max_shields') {
      const totalLoss = existing.bonus_value * existing.stacks;
      db.prepare('UPDATE ships SET max_shields = MAX(1, max_shields - ?), shields = MIN(shields, MAX(1, max_shields - ?)) WHERE id = ?').run(totalLoss, totalLoss, ship.id);
    }
    db.prepare('DELETE FROM ship_upgrades WHERE id = ?').run(existing.id);
    db.prepare('UPDATE players SET credits = credits + ? WHERE id = ?').run(refund, playerId);
  });
  exec();

  return { success: true, message: `Removed ${existing.name}. Refunded ${refund} credits (40%).` };
}

function getShipUpgradeBonus(db, shipId, statName) {
  const rows = db.prepare(`SELECT ut.bonus_value, su.stacks FROM ship_upgrades su
    JOIN upgrade_types ut ON su.upgrade_type_id = ut.id
    WHERE su.ship_id = ? AND ut.stat_bonus = ?`).all(shipId, statName);
  let total = 0;
  for (const r of rows) total += r.bonus_value * r.stacks;
  return total;
}

// ============================================================
// CAPTAIN'S QUARTERS
// ============================================================

function getCompanionTypes(db) {
  return db.prepare('SELECT * FROM companion_types ORDER BY gender, race').all();
}

function getPlayerCompanions(db, playerId) {
  return db.prepare(`SELECT c.*, ct.name, ct.race, ct.gender, ct.description, ct.personality, ct.hire_cost
    FROM companions c JOIN companion_types ct ON c.companion_type_id = ct.id
    WHERE c.player_id = ? ORDER BY c.hired_at`).all(playerId);
}

function hireCompanion(db, playerId, companionTypeId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { success: false, message: 'Player not found.' };

  const compType = db.prepare('SELECT * FROM companion_types WHERE id = ?').get(companionTypeId);
  if (!compType) return { success: false, message: 'Unknown companion.' };

  const existing = db.prepare('SELECT id FROM companions WHERE player_id = ? AND companion_type_id = ?').get(playerId, companionTypeId);
  if (existing) return { success: false, message: `${compType.name} is already aboard your ship.` };

  const count = db.prepare('SELECT COUNT(*) as c FROM companions WHERE player_id = ?').get(playerId).c;
  if (count >= 3) return { success: false, message: 'Maximum 3 companions. Dismiss someone first.' };

  if (player.credits < compType.hire_cost) return { success: false, message: `Need ${compType.hire_cost} credits (have ${player.credits}).` };

  const exec = db.transaction(() => {
    db.prepare('UPDATE players SET credits = credits - ? WHERE id = ?').run(compType.hire_cost, playerId);
    db.prepare('INSERT INTO companions (player_id, companion_type_id, affinity, mood) VALUES (?, ?, 50, 50)').run(playerId, companionTypeId);
  });
  exec();

  return { success: true, message: `${compType.name} has joined your crew! Welcome aboard.` };
}

function dismissCompanion(db, playerId, companionTypeId) {
  const comp = db.prepare(`SELECT c.id, ct.name FROM companions c JOIN companion_types ct ON c.companion_type_id = ct.id
    WHERE c.player_id = ? AND c.companion_type_id = ?`).get(playerId, companionTypeId);
  if (!comp) return { success: false, message: 'Companion not found.' };

  db.prepare('DELETE FROM companions WHERE id = ?').run(comp.id);
  return { success: true, message: `${comp.name} has left your crew. Farewell.` };
}

function interactWithCompanion(db, playerId, companionTypeId, action) {
  const comp = db.prepare(`SELECT c.*, ct.name, ct.race, ct.personality, ct.gender
    FROM companions c JOIN companion_types ct ON c.companion_type_id = ct.id
    WHERE c.player_id = ? AND c.companion_type_id = ?`).get(playerId, companionTypeId);
  if (!comp) return { success: false, message: 'Companion not found.' };

  const validActions = ['talk', 'drink', 'homeworld', 'game', 'stargaze'];
  if (!validActions.includes(action)) return { success: false, message: 'Unknown interaction.' };

  // Cooldown: 30 seconds between interactions
  if (comp.last_interaction) {
    const lastTime = new Date(comp.last_interaction).getTime();
    const now = Date.now();
    if (now - lastTime < 30000) {
      const wait = Math.ceil((30000 - (now - lastTime)) / 1000);
      return { success: false, message: `${comp.name} needs a moment. Try again in ${wait}s.` };
    }
  }

  // Generate response based on personality, action, and mood
  const responses = getCompanionResponse(comp, action);
  const affinityDelta = responses.affinityDelta;
  const moodDelta = responses.moodDelta;

  const newAffinity = Math.max(0, Math.min(100, comp.affinity + affinityDelta));
  const newMood = Math.max(0, Math.min(100, comp.mood + moodDelta));

  db.prepare('UPDATE companions SET affinity = ?, mood = ?, last_interaction = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newAffinity, newMood, comp.id);

  return {
    success: true,
    message: responses.text,
    companion: comp.name,
    affinity: newAffinity,
    mood: newMood,
    affinityChange: affinityDelta,
    moodChange: moodDelta
  };
}

function getCompanionResponse(comp, action) {
  const p = comp.personality;
  const name = comp.name;
  const race = comp.race;
  const highAffinity = comp.affinity >= 70;
  const lowMood = comp.mood < 30;

  const dialogues = {
    talk: {
      witty: [
        `${name} leans back. "You know, I once navigated through a triple-nebula storm with nothing but a broken compass and sheer stubbornness."`,
        `${name} smirks. "Most captains ask for my opinion. The smart ones actually listen."`,
        `${name} chuckles. "If I had a credit for every close call we've had, I'd buy my own StarDock."`
      ],
      serene: [
        `${name}'s antennae glow softly. "I sense... contentment in you, Captain. The stars are kind today."`,
        `${name} closes her eyes. "The telepathic currents are calm. A good omen for trade."`,
        `${name} smiles gently. "On Zelthara, we say the void between stars holds the truest conversations."`
      ],
      fierce: [
        `${name} flexes her claws absently. "I miss the hunt sometimes. But this life has its own thrills."`,
        `${name}'s tail swishes. "My last bounty tried to bribe me. I told him my claws don't accept credits."`,
        `${name} purrs low. "Don't mistake my calm for softness, Captain. I'm always ready."`
      ],
      cunning: [
        `${name}'s forked tongue flickers. "The market pressures in this sector are... exploitable."`,
        `${name} examines her scales. "Among the Vossk, a good deal is worth more than a hundred victories."`,
        `${name} hisses softly. "Trust is a commodity, Captain. I invest mine carefully."`
      ],
      ethereal: [
        `${name} hums a melody that makes the lights flicker. "The stars sang of your arrival long ago, Captain."`,
        `${name}'s form shimmers. "Each photon carries a story. I am simply... a good listener."`,
        `${name} glows warmly. "In the space between breaths, the universe whispers its secrets."`
      ],
      gruff: [
        `${name} scratches his stubble. "Back in the Federation fleet, we didn't have these fancy warp drives. Had to do things the hard way."`,
        `${name} grunts. "I've seen empires rise and fall, kid. The only constant is the void."`,
        `${name} pours himself a drink. "You're not half bad, Captain. Don't let it go to your head."`
      ],
      contemplative: [
        `${name}'s eyes glow blue. "I was mapping a psychic anomaly in Sector 7 when I realized... the anomaly was mapping me."`,
        `${name} steeples his fingers. "Consciousness is the universe's way of experiencing itself. We are all explorers."`,
        `${name} tilts his head. "Your neural patterns are fascinating today, Captain. More complex than usual."`
      ],
      boisterous: [
        `${name} slams a fist on the table. "HA! Did I ever tell you about the time I wrestled a Ferrengi bare-handed?"`,
        `${name} roars with laughter. "In my clan, a warrior is measured by his scars! See this one? Three-headed serpent."`,
        `${name} grins, showing his fangs. "You fight well for a captain. Perhaps I'll make a warrior of you yet!"`
      ],
      sly: [
        `${name}'s scales shift color. "I know a route that avoids every Federation patrol. Interested?"`,
        `${name} chuckles low. "The Vossk saying goes: 'The fastest ship is the one no one sees coming.'"`,
        `${name} flicks his tail. "Information, Captain, is the most valuable cargo in any hold."`
      ],
      mystical: [
        `${name}'s body pulses with starlight. "The cosmic winds shift. A change approaches your destiny."`,
        `${name} speaks softly. "Do you ever wonder if the wormholes dream? I believe they do."`,
        `${name} traces glowing patterns in the air. "All paths converge eventually. Yours is... interesting."`
      ]
    },
    drink: {
      witty: [`${name} raises a glass. "To bad decisions and great stories!"`, `${name} sips elegantly. "This Zelthari brandy almost makes space bearable."`],
      serene: [`${name} cradles the warm cup. "On Zelthara, we share tea before all important decisions."`, `${name} takes a delicate sip. "The warmth reminds me of home."`],
      fierce: [`${name} downs it in one gulp. "Krynnari bloodwine. Now THAT was a drink. This is... adequate."`, `${name} grins. "Drinks are better after a good fight. We should arrange one."`],
      cunning: [`${name} swirls the drink. "A fine vintage. I could sell this for triple in the right sector."`, `${name} sips cautiously. "Never drink what you haven't inspected first."`],
      ethereal: [`${name} absorbs the liquid through her luminous skin. "How... interesting. Your species drinks so differently."`, `${name} hums. "The molecular composition sings."`],
      gruff: [`${name} raises a toast. "To surviving another day in this godforsaken galaxy."`, `${name} drains his glass. "That hits the spot. Reminds me of shore leave on Titan."`],
      contemplative: [`${name} holds the cup, eyes closed. "I can taste the sunlight of the world where this was grown."`, `${name} sips slowly. "A shared drink opens neural pathways to trust."`],
      boisterous: [`${name} SMASHES his mug down. "ANOTHER! That was GLORIOUS!"`, `${name} drinks heartily. "On my homeworld, we drink from the skulls of our enemies! ...But mugs work too."`],
      sly: [`${name} clinks glasses. "The best deals are made over drinks. Coincidence?"`, `${name} sips. "I once traded a bottle of rare vintage for a whole cargo hold of equipment."`],
      mystical: [`${name} watches light dance through the liquid. "Each bubble is a universe being born."`, `${name}'s glow brightens slightly. "The ritual of sharing sustenance... profoundly beautiful."`]
    },
    homeworld: {
      witty: [`${name}'s expression softens. "Earth. Blue marble floating in the void. I miss the ocean breezes of New Sydney."`, `${name} gazes at the stars. "Home is wherever I park this ship. But yes... I miss Earth sometimes."`],
      serene: [`${name}'s antennae droop slightly. "Zelthara. A world of crystal spires and telepathic harmony. I hear their songs even now, across the light-years."`, `${name} projects a faint image of a shimmering blue world. "So far... but never truly gone."`],
      fierce: [`${name}'s ears flatten. "Krynnax. Endless savannas under twin suns. The Great Hunt... I was the youngest to complete it. My clan was proud."`, `${name} shows her fangs in a bittersweet grin. "I left to prove myself. Some days I wonder if I've proven enough."`],
      cunning: [`${name}'s eyes narrow. "The Vossk Hegemony is built on trade and treachery. I excelled at both. My exile was... political."`, `${name} traces a claw on the table. "Vosskar is beautiful in its way. Obsidian cities rising from jade seas."`],
      ethereal: [`${name}'s light dims momentarily. "The Luminous Expanse. We Aelari are born from dying stars, Captain. Our homeworld is... everywhere and nowhere."`, `${name} sings a hauntingly beautiful note. "This is the sound of my birthstar. Can you hear the longing?"`],
      gruff: [`${name} stares into the distance. "Mars Colony Three. Grew up in the dust domes before the terraforming finished. Made you tough or it broke you."`, `${name} clears his throat. "Haven't been back in decades. Not sure I'd recognize it now."`],
      contemplative: [`${name}'s eyes swirl with galaxies. "Zelthara's psychic academies taught me that home is a construct of memory. And yet... I dream of it nightly."`, `${name} touches his temple. "I can project my memories of home. Would you like to see?"`],
      boisterous: [`${name}'s eyes light up. "KRYNNAX! The arena pits, the great feasts, the warrior trials! You should visit, Captain - if you survive!"`, `${name} pounds his chest. "My clan, the Ironclaws, rule the Northern Mountains. Perhaps one day I'll take you there!"`],
      sly: [`${name}'s scales darken. "Vosskar. I'd go back if they wouldn't immediately throw me in a cell. Or worse."`, `${name} laughs quietly. "Let's just say I made some powerful enemies. And some very profitable friends."`],
      mystical: [`${name}'s entire body glows brighter. "We are children of the cosmos, Captain. Every star is home. Every photon, a relative."`, `${name} traces shimmering paths in the air. "But there is one nebula... where the light is sweeter than anywhere else. There, I was born."`]
    },
    game: {
      witty: [`${name} shuffles holographic cards. "Quantum Poker? Fair warning - I count cards. ALL the cards."`, `${name} grins. "Best of three. Loser buys dinner at the next StarDock."`],
      serene: [`${name} sets up crystal pieces. "Zelthari Mind-Chess. The pieces move when you think your strategy clearly enough."`, `${name} smiles. "A game shared is a bond strengthened."`],
      fierce: [`${name} cracks her knuckles. "Arm wrestling? I'll go easy on you. ...Mostly."`, `${name}'s tail swishes eagerly. "My people play Claw's Edge. It involves... some risk. Interested?"`],
      cunning: [`${name} produces dice. "Vossk Trading Game. The rules change every round, just like real business."`, `${name} deals cards with practiced ease. "Shall we make it interesting? Say... 100 credits?"`],
      ethereal: [`${name} creates patterns of light between her hands. "This is a light-weaving game. Try to match my patterns."`, `${name} hums. "Among the Aelari, games are songs sung together."`],
      gruff: [`${name} produces a worn deck. "Five-Card Federation. Standard military rules. No crying when I win."`, `${name} chuckles. "Used to fleece the entire barracks with this game. Old habits."`],
      contemplative: [`${name} projects a holographic puzzle. "This is a psychic labyrinth. Navigate it with your thoughts."`, `${name} nods approvingly. "Your mind is agile, Captain. An excellent opponent."`],
      boisterous: [`${name} SLAMS dice on the table. "WARRIOR'S GAMBIT! Roll the bones! The ancestors guide the worthy!"`, `${name} roars. "HAHA! Good roll! You have the heart of a Krynnari warrior!"`],
      sly: [`${name} flips a coin. "Heads I win, tails you lose. ...Kidding. Mostly."`, `${name} grins. "Three-shell game? No? Smart captain."`],
      mystical: [`${name} creates a shimmering sphere. "Gaze into the starlight. Tell me what shapes you see. There are no wrong answers... only revealing ones."`, `${name} traces constellations. "The stars play the longest game. We merely participate."`]
    },
    stargaze: {
      witty: [`${name} leans against the viewport. "Billions of stars, and we're arguing about trade routes. Puts things in perspective."`, `${name} points. "See that star cluster? I almost crashed into it once. Beautiful AND deadly. My type."`],
      serene: [`${name}'s antennae extend toward the stars. "I can feel them, Captain. Every star, a mind. Every nebula, a dream."`, `${name} takes your hand gently. "In this moment, we are connected to everything."`],
      fierce: [`${name}'s pupils dilate in the starlight. "My people used to navigate by the stars alone. No maps, no instruments. Just instinct."`, `${name} is unexpectedly quiet. "...It's beautiful. Don't tell anyone I said that."`],
      cunning: [`${name} studies the stars calculatingly. "Each one of those lights is a potential market. The galaxy is rich beyond counting."`, `${name}'s expression softens, just for a moment. "Even Vossk appreciate beauty. We just don't admit it often."`],
      ethereal: [`${name} begins to GLOW, her light harmonizing with the distant stars. It's breathtaking. "We are all starlight, Captain. All of us."`, `${name} sings a wordless melody. Outside the viewport, you'd swear the stars pulse in rhythm.`],
      gruff: [`${name} stands beside you in silence for a long moment. "...You know, this is why I came out here. Not the fighting. This."`, `${name} clears his throat. "The stars don't change. Everything else does. I find that... comforting."`],
      contemplative: [`${name}'s eyes reflect entire galaxies. "Each photon that reaches our eyes has traveled millions of years. We see the past, always."`, `${name} whispers. "In the quiet between stars, I hear the heartbeat of the universe."`],
      boisterous: [`${name} is surprisingly quiet for once, then: "...My mother used to say the stars are the eyes of fallen warriors. Watching over us."`, `${name}'s voice drops low. "Even warriors need moments of peace, Captain. Thank you for this one."`],
      sly: [`${name} gazes out thoughtfully. "Funny... all that darkness, and still so much light. Rather like the galaxy's inhabitants."`, `${name} is quiet for a long moment. "...Don't tell anyone, but these are my favorite moments aboard this ship."`],
      mystical: [`${name}'s entire body becomes translucent, merging with the starfield. "We are home, Captain. We are always home."`, `${name} whispers, his light pulsing slowly. "The universe breathes. Can you feel it? In... and out... and in again."`]
    }
  };

  const actionDialogues = dialogues[action] || dialogues.talk;
  const personalityLines = actionDialogues[p] || actionDialogues.witty;
  const text = personalityLines[Math.floor(Math.random() * personalityLines.length)];

  // Affinity/mood changes based on action
  let affinityDelta = 0;
  let moodDelta = 0;

  switch (action) {
    case 'talk':
      affinityDelta = highAffinity ? 2 : 3;
      moodDelta = lowMood ? 5 : 2;
      break;
    case 'drink':
      affinityDelta = 3;
      moodDelta = 5;
      break;
    case 'homeworld':
      affinityDelta = highAffinity ? 5 : 2;
      moodDelta = comp.affinity >= 60 ? 3 : -2;
      break;
    case 'game':
      affinityDelta = 4;
      moodDelta = 6;
      break;
    case 'stargaze':
      affinityDelta = highAffinity ? 6 : 3;
      moodDelta = 4;
      break;
  }

  return { text, affinityDelta, moodDelta };
}

function getQuartersStatus(db, playerId) {
  const companions = getPlayerCompanions(db, playerId);
  const ship = db.prepare(`SELECT s.name, st.name as type_name FROM ships s JOIN ship_types st ON s.type_id = st.id WHERE s.player_id = ? AND s.active = 1`).get(playerId);
  return {
    shipName: ship ? ship.name : 'Unknown',
    shipType: ship ? ship.type_name : 'Unknown',
    companions: companions.map(c => ({
      companion_type_id: c.companion_type_id,
      name: c.name,
      nickname: c.nickname,
      race: c.race,
      gender: c.gender,
      personality: c.personality,
      description: c.description,
      affinity: c.affinity,
      mood: c.mood,
      lastInteraction: c.last_interaction
    }))
  };
}

// ============================================================

module.exports = {
  // Trading
  tradeAtPort,
  getPortInfo,
  regenPorts,
  // Player Market
  placeMarketOrder,
  getMarketOrders,
  cancelMarketOrder,
  processMarketMatches,
  // Ships
  getShipTypes,
  getPlayerShip,
  buyShip,
  getTotalCargo,
  // Movement
  moveToSector,
  getSectorInfo,
  // Combat
  attackPlayer,
  deployFighters,
  deployMines,
  collectFighters,
  // Planets
  landOnPlanet,
  claimPlanet,
  renamePlanet,
  transferToPlanet,
  transferFromPlanet,
  buildCitadel,
  upgradeCitadelModule,
  runPlanetProduction,
  // Corporations
  createCorporation,
  inviteToCorp,
  joinCorporation,
  leaveCorporation,
  disbandCorporation,
  corpDeposit,
  corpWithdraw,
  getCorpInfo,
  // Alignment
  getAlignmentTitle,
  checkFederationProtection,
  // Skills
  getPlayerSkills,
  startTraining,
  cancelTraining,
  processSkillTraining,
  getSkillBonus,
  // Messages
  sendMessage,
  getMessages,
  readMessage,
  // NPCs
  moveNPCs,
  npcInteraction,
  // Utility
  addTurns,
  getLeaderboard,
  // Ship Customization
  renameShip,
  getUpgradeTypes,
  getShipUpgrades,
  installUpgrade,
  removeUpgrade,
  getShipUpgradeBonus,
  // Captain's Quarters
  getCompanionTypes,
  getPlayerCompanions,
  hireCompanion,
  dismissCompanion,
  interactWithCompanion,
  getQuartersStatus
};
