const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb, seedShipTypes, seedSkills } = require('./src/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'intergalactic-trade-wars-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;
const UNIVERSE_SIZE = parseInt(process.env.UNIVERSE_SIZE) || 500;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database and seed data
const db = getDb();
seedShipTypes();
seedSkills();

// Check if universe exists, generate if not
const sectorCount = db.prepare('SELECT COUNT(*) as c FROM sectors').get().c;
if (sectorCount === 0) {
  const { generateUniverse, spawnNPCs, spawnWormholes } = require('./src/universe');
  console.log(`Generating universe with ${UNIVERSE_SIZE} sectors...`);
  generateUniverse(db, UNIVERSE_SIZE);
  spawnNPCs(db, UNIVERSE_SIZE);
  spawnWormholes(db, UNIVERSE_SIZE);
  console.log('Universe generated!');
}

const game = require('./src/game');

// Auth middleware for REST endpoints
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// REST API routes
app.post('/api/register', (req, res) => {
  const { username, password, playerName } = req.body;
  if (!username || !password || !playerName) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 3 || password.length < 4) return res.status(400).json({ error: 'Username min 3 chars, password min 4 chars' });
  if (playerName.length < 2 || playerName.length > 20) return res.status(400).json({ error: 'Player name 2-20 chars' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const userResult = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    const userId = userResult.lastInsertRowid;

    const playerResult = db.prepare('INSERT INTO players (user_id, name, current_sector) VALUES (?, ?, 1)').run(userId, playerName);
    const playerId = playerResult.lastInsertRowid;

    // Give starting ship (Merchant Cruiser, type 1)
    const shipType = db.prepare('SELECT * FROM ship_types WHERE id = 1').get();
    db.prepare('INSERT INTO ships (player_id, type_id, name, shields, max_shields, fighters) VALUES (?, 1, ?, ?, ?, 10)')
      .run(playerId, playerName + "'s Ship", shipType.shield_capacity, shipType.shield_capacity);

    // Initialize all skills at level 0
    const skills = db.prepare('SELECT id FROM skills').all();
    const insertSkill = db.prepare('INSERT INTO player_skills (player_id, skill_id, level) VALUES (?, ?, 0)');
    const initSkills = db.transaction(() => { for (const s of skills) insertSkill.run(playerId, s.id); });
    initSkills();

    const token = jwt.sign({ userId, playerId, playerName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, playerId, playerName });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username or player name already taken' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(user.id);
  if (!player) return res.status(500).json({ error: 'No player found' });

  db.prepare('UPDATE players SET online = 1, last_login = CURRENT_TIMESTAMP WHERE id = ?').run(player.id);

  const token = jwt.sign({ userId: user.id, playerId: player.id, playerName: player.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, playerId: player.id, playerName: player.name });
});

app.get('/api/leaderboard', (req, res) => {
  const leaders = game.getLeaderboard(db);
  res.json(leaders);
});

// Socket.IO auth middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

// Track connected sockets by player ID
const playerSockets = new Map();

io.on('connection', (socket) => {
  const { playerId, playerName } = socket.user;
  playerSockets.set(playerId, socket);
  db.prepare('UPDATE players SET online = 1 WHERE id = ?').run(playerId);

  console.log(`${playerName} connected`);

  // Send initial game state
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  const ship = game.getPlayerShip(db, playerId);
  const sector = game.getSectorInfo(db, player.current_sector, playerId);

  socket.emit('gameState', { player, ship, sector });

  // Movement
  socket.on('move', (targetSector, callback) => {
    const result = game.moveToSector(db, playerId, targetSector);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      const newShip = game.getPlayerShip(db, playerId);
      const newSector = game.getSectorInfo(db, newPlayer.current_sector, playerId);
      // Notify others in new sector
      broadcastToSector(newPlayer.current_sector, playerId, 'playerEntered', { playerName, playerId });
      callback({ ...result, player: newPlayer, ship: newShip, sector: newSector });
    } else {
      callback(result);
    }
  });

  // Trading
  socket.on('trade', ({ action, commodity, amount }, callback) => {
    const result = game.tradeAtPort(db, playerId, action, commodity, amount);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, player: newPlayer, ship: newShip });
    } else {
      callback(result);
    }
  });

  // Port info
  socket.on('getPortInfo', (sectorId, callback) => {
    const player = db.prepare('SELECT current_sector FROM players WHERE id = ?').get(playerId);
    callback(game.getPortInfo(db, sectorId || player.current_sector));
  });

  // Sector info
  socket.on('getSectorInfo', (sectorId, callback) => {
    const player = db.prepare('SELECT current_sector FROM players WHERE id = ?').get(playerId);
    callback(game.getSectorInfo(db, sectorId || player.current_sector, playerId));
  });

  // Ship types
  socket.on('getShipTypes', (callback) => {
    callback(game.getShipTypes(db));
  });

  // Buy ship
  socket.on('buyShip', (shipTypeId, callback) => {
    const result = game.buyShip(db, playerId, shipTypeId);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, player: newPlayer, ship: newShip });
    } else {
      callback(result);
    }
  });

  // Combat
  socket.on('attack', (defenderId, callback) => {
    const result = game.attackPlayer(db, playerId, defenderId);
    const defSocket = playerSockets.get(defenderId);
    if (defSocket && result.success) {
      const defPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(defenderId);
      const defShip = game.getPlayerShip(db, defenderId);
      const defSector = game.getSectorInfo(db, defPlayer.current_sector, defenderId);
      defSocket.emit('attacked', { ...result, player: defPlayer, ship: defShip, sector: defSector });
    }
    const atkPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    const atkShip = game.getPlayerShip(db, playerId);
    callback({ ...result, player: atkPlayer, ship: atkShip });
  });

  // Deploy fighters
  socket.on('deployFighters', ({ quantity, mode }, callback) => {
    const result = game.deployFighters(db, playerId, quantity, mode);
    callback(result);
  });

  // Deploy mines
  socket.on('deployMines', ({ quantity, type }, callback) => {
    const result = game.deployMines(db, playerId, quantity, type);
    callback(result);
  });

  // Collect fighters
  socket.on('collectFighters', (quantity, callback) => {
    const result = game.collectFighters(db, playerId, quantity);
    if (result.success) {
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, ship: newShip });
    } else {
      callback(result);
    }
  });

  // Planet operations
  socket.on('landOnPlanet', (planetId, callback) => {
    callback(game.landOnPlanet(db, playerId, planetId));
  });

  socket.on('claimPlanet', (planetId, callback) => {
    const result = game.claimPlanet(db, playerId, planetId);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      callback({ ...result, player: newPlayer });
    } else {
      callback(result);
    }
  });

  socket.on('transferToPlanet', ({ planetId, commodity, amount }, callback) => {
    const result = game.transferToPlanet(db, playerId, planetId, commodity, amount);
    if (result.success) {
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, ship: newShip });
    } else {
      callback(result);
    }
  });

  socket.on('transferFromPlanet', ({ planetId, commodity, amount }, callback) => {
    const result = game.transferFromPlanet(db, playerId, planetId, commodity, amount);
    if (result.success) {
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, ship: newShip });
    } else {
      callback(result);
    }
  });

  socket.on('buildCitadel', (planetId, callback) => {
    callback(game.buildCitadel(db, playerId, planetId));
  });

  socket.on('upgradeCitadel', ({ planetId, module }, callback) => {
    callback(game.upgradeCitadelModule(db, playerId, planetId, module));
  });

  // Corporation operations
  socket.on('createCorp', ({ name, tag }, callback) => {
    const result = game.createCorporation(db, playerId, name, tag);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      callback({ ...result, player: newPlayer });
    } else {
      callback(result);
    }
  });

  socket.on('getCorpInfo', (corpId, callback) => {
    const player = db.prepare('SELECT corp_id FROM players WHERE id = ?').get(playerId);
    callback(game.getCorpInfo(db, corpId || player.corp_id));
  });

  socket.on('joinCorp', (corpId, callback) => {
    const result = game.joinCorporation(db, playerId, corpId);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      callback({ ...result, player: newPlayer });
    } else {
      callback(result);
    }
  });

  socket.on('leaveCorp', (callback) => {
    const result = game.leaveCorporation(db, playerId);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      callback({ ...result, player: newPlayer });
    } else {
      callback(result);
    }
  });

  socket.on('corpDeposit', (amount, callback) => {
    callback(game.corpDeposit(db, playerId, amount));
  });

  socket.on('corpWithdraw', (amount, callback) => {
    callback(game.corpWithdraw(db, playerId, amount));
  });

  // Market orders
  socket.on('placeMarketOrder', ({ commodity, orderType, quantity, price }, callback) => {
    const result = game.placeMarketOrder(db, playerId, commodity, orderType, quantity, price);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, player: newPlayer, ship: newShip });
    } else {
      callback(result);
    }
  });

  socket.on('getMarketOrders', ({ sectorId, commodity }, callback) => {
    const player = db.prepare('SELECT current_sector FROM players WHERE id = ?').get(playerId);
    callback(game.getMarketOrders(db, sectorId || player.current_sector, commodity));
  });

  socket.on('cancelMarketOrder', (orderId, callback) => {
    callback(game.cancelMarketOrder(db, playerId, orderId));
  });

  // Skills
  socket.on('getSkills', (callback) => {
    callback(game.getPlayerSkills(db, playerId));
  });

  socket.on('trainSkill', (skillId, callback) => {
    callback(game.startTraining(db, playerId, skillId));
  });

  socket.on('cancelTraining', (skillId, callback) => {
    callback(game.cancelTraining(db, playerId, skillId));
  });

  // Messages
  socket.on('sendMessage', ({ toName, subject, body }, callback) => {
    const target = db.prepare('SELECT id FROM players WHERE name = ?').get(toName);
    if (!target) return callback({ success: false, message: 'Player not found' });
    const result = game.sendMessage(db, playerId, target.id, subject, body);
    const targetSocket = playerSockets.get(target.id);
    if (targetSocket) targetSocket.emit('newMessage');
    callback(result);
  });

  socket.on('getMessages', (callback) => {
    callback(game.getMessages(db, playerId));
  });

  socket.on('readMessage', (messageId, callback) => {
    callback(game.readMessage(db, playerId, messageId));
  });

  // Galaxy map data
  socket.on('getGalaxyMap', (callback) => {
    const sectors = db.prepare('SELECT id, is_nebula, has_stardock, region_name FROM sectors').all();
    const warps = db.prepare('SELECT from_sector, to_sector FROM sector_warps').all();
    const ports = db.prepare('SELECT sector_id, class FROM ports').all();
    const planets = db.prepare('SELECT sector_id FROM planets').all();
    const playerLocs = db.prepare('SELECT id, name, current_sector FROM players WHERE online = 1').all();
    callback({ sectors, warps, ports, planets, playerLocations: playerLocs });
  });

  // Leaderboard
  socket.on('getLeaderboard', (callback) => {
    callback(game.getLeaderboard(db));
  });

  // NPC interaction
  socket.on('interactNPC', (npcId, callback) => {
    callback(game.npcInteraction(db, playerId, npcId));
  });

  // Refresh state
  socket.on('refresh', (callback) => {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    const ship = game.getPlayerShip(db, playerId);
    const sector = game.getSectorInfo(db, player.current_sector, playerId);
    callback({ player, ship, sector });
  });

  socket.on('disconnect', () => {
    playerSockets.delete(playerId);
    db.prepare('UPDATE players SET online = 0 WHERE id = ?').run(playerId);
    console.log(`${playerName} disconnected`);
  });
});

function broadcastToSector(sectorId, excludePlayerId, event, data) {
  const playersInSector = db.prepare('SELECT id FROM players WHERE current_sector = ? AND online = 1 AND id != ?').all(sectorId, excludePlayerId);
  for (const p of playersInSector) {
    const s = playerSockets.get(p.id);
    if (s) s.emit(event, data);
  }
}

// Game tick - runs every 60 seconds
setInterval(() => {
  try {
    game.addTurns(db);
    game.regenPorts(db);
    game.processSkillTraining(db);
    game.runPlanetProduction(db);
    game.moveNPCs(db);

    // Decay/expire wormholes
    db.prepare("DELETE FROM wormholes WHERE expires_at <= datetime('now')").run();
    // Degrade wormhole stability
    db.prepare("UPDATE wormholes SET stability = MAX(0.1, stability - 0.01)").run();

    // Occasionally spawn new wormholes
    const whCount = db.prepare('SELECT COUNT(*) as c FROM wormholes').get().c;
    if (whCount < 3 && Math.random() < 0.1) {
      const { spawnWormholes } = require('./src/universe');
      spawnWormholes(db, UNIVERSE_SIZE);
    }
  } catch (err) {
    console.error('Game tick error:', err);
  }
}, 60000);

// Market matching every 30 seconds
setInterval(() => {
  try {
    const commodities = ['ore', 'organics', 'equipment'];
    const sectors = db.prepare('SELECT DISTINCT sector_id FROM market_orders WHERE filled = 0').all();
    for (const s of sectors) {
      for (const c of commodities) {
        game.processMarketMatches(db, s.sector_id, c);
      }
    }
  } catch (err) {
    console.error('Market tick error:', err);
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Intergalactic Trade Wars running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to play`);
});
