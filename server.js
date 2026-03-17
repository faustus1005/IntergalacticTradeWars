const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb, seedShipTypes, seedSkills, seedUpgradeTypes, seedCompanionTypes } = require('./src/database');
const logger = require('./src/logger');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'intergalactic-trade-wars-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;
const UNIVERSE_SIZE = parseInt(process.env.UNIVERSE_SIZE) || 500;

app.use(express.json());

// HTTP request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const userId = req.user ? req.user.userId : null;
    logger.access(req.method, req.originalUrl, res.statusCode, getClientIp(req), userId, duration);
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function getSocketIp(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address
    || 'unknown';
}

// Initialize database and seed data
const db = getDb();
seedShipTypes();
seedSkills();
seedUpgradeTypes();
seedCompanionTypes();

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
  if (!token) {
    logger.security(db, 'AUTH_NO_TOKEN', 'REST request with no token', { ip: getClientIp(req), url: req.originalUrl });
    return res.status(401).json({ error: 'No token' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    logger.security(db, 'AUTH_INVALID_TOKEN', 'REST request with invalid token', { ip: getClientIp(req), url: req.originalUrl });
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    logger.security(db, 'ADMIN_NO_TOKEN', 'Admin endpoint accessed with no token', { ip: getClientIp(req), url: req.originalUrl });
    return res.status(401).json({ error: 'No token' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (!req.user.isAdmin) {
      logger.security(db, 'ADMIN_ACCESS_DENIED', `Non-admin user attempted admin access: ${req.originalUrl}`, {
        userId: req.user.userId, playerId: req.user.playerId, ip: getClientIp(req), url: req.originalUrl
      });
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch {
    logger.security(db, 'ADMIN_INVALID_TOKEN', 'Admin endpoint accessed with invalid token', { ip: getClientIp(req), url: req.originalUrl });
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
    // First registered user becomes admin
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const isAdmin = userCount === 0 ? 1 : 0;
    const userResult = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, hash, isAdmin);
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

    const token = jwt.sign({ userId, playerId, playerName, isAdmin: isAdmin === 1 }, JWT_SECRET, { expiresIn: '7d' });

    logger.security(db, 'USER_REGISTERED', `New user registered: ${username} (player: ${playerName})`, {
      userId, playerId, ip: getClientIp(req), username, playerName, isAdmin: isAdmin === 1
    });

    res.json({ token, playerId, playerName, isAdmin: isAdmin === 1 });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      logger.security(db, 'REGISTER_DUPLICATE', `Registration failed - duplicate: ${username}`, { ip: getClientIp(req), username });
      return res.status(400).json({ error: 'Username or player name already taken' });
    }
    logger.error('auth', `Registration error for ${username}`, { error: err.message });
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    logger.security(db, 'LOGIN_FAILED', `Failed login attempt for: ${username}`, {
      ip: getClientIp(req), username, userExists: !!user
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(user.id);
  if (!player) return res.status(500).json({ error: 'No player found' });

  db.prepare('UPDATE players SET online = 1, last_login = CURRENT_TIMESTAMP WHERE id = ?').run(player.id);

  const isAdmin = user.is_admin === 1;
  const token = jwt.sign({ userId: user.id, playerId: player.id, playerName: player.name, isAdmin }, JWT_SECRET, { expiresIn: '7d' });

  logger.security(db, 'LOGIN_SUCCESS', `User logged in: ${username}`, {
    userId: user.id, playerId: player.id, ip: getClientIp(req), username, isAdmin
  });

  res.json({ token, playerId: player.id, playerName: player.name, isAdmin });
});

app.get('/api/leaderboard', (req, res) => {
  const leaders = game.getLeaderboard(db);
  res.json(leaders);
});

// ============ ADMIN REST API ============

app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const stats = {
    totalUsers: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    onlinePlayers: db.prepare('SELECT COUNT(*) as c FROM players WHERE online = 1').get().c,
    totalPlayers: db.prepare('SELECT COUNT(*) as c FROM players').get().c,
    totalSectors: db.prepare('SELECT COUNT(*) as c FROM sectors').get().c,
    totalPorts: db.prepare('SELECT COUNT(*) as c FROM ports').get().c,
    totalPlanets: db.prepare('SELECT COUNT(*) as c FROM planets').get().c,
    totalCorps: db.prepare('SELECT COUNT(*) as c FROM corporations').get().c,
    totalMessages: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
    recentCombat: db.prepare('SELECT cl.*, p1.name as attacker_name, p2.name as defender_name FROM combat_log cl LEFT JOIN players p1 ON cl.attacker_id = p1.id LEFT JOIN players p2 ON cl.defender_id = p2.id ORDER BY cl.created_at DESC LIMIT 10').all(),
  };
  res.json(stats);
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.created_at,
           p.id as player_id, p.name as player_name, p.credits, p.alignment,
           p.turns_remaining, p.current_sector, p.online, p.kills, p.deaths, p.experience
    FROM users u
    LEFT JOIN players p ON p.user_id = u.id
    ORDER BY u.id ASC
  `).all();
  res.json(users);
});

app.put('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { is_admin, password } = req.body;
  // Prevent self-de-admin
  if (is_admin === false && parseInt(id) === req.user.userId) {
    return res.status(400).json({ error: 'Cannot remove your own admin status' });
  }
  if (is_admin !== undefined) {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, id);
    logger.security(db, 'ADMIN_CHANGE_ROLE', `Admin ${req.user.playerName} changed admin status of user ${id} to ${is_admin}`, {
      userId: req.user.userId, ip: getClientIp(req), targetUserId: parseInt(id), newAdminStatus: is_admin
    });
  }
  if (password) {
    if (password.length < 4) return res.status(400).json({ error: 'Password min 4 chars' });
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    logger.security(db, 'ADMIN_RESET_PASSWORD', `Admin ${req.user.playerName} reset password for user ${id}`, {
      userId: req.user.userId, ip: getClientIp(req), targetUserId: parseInt(id)
    });
  }
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const player = db.prepare('SELECT id FROM players WHERE user_id = ?').get(id);
  if (player) {
    // Clean up player data
    db.prepare('DELETE FROM player_skills WHERE player_id = ?').run(player.id);
    db.prepare('DELETE FROM skill_queue WHERE player_id = ?').run(player.id);
    db.prepare('DELETE FROM ships WHERE player_id = ?').run(player.id);
    db.prepare('DELETE FROM companions WHERE player_id = ?').run(player.id);
    db.prepare('DELETE FROM market_orders WHERE player_id = ?').run(player.id);
    db.prepare('UPDATE planets SET owner_id = NULL WHERE owner_id = ?').run(player.id);
    db.prepare('DELETE FROM corp_members WHERE player_id = ?').run(player.id);
    db.prepare('DELETE FROM messages WHERE from_id = ? OR to_id = ?').run(player.id, player.id);
    db.prepare('DELETE FROM sector_fighters WHERE owner_id = ?').run(player.id);
    db.prepare('DELETE FROM sector_mines WHERE owner_id = ?').run(player.id);
    db.prepare('DELETE FROM players WHERE id = ?').run(player.id);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);

  logger.security(db, 'ADMIN_DELETE_USER', `Admin ${req.user.playerName} deleted user ${id}`, {
    userId: req.user.userId, ip: getClientIp(req), targetUserId: parseInt(id),
    targetPlayerId: player ? player.id : null
  });

  res.json({ success: true });
});

app.get('/api/admin/players', adminMiddleware, (req, res) => {
  const players = db.prepare(`
    SELECT p.*, u.username, u.is_admin,
           s.name as ship_name, st.name as ship_type_name,
           c.name as corp_name
    FROM players p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN ships s ON s.player_id = p.id AND s.active = 1
    LEFT JOIN ship_types st ON st.id = s.type_id
    LEFT JOIN corporations c ON c.id = p.corp_id
    ORDER BY p.id ASC
  `).all();
  res.json(players);
});

app.put('/api/admin/players/:id', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { credits, alignment, turns_remaining, max_turns, current_sector, experience, kills, deaths } = req.body;
  const fields = [];
  const vals = [];
  if (credits !== undefined) { fields.push('credits = ?'); vals.push(Math.max(0, parseInt(credits))); }
  if (alignment !== undefined) { fields.push('alignment = ?'); vals.push(Math.max(-999, Math.min(999, parseInt(alignment)))); }
  if (turns_remaining !== undefined) { fields.push('turns_remaining = ?'); vals.push(Math.max(0, parseInt(turns_remaining))); }
  if (max_turns !== undefined) { fields.push('max_turns = ?'); vals.push(Math.max(1, parseInt(max_turns))); }
  if (current_sector !== undefined) {
    const sector = db.prepare('SELECT id FROM sectors WHERE id = ?').get(parseInt(current_sector));
    if (!sector) return res.status(400).json({ error: 'Invalid sector' });
    fields.push('current_sector = ?'); vals.push(parseInt(current_sector));
  }
  if (experience !== undefined) { fields.push('experience = ?'); vals.push(Math.max(0, parseInt(experience))); }
  if (kills !== undefined) { fields.push('kills = ?'); vals.push(Math.max(0, parseInt(kills))); }
  if (deaths !== undefined) { fields.push('deaths = ?'); vals.push(Math.max(0, parseInt(deaths))); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(id);
  db.prepare(`UPDATE players SET ${fields.join(', ')} WHERE id = ?`).run(...vals);

  logger.security(db, 'ADMIN_MODIFY_PLAYER', `Admin ${req.user.playerName} modified player ${id}`, {
    userId: req.user.userId, ip: getClientIp(req), targetPlayerId: parseInt(id),
    modifiedFields: Object.keys(req.body)
  });

  res.json({ success: true });
});

app.get('/api/admin/players/:id/ship', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const ship = db.prepare(`
    SELECT s.*, st.name as type_name, st.cargo_capacity, st.fighter_capacity,
           st.mine_capacity, st.shield_capacity
    FROM ships s
    JOIN ship_types st ON st.id = s.type_id
    WHERE s.player_id = ? AND s.active = 1
  `).get(id);
  const shipTypes = db.prepare('SELECT id, name, cargo_capacity, fighter_capacity, mine_capacity, shield_capacity FROM ship_types ORDER BY base_cost ASC').all();
  res.json({ ship, shipTypes });
});

app.put('/api/admin/players/:id/ship', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { type_id, name, ore, organics, equipment, colonists, fighters, mines, shields } = req.body;
  const ship = db.prepare('SELECT * FROM ships WHERE player_id = ? AND active = 1').get(id);
  if (!ship) return res.status(404).json({ error: 'No active ship found' });
  const fields = [];
  const vals = [];
  if (type_id !== undefined) {
    const st = db.prepare('SELECT * FROM ship_types WHERE id = ?').get(parseInt(type_id));
    if (!st) return res.status(400).json({ error: 'Invalid ship type' });
    fields.push('type_id = ?'); vals.push(parseInt(type_id));
    fields.push('max_shields = ?'); vals.push(st.shield_capacity);
  }
  if (name !== undefined) { fields.push('name = ?'); vals.push(String(name).slice(0, 50)); }
  if (ore !== undefined) { fields.push('ore = ?'); vals.push(Math.max(0, parseInt(ore))); }
  if (organics !== undefined) { fields.push('organics = ?'); vals.push(Math.max(0, parseInt(organics))); }
  if (equipment !== undefined) { fields.push('equipment = ?'); vals.push(Math.max(0, parseInt(equipment))); }
  if (colonists !== undefined) { fields.push('colonists = ?'); vals.push(Math.max(0, parseInt(colonists))); }
  if (fighters !== undefined) { fields.push('fighters = ?'); vals.push(Math.max(0, parseInt(fighters))); }
  if (mines !== undefined) { fields.push('mines = ?'); vals.push(Math.max(0, parseInt(mines))); }
  if (shields !== undefined) { fields.push('shields = ?'); vals.push(Math.max(0, parseInt(shields))); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(ship.id);
  db.prepare(`UPDATE ships SET ${fields.join(', ')} WHERE id = ?`).run(...vals);

  logger.security(db, 'ADMIN_MODIFY_SHIP', `Admin ${req.user.playerName} modified ship for player ${id}`, {
    userId: req.user.userId, ip: getClientIp(req), targetPlayerId: parseInt(id),
    shipId: ship.id, modifiedFields: Object.keys(req.body)
  });

  res.json({ success: true });
});

app.get('/api/admin/players/:id/companions', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const companions = db.prepare(`
    SELECT c.*, ct.name as type_name, ct.race, ct.personality, ct.hire_cost
    FROM companions c
    JOIN companion_types ct ON ct.id = c.companion_type_id
    WHERE c.player_id = ?
  `).all(id);
  const allTypes = db.prepare('SELECT id, name, race, personality, hire_cost FROM companion_types ORDER BY id ASC').all();
  res.json({ companions, allTypes });
});

app.post('/api/admin/players/:id/companions', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { companion_type_id, nickname, affinity, mood } = req.body;
  const count = db.prepare('SELECT COUNT(*) as c FROM companions WHERE player_id = ?').get(id).c;
  if (count >= 3) return res.status(400).json({ error: 'Player already has max companions (3)' });
  const existing = db.prepare('SELECT id FROM companions WHERE player_id = ? AND companion_type_id = ?').get(id, companion_type_id);
  if (existing) return res.status(400).json({ error: 'Player already has this companion' });
  db.prepare(`
    INSERT INTO companions (player_id, companion_type_id, nickname, affinity, mood, hired_at, last_interaction)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, companion_type_id, nickname || null, Math.max(0, Math.min(100, parseInt(affinity || 50))), Math.max(0, Math.min(100, parseInt(mood || 50))));
  res.json({ success: true });
});

app.delete('/api/admin/players/:id/companions/:companionTypeId', adminMiddleware, (req, res) => {
  const { id, companionTypeId } = req.params;
  db.prepare('DELETE FROM companions WHERE player_id = ? AND companion_type_id = ?').run(id, companionTypeId);
  res.json({ success: true });
});

app.put('/api/admin/players/:id/companions/:companionTypeId', adminMiddleware, (req, res) => {
  const { id, companionTypeId } = req.params;
  const { affinity, mood, nickname } = req.body;
  const fields = [];
  const vals = [];
  if (affinity !== undefined) { fields.push('affinity = ?'); vals.push(Math.max(0, Math.min(100, parseInt(affinity)))); }
  if (mood !== undefined) { fields.push('mood = ?'); vals.push(Math.max(0, Math.min(100, parseInt(mood)))); }
  if (nickname !== undefined) { fields.push('nickname = ?'); vals.push(nickname ? String(nickname).slice(0, 50) : null); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(id, companionTypeId);
  db.prepare(`UPDATE companions SET ${fields.join(', ')} WHERE player_id = ? AND companion_type_id = ?`).run(...vals);
  res.json({ success: true });
});

app.get('/api/admin/corporations', adminMiddleware, (req, res) => {
  const corps = db.prepare(`
    SELECT c.*, p.name as ceo_name,
           (SELECT COUNT(*) FROM corp_members cm WHERE cm.corp_id = c.id) as member_count
    FROM corporations c
    LEFT JOIN players p ON p.id = c.ceo_id
    ORDER BY c.id ASC
  `).all();
  res.json(corps);
});

app.delete('/api/admin/corporations/:id', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const corp = db.prepare('SELECT name FROM corporations WHERE id = ?').get(id);
  db.prepare('UPDATE players SET corp_id = NULL WHERE corp_id = ?').run(id);
  db.prepare('DELETE FROM corp_members WHERE corp_id = ?').run(id);
  db.prepare('DELETE FROM corporations WHERE id = ?').run(id);

  logger.security(db, 'ADMIN_DELETE_CORP', `Admin ${req.user.playerName} deleted corporation ${id} (${corp ? corp.name : 'unknown'})`, {
    userId: req.user.userId, ip: getClientIp(req), corpId: parseInt(id), corpName: corp ? corp.name : null
  });

  res.json({ success: true });
});

// Socket.IO auth middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    logger.security(db, 'WS_AUTH_NO_TOKEN', 'WebSocket connection attempt with no token', { ip: getSocketIp(socket) });
    return next(new Error('Authentication required'));
  }
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    logger.security(db, 'WS_AUTH_INVALID_TOKEN', 'WebSocket connection attempt with invalid token', { ip: getSocketIp(socket) });
    next(new Error('Invalid token'));
  }
});

// Track connected sockets by player ID
const playerSockets = new Map();

io.on('connection', (socket) => {
  const { playerId, playerName } = socket.user;
  playerSockets.set(playerId, socket);
  db.prepare('UPDATE players SET online = 1 WHERE id = ?').run(playerId);

  logger.security(db, 'WS_CONNECTED', `Player connected: ${playerName}`, {
    userId: socket.user.userId, playerId, ip: getSocketIp(socket), playerName
  });

  // Send initial game state
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) {
    socket.emit('error', { message: 'Player not found. Please log in again.' });
    socket.disconnect();
    return;
  }
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
      logger.info('trade', `${playerName} ${action} ${amount} ${commodity}`, {
        playerId, action, commodity, amount, ip: getSocketIp(socket)
      });
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
      logger.security(db, 'SHIP_PURCHASE', `${playerName} purchased ship type ${shipTypeId}`, {
        playerId, ip: getSocketIp(socket), shipTypeId
      });
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

    logger.security(db, 'COMBAT', `${playerName} attacked player ${defenderId}: ${result.success ? result.result || 'success' : 'failed'}`, {
      playerId, ip: getSocketIp(socket), defenderId, success: result.success,
      result: result.result || null
    });

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
    if (result.success) {
      logger.info('military', `${playerName} deployed ${quantity} fighters (${mode})`, {
        playerId, ip: getSocketIp(socket), quantity, mode
      });
    }
    callback(result);
  });

  // Deploy mines
  socket.on('deployMines', ({ quantity, type }, callback) => {
    const result = game.deployMines(db, playerId, quantity, type);
    if (result.success) {
      logger.info('military', `${playerName} deployed ${quantity} mines (${type})`, {
        playerId, ip: getSocketIp(socket), quantity, mineType: type
      });
    }
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
      logger.security(db, 'CORP_CREATED', `${playerName} created corporation: ${name} [${tag}]`, {
        playerId, ip: getSocketIp(socket), corpName: name, corpTag: tag
      });
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
    const result = game.corpDeposit(db, playerId, amount);
    if (result.success) {
      logger.security(db, 'CORP_DEPOSIT', `${playerName} deposited ${amount} credits to corp`, {
        playerId, ip: getSocketIp(socket), amount
      });
    }
    callback(result);
  });

  socket.on('corpWithdraw', (amount, callback) => {
    const result = game.corpWithdraw(db, playerId, amount);
    if (result.success) {
      logger.security(db, 'CORP_WITHDRAW', `${playerName} withdrew ${amount} credits from corp`, {
        playerId, ip: getSocketIp(socket), amount
      });
    }
    callback(result);
  });

  // Market orders
  socket.on('placeMarketOrder', ({ commodity, orderType, quantity, price }, callback) => {
    const result = game.placeMarketOrder(db, playerId, commodity, orderType, quantity, price);
    if (result.success) {
      logger.info('market', `${playerName} placed ${orderType} order: ${quantity} ${commodity} @ ${price}`, {
        playerId, ip: getSocketIp(socket), commodity, orderType, quantity, price
      });
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

  // Ship Customization
  socket.on('renameShip', (newName, callback) => {
    const result = game.renameShip(db, playerId, newName);
    if (result.success) {
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, ship: newShip });
    } else {
      callback(result);
    }
  });

  socket.on('getUpgradeTypes', (callback) => {
    callback(game.getUpgradeTypes(db));
  });

  socket.on('getShipUpgrades', (callback) => {
    callback(game.getShipUpgrades(db, playerId));
  });

  socket.on('installUpgrade', (upgradeTypeId, callback) => {
    const result = game.installUpgrade(db, playerId, upgradeTypeId);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, player: newPlayer, ship: newShip });
    } else {
      callback(result);
    }
  });

  socket.on('removeUpgrade', (upgradeTypeId, callback) => {
    const result = game.removeUpgrade(db, playerId, upgradeTypeId);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      const newShip = game.getPlayerShip(db, playerId);
      callback({ ...result, player: newPlayer, ship: newShip });
    } else {
      callback(result);
    }
  });

  // Captain's Quarters
  socket.on('getCompanionTypes', (callback) => {
    callback(game.getCompanionTypes(db));
  });

  socket.on('getQuartersStatus', (callback) => {
    callback(game.getQuartersStatus(db, playerId));
  });

  socket.on('hireCompanion', (companionTypeId, callback) => {
    const result = game.hireCompanion(db, playerId, companionTypeId);
    if (result.success) {
      const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
      callback({ ...result, player: newPlayer });
    } else {
      callback(result);
    }
  });

  socket.on('dismissCompanion', (companionTypeId, callback) => {
    callback(game.dismissCompanion(db, playerId, companionTypeId));
  });

  socket.on('interactCompanion', ({ companionTypeId, action }, callback) => {
    callback(game.interactWithCompanion(db, playerId, companionTypeId, action));
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
    logger.security(db, 'WS_DISCONNECTED', `Player disconnected: ${playerName}`, {
      userId: socket.user.userId, playerId, ip: getSocketIp(socket), playerName
    });
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
    logger.error('game', 'Game tick error', { error: err.message, stack: err.stack });
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
    logger.error('market', 'Market tick error', { error: err.message, stack: err.stack });
  }
}, 30000);

server.listen(PORT, () => {
  logger.info('server', `Intergalactic Trade Wars running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to play`);
});
