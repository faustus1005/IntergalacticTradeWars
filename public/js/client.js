/* === INTERGALACTIC TRADE WARS - Client === */

let socket = null;
let token = null;
let gameState = { player: null, ship: null, sector: null };
let mapData = null;
let mapTransform = { x: 0, y: 0, scale: 1 };
let sectorPositions = {};
let activePlanet = null;
let mapDrag = { active: false, sx: 0, sy: 0, tx: 0, ty: 0 };
let skillRefreshTimer = null;

// ============ AUTH ============

function showRegister() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('register-form').style.display = 'block';
  document.getElementById('auth-error').textContent = '';
}

function showLogin() {
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('auth-error').textContent = '';
}

async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) return showAuthError('Fill in all fields');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.error);
    token = data.token;
    localStorage.setItem('itw_token', token);
    connectSocket();
  } catch (e) {
    showAuthError('Connection failed');
  }
}

async function doRegister() {
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const playerName = document.getElementById('reg-playername').value.trim();
  if (!username || !password || !playerName) return showAuthError('Fill in all fields');

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, playerName })
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.error);
    token = data.token;
    localStorage.setItem('itw_token', token);
    connectSocket();
  } catch (e) {
    showAuthError('Connection failed');
  }
}

function showAuthError(msg) {
  document.getElementById('auth-error').textContent = msg;
}

// ============ SOCKET ============

function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('connect', () => {
    log('Connected to galaxy network', 'system');
  });

  socket.on('connect_error', (err) => {
    showAuthError('Authentication failed');
    localStorage.removeItem('itw_token');
  });

  socket.on('gameState', (state) => {
    gameState = state;
    enterGame();
    updateUI();
  });

  socket.on('playerEntered', ({ playerName }) => {
    log(`${playerName} warped into the sector`, 'info');
    refreshSector();
  });

  socket.on('attacked', (data) => {
    log('You are under attack!', 'danger');
    gameState.player = data.player;
    gameState.ship = data.ship;
    gameState.sector = data.sector;
    updateUI();
    showCombatResult(data, true);
  });

  socket.on('newMessage', () => {
    log('New subspace message received', 'info');
  });

  socket.on('disconnect', () => {
    log('Disconnected from galaxy network', 'warning');
  });
}

function enterGame() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');
  document.getElementById('game-screen').style.display = 'flex';

  // Setup nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const panel = btn.dataset.panel;
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + panel).classList.add('active');
      if (panel === 'map') loadMap();
      if (panel === 'ship') loadShipPanel();
      if (panel === 'skills') loadSkills();
      if (panel === 'corp') loadCorp();
      if (panel === 'comms') refreshMessages();
      if (panel === 'rankings') loadRankings();
      if (panel === 'market') refreshMarket();
      if (panel === 'upgrades') loadUpgradesPanel();
      if (panel === 'quarters') loadQuartersPanel();
    });
  });

  setupMapCanvas();
  log('Welcome to Intergalactic Trade Wars, ' + gameState.player.name + '!', 'system');
}

// ============ UI UPDATE ============

function updateUI() {
  const { player, ship, sector } = gameState;
  if (!player) return;

  // Top bar
  document.getElementById('player-name').textContent = player.name;
  const alignTitle = getAlignmentTitle(player.alignment);
  const alignEl = document.getElementById('player-alignment');
  alignEl.textContent = alignTitle;
  alignEl.className = 'player-align ' + (player.alignment >= 100 ? 'align-good' : player.alignment <= -100 ? 'align-evil' : 'align-neutral');
  document.getElementById('player-credits').textContent = formatNumber(player.credits);
  document.getElementById('player-turns').textContent = player.turns_remaining;
  document.getElementById('player-sector').textContent = player.current_sector;

  if (ship) {
    document.getElementById('ship-name').textContent = ship.ship_name || ship.name;
    document.getElementById('ship-shields').textContent = ship.shields + '/' + ship.max_shields;
    document.getElementById('ship-fighters').textContent = ship.fighters;
    document.getElementById('ship-mines').textContent = ship.mines;

    const totalCargo = ship.ore + ship.organics + ship.equipment + ship.colonists;
    const maxCargo = ship.cargo_capacity;
    document.getElementById('cargo-ore').textContent = ship.ore;
    document.getElementById('cargo-org').textContent = ship.organics;
    document.getElementById('cargo-equ').textContent = ship.equipment;
    document.getElementById('cargo-col').textContent = ship.colonists;
    document.getElementById('cargo-text').textContent = totalCargo + ' / ' + maxCargo;
    const fill = maxCargo > 0 ? (totalCargo / maxCargo * 100) : 0;
    document.getElementById('cargo-fill').style.width = Math.min(fill, 100) + '%';
  }

  updateSectorUI();
}

function updateSectorUI() {
  const { sector } = gameState;
  if (!sector) return;

  document.getElementById('sector-id').textContent = sector.id;
  document.getElementById('sector-beacon').textContent = sector.beacon_text || '';
  document.getElementById('sector-region').textContent = sector.region_name || '';

  const nebulaEl = document.getElementById('sector-nebula');
  nebulaEl.style.display = sector.is_nebula ? 'block' : 'none';

  const dockEl = document.getElementById('sector-stardock');
  dockEl.style.display = sector.has_stardock ? 'block' : 'none';

  // Warps
  const warpDiv = document.getElementById('warp-links');
  warpDiv.innerHTML = '';
  if (sector.warps) {
    sector.warps.forEach(w => {
      const btn = document.createElement('button');
      btn.className = 'warp-btn';
      btn.textContent = '→ Sector ' + w;
      btn.onclick = () => moveTo(w);
      warpDiv.appendChild(btn);
    });
  }
  if (sector.wormholes) {
    sector.wormholes.forEach(w => {
      const btn = document.createElement('button');
      btn.className = 'warp-btn wormhole';
      btn.textContent = '⟡ Wormhole → Sector ' + w.target;
      btn.title = 'Stability: ' + Math.round(w.stability * 100) + '%';
      btn.onclick = () => moveTo(w.target);
      warpDiv.appendChild(btn);
    });
  }

  // Port
  const portSection = document.getElementById('port-section');
  if (sector.port) {
    portSection.style.display = 'block';
    const p = sector.port;
    document.getElementById('port-name').textContent = p.name;
    document.getElementById('port-class').textContent = '(Class ' + p.class + ')';

    const setAction = (id, buying) => {
      const el = document.getElementById(id);
      el.textContent = buying ? 'BUYING' : 'SELLING';
      el.className = buying ? 'action-buying' : 'action-selling';
    };
    setAction('port-ore-action', p.ore_buying);
    setAction('port-org-action', p.organics_buying);
    setAction('port-equ-action', p.equipment_buying);

    document.getElementById('port-ore-qty').textContent = p.ore_quantity;
    document.getElementById('port-org-qty').textContent = p.organics_quantity;
    document.getElementById('port-equ-qty').textContent = p.equipment_quantity;
    document.getElementById('port-ore-price').textContent = p.ore_price + ' cr';
    document.getElementById('port-org-price').textContent = p.organics_price + ' cr';
    document.getElementById('port-equ-price').textContent = p.equipment_price + ' cr';
  } else {
    portSection.style.display = 'none';
  }

  // Planets
  const planetsSection = document.getElementById('planets-section');
  if (sector.planets && sector.planets.length > 0) {
    planetsSection.style.display = 'block';
    const list = document.getElementById('planet-list');
    list.innerHTML = '';
    sector.planets.forEach(p => {
      const div = document.createElement('div');
      div.className = 'planet-entry';
      div.innerHTML = `<span>${p.name} (${p.class}) ${p.owner_name ? '- ' + p.owner_name : '- Unclaimed'}</span>
        <button onclick="landPlanet(${p.id})">Land</button>`;
      list.appendChild(div);
    });
  } else {
    planetsSection.style.display = 'none';
  }

  // Ships
  const shipsSection = document.getElementById('ships-section');
  if (sector.ships && sector.ships.length > 0) {
    shipsSection.style.display = 'block';
    const list = document.getElementById('ships-list');
    list.innerHTML = '';
    sector.ships.forEach(s => {
      if (s.player_id === gameState.player.id) return;
      const div = document.createElement('div');
      div.className = 'ship-entry';
      div.innerHTML = `<span>${s.player_name} - ${s.ship_type}</span>
        <button onclick="attackTarget(${s.player_id})">Attack</button>`;
      list.appendChild(div);
    });
    if (list.children.length === 0) shipsSection.style.display = 'none';
  } else {
    shipsSection.style.display = 'none';
  }

  // NPCs
  const npcsSection = document.getElementById('npcs-section');
  if (sector.npcs && sector.npcs.length > 0) {
    npcsSection.style.display = 'block';
    const list = document.getElementById('npc-list');
    list.innerHTML = '';
    sector.npcs.forEach(n => {
      const div = document.createElement('div');
      div.className = 'npc-entry';
      const typeColor = n.type === 'federation' ? 'color:var(--green)' : n.type === 'ferrengi' ? 'color:var(--red)' : 'color:var(--yellow)';
      div.innerHTML = `<span style="${typeColor}">${n.name} (${n.type})</span>
        <button onclick="interactNPC(${n.id})" style="background:var(--accent);color:var(--bg-dark)">Interact</button>`;
      list.appendChild(div);
    });
  } else {
    npcsSection.style.display = 'none';
  }

  // Fighters
  const fightersSection = document.getElementById('fighters-section');
  if (sector.fighters && sector.fighters.length > 0) {
    fightersSection.style.display = 'block';
    const list = document.getElementById('fighters-list');
    list.innerHTML = '';
    sector.fighters.forEach(f => {
      const div = document.createElement('div');
      div.className = 'fighter-entry';
      const isOwn = f.owner_id === gameState.player.id;
      div.innerHTML = `<span>${isOwn ? 'Your' : f.owner_name + "'s"} fighters: ${f.quantity} (${f.mode})</span>`;
      list.appendChild(div);
    });
  } else {
    fightersSection.style.display = 'none';
  }

  // Mines
  const minesSection = document.getElementById('mines-section');
  if (sector.mines && sector.mines.length > 0) {
    minesSection.style.display = 'block';
    const list = document.getElementById('mines-list');
    list.innerHTML = '';
    sector.mines.forEach(m => {
      const div = document.createElement('div');
      div.className = 'mine-entry';
      const isOwn = m.owner_id === gameState.player.id;
      div.innerHTML = `<span>${isOwn ? 'Your' : 'Enemy'} ${m.type} mines: ${m.quantity}</span>`;
      list.appendChild(div);
    });
  } else {
    minesSection.style.display = 'none';
  }

  // Wormholes
  const whSection = document.getElementById('wormhole-section');
  if (sector.wormholes && sector.wormholes.length > 0) {
    whSection.style.display = 'block';
    const info = document.getElementById('wormhole-info');
    info.innerHTML = sector.wormholes.map(w =>
      `<p>Unstable passage to Sector ${w.target} (Stability: ${Math.round(w.stability * 100)}%)</p>`
    ).join('');
  } else {
    whSection.style.display = 'none';
  }
}

// ============ MOVEMENT ============

function moveTo(sectorId) {
  socket.emit('move', sectorId, (result) => {
    if (result.success) {
      gameState.player = result.player;
      gameState.ship = result.ship;
      gameState.sector = result.sector;
      updateUI();
      log('Warped to Sector ' + sectorId, 'success');
      if (result.events) {
        result.events.forEach(e => log(e.message, e.type || 'info'));
      }
    } else {
      log(result.message, 'warning');
    }
  });
}

function refreshSector() {
  socket.emit('refresh', (state) => {
    gameState.player = state.player;
    gameState.ship = state.ship;
    gameState.sector = state.sector;
    updateUI();
  });
}

// ============ TRADING ============

function doTrade(commodity) {
  const amtMap = { ore: 'trade-ore-amt', organics: 'trade-org-amt', equipment: 'trade-equ-amt' };
  const amount = parseInt(document.getElementById(amtMap[commodity]).value) || 0;
  if (amount <= 0) return log('Enter a valid amount', 'warning');

  const port = gameState.sector.port;
  const buyingMap = { ore: port.ore_buying, organics: port.organics_buying, equipment: port.equipment_buying };
  const action = buyingMap[commodity] ? 'sell' : 'buy';

  socket.emit('trade', { action, commodity, amount }, (result) => {
    if (result.success) {
      gameState.player = result.player;
      gameState.ship = result.ship;
      log(result.message, 'success');
      updateUI();
      refreshSector();
    } else {
      log(result.message, 'warning');
    }
  });
}

// ============ COMBAT ============

function attackTarget(defenderId) {
  showModal('Confirm Attack', 'Are you sure you want to attack this trader?', [
    { text: 'Cancel', action: closeModal },
    { text: 'Attack!', primary: true, action: () => {
      closeModal();
      socket.emit('attack', defenderId, (result) => {
        gameState.player = result.player;
        gameState.ship = result.ship;
        updateUI();
        showCombatResult(result, false);
      });
    }}
  ]);
}

function showCombatResult(result, wasDefender) {
  if (result.log) {
    result.log.forEach(entry => log(entry, 'combat'));
  }
  if (result.winner) {
    if ((wasDefender && result.winner === 'defender') || (!wasDefender && result.winner === 'attacker')) {
      log('Victory! ' + (result.message || ''), 'success');
    } else {
      log('Defeat! ' + (result.message || ''), 'danger');
    }
  }
  refreshSector();
}

function interactNPC(npcId) {
  socket.emit('interactNPC', npcId, (result) => {
    if (result.log) result.log.forEach(entry => log(entry, result.type || 'info'));
    if (result.message) log(result.message, result.type || 'info');
    if (result.player) gameState.player = result.player;
    if (result.ship) gameState.ship = result.ship;
    updateUI();
    refreshSector();
  });
}

// ============ DEPLOY/COLLECT ============

function deployFighterPrompt() {
  const ship = gameState.ship;
  if (!ship || ship.fighters <= 0) return log('No fighters to deploy', 'warning');
  showModal('Deploy Fighters', `
    <p>Fighters on ship: ${ship.fighters}</p>
    <input type="number" id="deploy-f-qty" min="1" max="${ship.fighters}" value="${ship.fighters}" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;width:100px;font-family:inherit">
    <select id="deploy-f-mode" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;font-family:inherit">
      <option value="defensive">Defensive</option>
      <option value="offensive">Offensive</option>
    </select>
  `, [
    { text: 'Cancel', action: closeModal },
    { text: 'Deploy', primary: true, action: () => {
      const qty = parseInt(document.getElementById('deploy-f-qty').value) || 0;
      const mode = document.getElementById('deploy-f-mode').value;
      closeModal();
      socket.emit('deployFighters', { quantity: qty, mode }, (result) => {
        log(result.message, result.success ? 'success' : 'warning');
        refreshSector();
      });
    }}
  ]);
}

function deployMinePrompt() {
  const ship = gameState.ship;
  if (!ship || ship.mines <= 0) return log('No mines to deploy', 'warning');
  showModal('Deploy Mines', `
    <p>Mines on ship: ${ship.mines}</p>
    <input type="number" id="deploy-m-qty" min="1" max="${ship.mines}" value="${ship.mines}" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;width:100px;font-family:inherit">
    <select id="deploy-m-type" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;font-family:inherit">
      <option value="regular">Regular</option>
      <option value="armored">Armored</option>
    </select>
  `, [
    { text: 'Cancel', action: closeModal },
    { text: 'Deploy', primary: true, action: () => {
      const qty = parseInt(document.getElementById('deploy-m-qty').value) || 0;
      const type = document.getElementById('deploy-m-type').value;
      closeModal();
      socket.emit('deployMines', { quantity: qty, type }, (result) => {
        log(result.message, result.success ? 'success' : 'warning');
        refreshSector();
      });
    }}
  ]);
}

function collectFighterPrompt() {
  socket.emit('getSectorInfo', null, (sector) => {
    const ownFighters = (sector.fighters || []).filter(f => f.owner_id === gameState.player.id);
    const total = ownFighters.reduce((sum, f) => sum + f.quantity, 0);
    if (total <= 0) return log('No fighters to collect', 'warning');
    showModal('Collect Fighters', `
      <p>Your fighters in sector: ${total}</p>
      <input type="number" id="collect-f-qty" min="1" max="${total}" value="${total}" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;width:100px;font-family:inherit">
    `, [
      { text: 'Cancel', action: closeModal },
      { text: 'Collect', primary: true, action: () => {
        const qty = parseInt(document.getElementById('collect-f-qty').value) || 0;
        closeModal();
        socket.emit('collectFighters', qty, (result) => {
          log(result.message, result.success ? 'success' : 'warning');
          if (result.ship) gameState.ship = result.ship;
          updateUI();
          refreshSector();
        });
      }}
    ]);
  });
}

// ============ PLANETS ============

function landPlanet(planetId) {
  socket.emit('landOnPlanet', planetId, (result) => {
    if (result.success) {
      activePlanet = result.planet;
      showPlanetPanel(result.planet);
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-panel="planet"]').classList.add('active');
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-planet').classList.add('active');
      log('Landed on ' + result.planet.name, 'success');
    } else {
      log(result.message, 'warning');
    }
  });
}

function showPlanetPanel(planet) {
  const det = document.getElementById('planet-details');
  const isOwner = planet.owner_id === gameState.player.id;
  const classInfo = {
    earth: { emoji: '🌍', trait: 'Balanced production' },
    oceanic: { emoji: '🌊', trait: 'Strong organics' },
    mountainous: { emoji: '⛰️', trait: 'Strong ore' },
    volcanic: { emoji: '🌋', trait: 'Strong fuel' },
    glacial: { emoji: '❄️', trait: 'Low production' },
    desert: { emoji: '🏜️', trait: 'Very low production' },
    gaseous: { emoji: '💨', trait: 'Highest fuel production' }
  };
  const ci = classInfo[planet.class] || { emoji: '🪐', trait: '' };

  let html = `<div class="planet-detail">
    <h3>${ci.emoji} ${planet.name} - ${planet.class.charAt(0).toUpperCase() + planet.class.slice(1)} World</h3>
    <p class="info-text">${ci.trait} | Production Rate: ${planet.production_rate}x | Owner: ${planet.owner_name || 'Unclaimed'}</p>
    <div class="planet-stats">
      <div class="ship-stat"><div class="label">Ore</div><div class="value">${planet.ore}</div></div>
      <div class="ship-stat"><div class="label">Organics</div><div class="value">${planet.organics}</div></div>
      <div class="ship-stat"><div class="label">Equipment</div><div class="value">${planet.equipment}</div></div>
      <div class="ship-stat"><div class="label">Colonists</div><div class="value">${planet.colonists}</div></div>
      <div class="ship-stat"><div class="label">Fuel Ore</div><div class="value">${planet.fuel_ore}</div></div>
      <div class="ship-stat"><div class="label">Fighters</div><div class="value">${planet.fighters}</div></div>
      <div class="ship-stat"><div class="label">Shields</div><div class="value">${planet.shields}</div></div>
      <div class="ship-stat"><div class="label">Treasury</div><div class="value">${formatNumber(planet.treasury)} cr</div></div>
    </div>`;

  if (!planet.owner_id) {
    html += `<div class="planet-actions"><button onclick="claimPlanet(${planet.id})">Claim Planet (1,000 cr)</button></div>`;
  } else if (isOwner) {
    html += `<div class="planet-actions">
      <button onclick="transferPrompt(${planet.id}, 'to')">Transfer to Planet</button>
      <button onclick="transferPrompt(${planet.id}, 'from')">Transfer from Planet</button>
      <button onclick="buildCitadel(${planet.id})">Build/Upgrade Citadel (Lv${planet.citadel_level})</button>
    </div>`;
    if (planet.citadel_level > 0) {
      html += `<div style="margin-top:12px">
        <h3>Citadel (Level ${planet.citadel_level})</h3>
        <div class="planet-stats">
          <div class="ship-stat"><div class="label">Combat Computer</div><div class="value">Lv${planet.combat_computer}</div></div>
          <div class="ship-stat"><div class="label">Quasar Cannon</div><div class="value">Lv${planet.quasar_cannon}</div></div>
          <div class="ship-stat"><div class="label">Transwarp</div><div class="value">${planet.has_transwarp ? 'Yes' : 'No'}</div></div>
          <div class="ship-stat"><div class="label">Interdictor</div><div class="value">${planet.has_interdictor ? 'Yes' : 'No'}</div></div>
          <div class="ship-stat"><div class="label">P. Shields</div><div class="value">${planet.planetary_shields}</div></div>
        </div>
        <div class="planet-actions" style="margin-top:8px">
          <button onclick="upgradeCitadel(${planet.id}, 'combat_computer')">Upgrade Combat Computer</button>
          <button onclick="upgradeCitadel(${planet.id}, 'quasar_cannon')">Upgrade Quasar Cannon</button>
          <button onclick="upgradeCitadel(${planet.id}, 'transwarp')">Install Transwarp</button>
          <button onclick="upgradeCitadel(${planet.id}, 'interdictor')">Install Interdictor</button>
          <button onclick="upgradeCitadel(${planet.id}, 'planetary_shields')">Upgrade Shields</button>
        </div>
      </div>`;
    }
  }
  html += '</div>';
  det.innerHTML = html;
}

function claimPlanet(planetId) {
  socket.emit('claimPlanet', planetId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      if (result.player) gameState.player = result.player;
      updateUI();
      landPlanet(planetId);
    }
  });
}

function transferPrompt(planetId, direction) {
  const title = direction === 'to' ? 'Transfer to Planet' : 'Transfer from Planet';
  showModal(title, `
    <select id="xfer-commodity" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;font-family:inherit">
      <option value="ore">Ore</option>
      <option value="organics">Organics</option>
      <option value="equipment">Equipment</option>
      <option value="colonists">Colonists</option>
      <option value="fighters">Fighters</option>
    </select>
    <input type="number" id="xfer-amount" min="1" placeholder="Amount" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;width:100px;font-family:inherit;margin-left:6px">
  `, [
    { text: 'Cancel', action: closeModal },
    { text: 'Transfer', primary: true, action: () => {
      const commodity = document.getElementById('xfer-commodity').value;
      const amount = parseInt(document.getElementById('xfer-amount').value) || 0;
      closeModal();
      const event = direction === 'to' ? 'transferToPlanet' : 'transferFromPlanet';
      socket.emit(event, { planetId, commodity, amount }, (result) => {
        log(result.message, result.success ? 'success' : 'warning');
        if (result.ship) gameState.ship = result.ship;
        updateUI();
        landPlanet(planetId);
      });
    }}
  ]);
}

function buildCitadel(planetId) {
  socket.emit('buildCitadel', planetId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) landPlanet(planetId);
  });
}

function upgradeCitadel(planetId, module) {
  socket.emit('upgradeCitadel', { planetId, module }, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) landPlanet(planetId);
  });
}

// ============ SHIP PANEL ============

function loadShipPanel() {
  const ship = gameState.ship;
  if (!ship) return;

  const det = document.getElementById('current-ship-details');
  det.innerHTML = `
    <div class="ship-stats">
      <div class="ship-stat"><div class="label">Type</div><div class="value">${ship.ship_name || ship.type_name || 'Unknown'}</div></div>
      <div class="ship-stat"><div class="label">Name</div><div class="value">${ship.name}</div></div>
      <div class="ship-stat"><div class="label">Cargo</div><div class="value">${ship.ore + ship.organics + ship.equipment + ship.colonists} / ${ship.cargo_capacity}</div></div>
      <div class="ship-stat"><div class="label">Fighters</div><div class="value">${ship.fighters} / ${ship.fighter_capacity}</div></div>
      <div class="ship-stat"><div class="label">Mines</div><div class="value">${ship.mines} / ${ship.mine_capacity}</div></div>
      <div class="ship-stat"><div class="label">Shields</div><div class="value">${ship.shields} / ${ship.max_shields}</div></div>
      <div class="ship-stat"><div class="label">Scanner</div><div class="value">Range ${ship.scanner_range}</div></div>
      <div class="ship-stat"><div class="label">Combat Odds</div><div class="value">${ship.combat_odds}%</div></div>
      <div class="ship-stat"><div class="label">Transwarp</div><div class="value">${ship.has_transwarp ? 'Yes' : 'No'}</div></div>
      <div class="ship-stat"><div class="label">Photon</div><div class="value">${ship.has_photon ? 'Yes' : 'No'}</div></div>
    </div>`;

  const dockDiv = document.getElementById('stardock-ships');
  if (gameState.sector && gameState.sector.has_stardock) {
    dockDiv.style.display = 'block';
    socket.emit('getShipTypes', (types) => {
      const catalog = document.getElementById('ship-catalog');
      catalog.innerHTML = '';
      types.forEach(t => {
        const canBuy = gameState.player.credits >= t.base_cost &&
          gameState.player.alignment >= t.min_alignment &&
          gameState.player.alignment <= t.max_alignment;
        const card = document.createElement('div');
        card.className = 'ship-card';
        card.innerHTML = `
          <h4>${t.name}</h4>
          <p class="ship-desc">${t.description}</p>
          <p class="ship-cost">${t.base_cost > 0 ? formatNumber(t.base_cost) + ' credits' : 'Free (starter)'}</p>
          <div class="mini-stats">
            <div>Cargo: ${t.cargo_capacity}</div>
            <div>Fighters: ${t.fighter_capacity}</div>
            <div>Mines: ${t.mine_capacity}</div>
            <div>Shields: ${t.shield_capacity}</div>
            <div>Scanner: ${t.scanner_range}</div>
            <div>Combat: ${t.combat_odds}%</div>
            <div>Transwarp: ${t.has_transwarp ? '✓' : '✗'}</div>
            <div>Photon: ${t.has_photon ? '✓' : '✗'}</div>
          </div>
          <button ${canBuy ? '' : 'disabled'} onclick="buyShipType(${t.id})">
            ${t.base_cost === 0 ? 'Already Owned' : canBuy ? 'Purchase' : 'Cannot Buy'}
          </button>`;
        catalog.appendChild(card);
      });
    });
  } else {
    dockDiv.style.display = 'none';
  }
}

function buyShipType(typeId) {
  socket.emit('buyShip', typeId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      gameState.player = result.player;
      gameState.ship = result.ship;
      updateUI();
      loadShipPanel();
    }
  });
}

// ============ MARKET ============

function refreshMarket() {
  const commodity = document.getElementById('market-commodity').value;
  socket.emit('getMarketOrders', { commodity }, (orders) => {
    const buyDiv = document.getElementById('market-buy-orders');
    const sellDiv = document.getElementById('market-sell-orders');
    buyDiv.innerHTML = '';
    sellDiv.innerHTML = '';

    if (!orders || orders.length === 0) {
      buyDiv.innerHTML = '<p class="info-text">No buy orders</p>';
      sellDiv.innerHTML = '<p class="info-text">No sell orders</p>';
    } else {
      const buyOrders = orders.filter(o => o.order_type === 'buy').sort((a, b) => b.price - a.price);
      const sellOrders = orders.filter(o => o.order_type === 'sell').sort((a, b) => a.price - b.price);

      if (buyOrders.length === 0) buyDiv.innerHTML = '<p class="info-text">No buy orders</p>';
      buyOrders.forEach(o => {
        const div = document.createElement('div');
        div.className = 'order-row';
        div.innerHTML = `<span>${o.quantity - o.filled} @ ${o.price} cr</span><span style="color:var(--text-dim)">${o.player_name || 'Anon'}</span>`;
        buyDiv.appendChild(div);
      });

      if (sellOrders.length === 0) sellDiv.innerHTML = '<p class="info-text">No sell orders</p>';
      sellOrders.forEach(o => {
        const div = document.createElement('div');
        div.className = 'order-row';
        div.innerHTML = `<span>${o.quantity - o.filled} @ ${o.price} cr</span><span style="color:var(--text-dim)">${o.player_name || 'Anon'}</span>`;
        sellDiv.appendChild(div);
      });
    }

    // My orders
    const myDiv = document.getElementById('my-orders');
    if (orders) {
      const mine = orders.filter(o => o.player_id === gameState.player.id && o.filled < o.quantity);
      if (mine.length === 0) {
        myDiv.innerHTML = '<p class="info-text">No active orders</p>';
      } else {
        myDiv.innerHTML = '';
        mine.forEach(o => {
          const div = document.createElement('div');
          div.className = 'order-row';
          div.innerHTML = `<span>${o.order_type.toUpperCase()} ${o.quantity - o.filled} ${commodity} @ ${o.price} cr</span>
            <button onclick="cancelOrder(${o.id})" style="padding:2px 8px;background:var(--red);border:none;border-radius:2px;color:white;cursor:pointer;font-family:inherit">Cancel</button>`;
          myDiv.appendChild(div);
        });
      }
    }
  });
}

function placeOrder() {
  const commodity = document.getElementById('market-commodity').value;
  const orderType = document.getElementById('order-type').value;
  const quantity = parseInt(document.getElementById('order-quantity').value) || 0;
  const price = parseInt(document.getElementById('order-price').value) || 0;
  if (quantity <= 0 || price <= 0) return log('Enter valid quantity and price', 'warning');

  socket.emit('placeMarketOrder', { commodity, orderType, quantity, price }, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      gameState.player = result.player;
      gameState.ship = result.ship;
      updateUI();
      refreshMarket();
    }
  });
}

function cancelOrder(orderId) {
  socket.emit('cancelMarketOrder', orderId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    refreshMarket();
    refreshSector();
  });
}

// ============ SKILLS ============

function loadSkills() {
  socket.emit('getSkills', (skills) => {
    if (!skills) return;
    const categories = {};
    const queueList = [];

    skills.forEach(s => {
      if (!categories[s.category]) categories[s.category] = [];
      categories[s.category].push(s);
      if (s.training_end) queueList.push(s);
    });

    // Queue
    const qDiv = document.getElementById('skill-queue-list');
    if (queueList.length === 0) {
      qDiv.innerHTML = '<p class="info-text">No skills training. Start training below!</p>';
    } else {
      qDiv.innerHTML = '';
      queueList.sort((a, b) => new Date(a.training_end) - new Date(b.training_end));
      queueList.forEach(s => {
        const timeLeft = Math.max(0, new Date(s.training_end) - new Date());
        const div = document.createElement('div');
        div.className = 'queue-item';
        div.innerHTML = `<span>${s.name} → Level ${s.level + 1}</span>
          <span class="time-left">${formatTime(timeLeft)}</span>
          <button onclick="cancelSkillTraining(${s.skill_id})">Cancel</button>`;
        qDiv.appendChild(div);
      });
    }

    // Categories
    const listDiv = document.getElementById('skill-list');
    listDiv.innerHTML = '';
    for (const [cat, catSkills] of Object.entries(categories)) {
      const catDiv = document.createElement('div');
      catDiv.className = 'skill-category';
      catDiv.innerHTML = `<h3>${cat}</h3>`;
      catSkills.forEach(s => {
        const item = document.createElement('div');
        item.className = 'skill-item';
        let pips = '';
        for (let i = 0; i < s.max_level; i++) {
          const cls = i < s.level ? 'filled' : (i === s.level && s.training_end ? 'training' : '');
          pips += `<div class="skill-pip ${cls}"></div>`;
        }
        const canTrain = s.level < s.max_level && !s.training_end;
        item.innerHTML = `<div>
            <div>${s.name}</div>
            <div style="font-size:0.7rem;color:var(--text-dim)">${s.description}</div>
            <div class="skill-level">${pips}</div>
          </div>
          <button ${canTrain ? '' : 'disabled'} onclick="trainSkill(${s.skill_id})">${s.training_end ? 'Training...' : s.level >= s.max_level ? 'Maxed' : 'Train'}</button>`;
        catDiv.appendChild(item);
      });
      listDiv.appendChild(catDiv);
    }

    // Auto-refresh skills timer
    if (skillRefreshTimer) clearInterval(skillRefreshTimer);
    if (queueList.length > 0) {
      skillRefreshTimer = setInterval(() => {
        const activePanel = document.querySelector('.panel.active');
        if (activePanel && activePanel.id === 'panel-skills') loadSkills();
      }, 10000);
    }
  });
}

function trainSkill(skillId) {
  socket.emit('trainSkill', skillId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) loadSkills();
  });
}

function cancelSkillTraining(skillId) {
  socket.emit('cancelTraining', skillId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    loadSkills();
  });
}

// ============ CORPORATION ============

function loadCorp() {
  const player = gameState.player;
  if (player.corp_id) {
    socket.emit('getCorpInfo', player.corp_id, (corp) => {
      if (!corp) return;
      const det = document.getElementById('corp-details');
      det.innerHTML = `<div class="corp-info">
        <h3>[${corp.tag}] ${corp.name}</h3>
        <p>Treasury: ${formatNumber(corp.treasury)} credits</p>
        <p>CEO: ${corp.ceo_name || 'Unknown'}</p>
        <div class="corp-members">
          <h4>Members</h4>
          ${(corp.members || []).map(m => `<div class="member-row"><span>${m.name}</span><span>${m.rank}</span></div>`).join('')}
        </div>
        <div class="corp-actions">
          <button onclick="corpDepositPrompt()">Deposit</button>
          ${corp.ceo_id === player.id ? '<button onclick="corpWithdrawPrompt()">Withdraw</button>' : ''}
          <button onclick="leaveCorp()" style="background:var(--red)">Leave</button>
        </div>
      </div>`;
    });
  } else {
    document.getElementById('corp-details').innerHTML = `
      <p class="info-text">You are not in a corporation.</p>
      <div class="corp-actions">
        <button onclick="showCreateCorp()">Create Corporation</button>
        <button onclick="showJoinCorp()">Join Corporation</button>
      </div>`;
  }
}

function showCreateCorp() {
  document.getElementById('create-corp-form').style.display = 'block';
  document.getElementById('join-corp-form').style.display = 'none';
}

function cancelCreateCorp() { document.getElementById('create-corp-form').style.display = 'none'; }

function showJoinCorp() {
  document.getElementById('join-corp-form').style.display = 'block';
  document.getElementById('create-corp-form').style.display = 'none';
}

function cancelJoinCorp() { document.getElementById('join-corp-form').style.display = 'none'; }

function createCorp() {
  const name = document.getElementById('corp-name').value.trim();
  const tag = document.getElementById('corp-tag').value.trim();
  if (!name || !tag) return log('Enter name and tag', 'warning');
  socket.emit('createCorp', { name, tag }, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      gameState.player = result.player;
      updateUI();
      loadCorp();
      cancelCreateCorp();
    }
  });
}

function joinCorp() {
  const corpId = parseInt(document.getElementById('join-corp-id').value) || 0;
  if (!corpId) return log('Enter corp ID', 'warning');
  socket.emit('joinCorp', corpId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      gameState.player = result.player;
      updateUI();
      loadCorp();
      cancelJoinCorp();
    }
  });
}

function leaveCorp() {
  socket.emit('leaveCorp', (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      gameState.player = result.player;
      updateUI();
      loadCorp();
    }
  });
}

function corpDepositPrompt() {
  showModal('Deposit to Corporation', `
    <p>Your credits: ${formatNumber(gameState.player.credits)}</p>
    <input type="number" id="corp-dep-amt" min="1" placeholder="Amount" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;width:150px;font-family:inherit">
  `, [
    { text: 'Cancel', action: closeModal },
    { text: 'Deposit', primary: true, action: () => {
      const amt = parseInt(document.getElementById('corp-dep-amt').value) || 0;
      closeModal();
      socket.emit('corpDeposit', amt, (result) => {
        log(result.message, result.success ? 'success' : 'warning');
        refreshSector();
        loadCorp();
      });
    }}
  ]);
}

function corpWithdrawPrompt() {
  showModal('Withdraw from Corporation', `
    <input type="number" id="corp-wth-amt" min="1" placeholder="Amount" style="padding:6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:3px;width:150px;font-family:inherit">
  `, [
    { text: 'Cancel', action: closeModal },
    { text: 'Withdraw', primary: true, action: () => {
      const amt = parseInt(document.getElementById('corp-wth-amt').value) || 0;
      closeModal();
      socket.emit('corpWithdraw', amt, (result) => {
        log(result.message, result.success ? 'success' : 'warning');
        refreshSector();
        loadCorp();
      });
    }}
  ]);
}

// ============ MESSAGES ============

function refreshMessages() {
  socket.emit('getMessages', (messages) => {
    const list = document.getElementById('message-list');
    list.innerHTML = '';
    if (!messages || messages.length === 0) {
      list.innerHTML = '<p class="info-text">No messages</p>';
      return;
    }
    messages.forEach(m => {
      const div = document.createElement('div');
      div.className = 'msg-item' + (m.read ? '' : ' unread');
      div.innerHTML = `<div class="msg-subj">${m.subject || '(no subject)'}</div>
        <div class="msg-from">From: ${m.from_name || 'System'} - ${new Date(m.created_at).toLocaleString()}</div>`;
      div.onclick = () => readMsg(m.id);
      list.appendChild(div);
    });
  });
}

function readMsg(msgId) {
  socket.emit('readMessage', msgId, (msg) => {
    if (!msg) return;
    document.getElementById('msg-reader').style.display = 'block';
    document.getElementById('msg-read-subject').textContent = msg.subject || '(no subject)';
    document.getElementById('msg-read-from').textContent = 'From: ' + (msg.from_name || 'System');
    document.getElementById('msg-read-body').textContent = msg.body;
    refreshMessages();
  });
}

function sendMsg() {
  const toName = document.getElementById('msg-to').value.trim();
  const subject = document.getElementById('msg-subject').value.trim();
  const body = document.getElementById('msg-body').value.trim();
  if (!toName || !body) return log('Enter recipient and message', 'warning');

  socket.emit('sendMessage', { toName, subject, body }, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      document.getElementById('msg-to').value = '';
      document.getElementById('msg-subject').value = '';
      document.getElementById('msg-body').value = '';
    }
  });
}

// ============ RANKINGS ============

function loadRankings() {
  socket.emit('getLeaderboard', (leaders) => {
    const tbody = document.getElementById('rankings-body');
    tbody.innerHTML = '';
    if (!leaders || leaders.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="info-text">No rankings yet</td></tr>';
      return;
    }
    leaders.forEach((l, i) => {
      const tr = document.createElement('tr');
      tr.className = i < 3 ? 'rank-' + (i + 1) : '';
      tr.innerHTML = `<td>${i + 1}</td>
        <td>${l.name}</td>
        <td>${getAlignmentTitle(l.alignment)}</td>
        <td>${formatNumber(l.experience)}</td>
        <td>${formatNumber(l.credits)}</td>
        <td>${l.kills}</td>
        <td>${l.corp_tag ? '[' + l.corp_tag + ']' : '-'}</td>`;
      tbody.appendChild(tr);
    });
  });
}

// ============ GALAXY MAP ============

function setupMapCanvas() {
  const canvas = document.getElementById('galaxy-map');
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    mapTransform.scale = Math.max(0.1, Math.min(5, mapTransform.scale * delta));
    renderMap();
  });

  canvas.addEventListener('mousedown', (e) => {
    mapDrag.active = true;
    mapDrag.sx = e.clientX;
    mapDrag.sy = e.clientY;
    mapDrag.tx = mapTransform.x;
    mapDrag.ty = mapTransform.y;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!mapDrag.active) return;
    mapTransform.x = mapDrag.tx + (e.clientX - mapDrag.sx);
    mapTransform.y = mapDrag.ty + (e.clientY - mapDrag.sy);
    renderMap();
  });

  canvas.addEventListener('mouseup', () => { mapDrag.active = false; });
  canvas.addEventListener('mouseleave', () => { mapDrag.active = false; });

  canvas.addEventListener('click', (e) => {
    if (Math.abs(e.clientX - mapDrag.sx) > 5 || Math.abs(e.clientY - mapDrag.sy) > 5) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - mapTransform.x) / mapTransform.scale;
    const my = (e.clientY - rect.top - mapTransform.y) / mapTransform.scale;

    for (const [sid, pos] of Object.entries(sectorPositions)) {
      const dx = mx - pos.x, dy = my - pos.y;
      if (dx * dx + dy * dy < 100) {
        socket.emit('getSectorInfo', parseInt(sid), (sector) => {
          showMapSectorInfo(sector);
        });
        break;
      }
    }
  });
}

function loadMap() {
  socket.emit('getGalaxyMap', (data) => {
    mapData = data;
    computeMapLayout();
    mapCenter();
    renderMap();
  });
}

function computeMapLayout() {
  if (!mapData) return;
  sectorPositions = {};

  const n = mapData.sectors.length;
  const cols = Math.ceil(Math.sqrt(n));
  const spacing = 60;

  // Use force-directed-like placement based on warp connections
  // Simple grid with jitter for initial positions
  mapData.sectors.forEach((s, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    sectorPositions[s.id] = {
      x: col * spacing + (Math.random() - 0.5) * 20,
      y: row * spacing + (Math.random() - 0.5) * 20
    };
  });

  // Simple spring relaxation (few iterations for performance)
  const adjacency = {};
  mapData.warps.forEach(w => {
    if (!adjacency[w.from_sector]) adjacency[w.from_sector] = [];
    adjacency[w.from_sector].push(w.to_sector);
  });

  for (let iter = 0; iter < 30; iter++) {
    const forces = {};
    for (const id in sectorPositions) forces[id] = { x: 0, y: 0 };

    // Repulsion
    const ids = Object.keys(sectorPositions);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = sectorPositions[ids[i]], b = sectorPositions[ids[j]];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < spacing * 2) {
          const force = 200 / (dist * dist);
          forces[ids[i]].x += (dx / dist) * force;
          forces[ids[i]].y += (dy / dist) * force;
          forces[ids[j]].x -= (dx / dist) * force;
          forces[ids[j]].y -= (dy / dist) * force;
        }
      }
    }

    // Attraction along warps
    mapData.warps.forEach(w => {
      const a = sectorPositions[w.from_sector], b = sectorPositions[w.to_sector];
      if (!a || !b) return;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - spacing) * 0.01;
      if (forces[w.from_sector]) {
        forces[w.from_sector].x += (dx / dist) * force;
        forces[w.from_sector].y += (dy / dist) * force;
      }
      if (forces[w.to_sector]) {
        forces[w.to_sector].x -= (dx / dist) * force;
        forces[w.to_sector].y -= (dy / dist) * force;
      }
    });

    // Apply forces
    for (const id in sectorPositions) {
      sectorPositions[id].x += Math.max(-5, Math.min(5, forces[id].x));
      sectorPositions[id].y += Math.max(-5, Math.min(5, forces[id].y));
    }
  }
}

function renderMap() {
  const canvas = document.getElementById('galaxy-map');
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(mapTransform.x, mapTransform.y);
  ctx.scale(mapTransform.scale, mapTransform.scale);

  if (!mapData) { ctx.restore(); return; }

  const showWarps = document.getElementById('map-show-warps').checked;
  const showPorts = document.getElementById('map-show-ports').checked;
  const showPlanets = document.getElementById('map-show-planets').checked;
  const showPlayers = document.getElementById('map-show-players').checked;

  const portSectors = new Set(mapData.ports.map(p => p.sector_id));
  const planetSectors = new Set(mapData.planets.map(p => p.sector_id));

  // Draw warps
  if (showWarps) {
    ctx.strokeStyle = 'rgba(42,58,92,0.4)';
    ctx.lineWidth = 0.5;
    mapData.warps.forEach(w => {
      const a = sectorPositions[w.from_sector], b = sectorPositions[w.to_sector];
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
  }

  // Draw sectors
  mapData.sectors.forEach(s => {
    const pos = sectorPositions[s.id];
    if (!pos) return;

    let color = '#3a4a6c';
    let radius = 3;

    if (s.has_stardock) { color = '#fbbf24'; radius = 6; }
    else if (s.is_nebula) { color = '#7c3aed'; radius = 4; }
    else if (showPorts && portSectors.has(s.id)) { color = '#22c55e'; radius = 4; }
    else if (showPlanets && planetSectors.has(s.id)) { color = '#00d4ff'; radius = 3.5; }

    if (s.id === gameState.player.current_sector) {
      color = '#ffffff';
      radius = 7;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,212,255,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Sector number at zoom
    if (mapTransform.scale > 1.5) {
      ctx.fillStyle = 'rgba(200,214,229,0.7)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(s.id, pos.x, pos.y - radius - 3);
    }
  });

  // Draw players
  if (showPlayers && mapData.playerLocations) {
    mapData.playerLocations.forEach(p => {
      const pos = sectorPositions[p.current_sector];
      if (!pos) return;
      ctx.fillStyle = p.id === gameState.player.id ? '#00d4ff' : '#f97316';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, pos.x, pos.y + 14);
    });
  }

  ctx.restore();
}

function mapZoomIn() { mapTransform.scale = Math.min(5, mapTransform.scale * 1.3); renderMap(); }
function mapZoomOut() { mapTransform.scale = Math.max(0.1, mapTransform.scale * 0.7); renderMap(); }

function mapCenter() {
  const canvas = document.getElementById('galaxy-map');
  const pos = sectorPositions[gameState.player.current_sector];
  if (pos) {
    mapTransform.x = canvas.width / 2 - pos.x * mapTransform.scale;
    mapTransform.y = canvas.height / 2 - pos.y * mapTransform.scale;
  }
  renderMap();
}

function showMapSectorInfo(sector) {
  if (!sector) return;
  let info = `Sector ${sector.id}`;
  if (sector.region_name) info += ` (${sector.region_name})`;
  if (sector.has_stardock) info += ' [StarDock]';
  if (sector.port) info += `\nPort: ${sector.port.name} (Class ${sector.port.class})`;
  if (sector.planets && sector.planets.length) info += `\nPlanets: ${sector.planets.length}`;
  if (sector.warps) info += `\nWarps to: ${sector.warps.join(', ')}`;
  log(info, 'info');
}

// ============ MODAL ============

function showModal(title, bodyHtml, actions) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  const actDiv = document.getElementById('modal-actions');
  actDiv.innerHTML = '';
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.textContent = a.text;
    if (a.primary) btn.className = 'primary';
    btn.onclick = a.action;
    actDiv.appendChild(btn);
  });
  document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
}

// ============ LOGGING ============

function log(message, type = 'info') {
  const logDiv = document.getElementById('log-content');
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="timestamp">[${time}]</span> ${escapeHtml(message)}`;
  logDiv.appendChild(entry);
  logDiv.parentElement.scrollTop = logDiv.parentElement.scrollHeight;

  // Keep log manageable
  while (logDiv.children.length > 200) logDiv.removeChild(logDiv.firstChild);
}

// ============ UTILITIES ============

function getAlignmentTitle(a) {
  if (a >= 500) return 'Federation Admiral';
  if (a >= 200) return 'Federation Captain';
  if (a >= 100) return 'Lawful Trader';
  if (a >= 0) return 'Neutral';
  if (a >= -100) return 'Smuggler';
  if (a >= -200) return 'Pirate';
  return 'Dread Pirate';
}

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

function formatTime(ms) {
  if (ms <= 0) return 'Complete!';
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============ SHIP UPGRADES ============

function loadUpgradesPanel() {
  const ship = gameState.ship;
  if (ship) {
    document.getElementById('rename-ship-input').value = ship.name || '';
  }

  // Load installed upgrades
  socket.emit('getShipUpgrades', (upgrades) => {
    const list = document.getElementById('installed-list');
    if (!upgrades || upgrades.length === 0) {
      list.innerHTML = '<p class="info-text">No upgrades installed. Visit a StarDock to customize your ship.</p>';
    } else {
      list.innerHTML = '';
      upgrades.forEach(u => {
        const div = document.createElement('div');
        div.className = 'upgrade-installed-item';
        div.innerHTML = `
          <div class="upgrade-info">
            <span class="upgrade-name">${u.name}</span>
            <span class="upgrade-cat">${u.category}</span>
            ${u.stacks > 1 ? `<span class="upgrade-stacks">x${u.stacks}</span>` : ''}
          </div>
          <div class="upgrade-desc">${u.description}</div>
          <button onclick="removeUpgradeItem(${u.upgrade_type_id})" class="upgrade-remove-btn">Remove (40% refund)</button>`;
        list.appendChild(div);
      });
    }
  });

  // Load available upgrades (only useful at StarDock)
  socket.emit('getUpgradeTypes', (types) => {
    const catalog = document.getElementById('upgrade-catalog');
    catalog.innerHTML = '';
    const atStarDock = gameState.sector && gameState.sector.has_stardock;
    const categories = {};
    types.forEach(t => {
      if (!categories[t.category]) categories[t.category] = [];
      categories[t.category].push(t);
    });

    const categoryNames = {
      engines: 'Engines', weapons: 'Weapons', shields: 'Shields',
      scanners: 'Scanners', cargo: 'Cargo', special: 'Special'
    };

    for (const [cat, catUpgrades] of Object.entries(categories)) {
      const section = document.createElement('div');
      section.className = 'upgrade-category';
      section.innerHTML = `<h4>${categoryNames[cat] || cat}</h4>`;

      catUpgrades.forEach(u => {
        const canBuy = atStarDock && gameState.player.credits >= u.base_cost;
        const card = document.createElement('div');
        card.className = 'upgrade-card';
        card.innerHTML = `
          <div class="upgrade-card-header">
            <span class="upgrade-name">${u.name}</span>
            <span class="upgrade-cost">${formatNumber(u.base_cost)} cr</span>
          </div>
          <div class="upgrade-desc">${u.description}</div>
          <div class="upgrade-reqs">
            ${u.equipment_cost > 0 ? `<span>Equipment: ${u.equipment_cost}</span>` : ''}
            <span>Max: ${u.max_stacks}x</span>
          </div>
          <button ${canBuy ? '' : 'disabled'} onclick="installUpgradeItem(${u.id})">
            ${!atStarDock ? 'Need StarDock' : canBuy ? 'Install' : 'Insufficient Funds'}
          </button>`;
        section.appendChild(card);
      });
      catalog.appendChild(section);
    }
  });
}

function doRenameShip() {
  const name = document.getElementById('rename-ship-input').value.trim();
  if (!name) return log('Enter a ship name', 'warning');
  socket.emit('renameShip', name, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      gameState.ship = result.ship;
      updateUI();
    }
  });
}

function installUpgradeItem(upgradeTypeId) {
  socket.emit('installUpgrade', upgradeTypeId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      gameState.player = result.player;
      gameState.ship = result.ship;
      updateUI();
      loadUpgradesPanel();
    }
  });
}

function removeUpgradeItem(upgradeTypeId) {
  showModal('Remove Upgrade', 'Are you sure? You will receive 40% of the cost as a refund.', [
    { text: 'Cancel', action: closeModal },
    { text: 'Remove', primary: true, action: () => {
      closeModal();
      socket.emit('removeUpgrade', upgradeTypeId, (result) => {
        log(result.message, result.success ? 'success' : 'warning');
        if (result.success) {
          gameState.player = result.player;
          gameState.ship = result.ship;
          updateUI();
          loadUpgradesPanel();
        }
      });
    }}
  ]);
}

// ============ CAPTAIN'S QUARTERS ============

let activeCompanionId = null;

function loadQuartersPanel() {
  socket.emit('getQuartersStatus', (status) => {
    if (!status) return;

    document.getElementById('quarters-desc').textContent =
      `Your private retreat aboard the ${status.shipType} "${status.shipName}". A viewport shows the stars drifting by.`;

    // Show current companions
    const list = document.getElementById('companion-list');
    const interactionPanel = document.getElementById('companion-interaction');
    interactionPanel.style.display = 'none';

    if (status.companions.length === 0) {
      list.innerHTML = '<p class="info-text">Your quarters are empty. Hire a companion to keep you company among the stars.</p>';
    } else {
      list.innerHTML = '';
      status.companions.forEach(c => {
        const moodLabel = c.mood >= 70 ? 'Happy' : c.mood >= 40 ? 'Content' : 'Melancholy';
        const moodColor = c.mood >= 70 ? 'var(--green)' : c.mood >= 40 ? 'var(--yellow)' : 'var(--red)';
        const affinityLabel = c.affinity >= 80 ? 'Devoted' : c.affinity >= 60 ? 'Friendly' : c.affinity >= 40 ? 'Neutral' : 'Distant';
        const affinityColor = c.affinity >= 80 ? 'var(--accent)' : c.affinity >= 60 ? 'var(--green)' : c.affinity >= 40 ? 'var(--yellow)' : 'var(--text-dim)';
        const genderIcon = c.gender === 'female' ? '♀' : '♂';

        const div = document.createElement('div');
        div.className = 'companion-card';
        div.innerHTML = `
          <div class="companion-header">
            <span class="companion-name">${c.name} <span class="companion-gender">${genderIcon}</span></span>
            <span class="companion-race">${c.race}</span>
          </div>
          <div class="companion-personality">${c.personality}</div>
          <div class="companion-meters">
            <div class="meter-row">
              <span class="meter-label">Mood:</span>
              <div class="meter-bar"><div class="meter-fill" style="width:${c.mood}%;background:${moodColor}"></div></div>
              <span class="meter-text" style="color:${moodColor}">${moodLabel}</span>
            </div>
            <div class="meter-row">
              <span class="meter-label">Bond:</span>
              <div class="meter-bar"><div class="meter-fill" style="width:${c.affinity}%;background:${affinityColor}"></div></div>
              <span class="meter-text" style="color:${affinityColor}">${affinityLabel}</span>
            </div>
          </div>
          <div class="companion-actions">
            <button onclick="openCompanionInteraction(${c.companion_type_id})">Visit</button>
            <button onclick="dismissCompanionPrompt(${c.companion_type_id}, '${escapeHtml(c.name)}')" class="dismiss-btn">Dismiss</button>
          </div>`;
        list.appendChild(div);
      });
    }

    // Load hire catalog
    loadHireCatalog(status.companions.map(c => c.companion_type_id));
  });
}

function loadHireCatalog(hiredIds) {
  socket.emit('getCompanionTypes', (types) => {
    const catalog = document.getElementById('hire-catalog');
    catalog.innerHTML = '';
    const available = types.filter(t => !hiredIds.includes(t.id));

    if (available.length === 0) {
      catalog.innerHTML = '<p class="info-text">All companions have been hired!</p>';
      return;
    }

    available.forEach(t => {
      const genderIcon = t.gender === 'female' ? '♀' : '♂';
      const canHire = gameState.player.credits >= t.hire_cost;
      const card = document.createElement('div');
      card.className = 'hire-card';
      card.innerHTML = `
        <div class="hire-header">
          <span class="hire-name">${t.name} <span class="companion-gender">${genderIcon}</span></span>
          <span class="hire-race">${t.race}</span>
        </div>
        <div class="hire-desc">${t.description}</div>
        <div class="hire-cost">${formatNumber(t.hire_cost)} credits</div>
        <button ${canHire ? '' : 'disabled'} onclick="doHireCompanion(${t.id})">
          ${canHire ? 'Hire' : 'Insufficient Credits'}
        </button>`;
      catalog.appendChild(card);
    });
  });
}

function doHireCompanion(companionTypeId) {
  socket.emit('hireCompanion', companionTypeId, (result) => {
    log(result.message, result.success ? 'success' : 'warning');
    if (result.success) {
      gameState.player = result.player;
      updateUI();
      loadQuartersPanel();
    }
  });
}

function dismissCompanionPrompt(companionTypeId, name) {
  showModal('Dismiss Companion', `Are you sure you want to dismiss ${name}? This cannot be undone.`, [
    { text: 'Cancel', action: closeModal },
    { text: 'Dismiss', primary: true, action: () => {
      closeModal();
      socket.emit('dismissCompanion', companionTypeId, (result) => {
        log(result.message, result.success ? 'success' : 'warning');
        if (result.success) loadQuartersPanel();
      });
    }}
  ]);
}

function openCompanionInteraction(companionTypeId) {
  activeCompanionId = companionTypeId;
  document.getElementById('quarters-companions').style.display = 'none';
  document.getElementById('hire-section').style.display = 'none';
  const panel = document.getElementById('companion-interaction');
  panel.style.display = 'block';

  // Get companion info from current status
  socket.emit('getQuartersStatus', (status) => {
    const comp = status.companions.find(c => c.companion_type_id === companionTypeId);
    if (!comp) return;

    const genderIcon = comp.gender === 'female' ? '♀' : '♂';
    const moodLabel = comp.mood >= 70 ? 'Happy' : comp.mood >= 40 ? 'Content' : 'Melancholy';
    const moodColor = comp.mood >= 70 ? 'var(--green)' : comp.mood >= 40 ? 'var(--yellow)' : 'var(--red)';
    const affinityLabel = comp.affinity >= 80 ? 'Devoted' : comp.affinity >= 60 ? 'Friendly' : comp.affinity >= 40 ? 'Neutral' : 'Distant';
    const affinityColor = comp.affinity >= 80 ? 'var(--accent)' : comp.affinity >= 60 ? 'var(--green)' : comp.affinity >= 40 ? 'var(--yellow)' : 'var(--text-dim)';

    document.getElementById('interaction-header').innerHTML = `
      <div class="interact-portrait">
        <div class="portrait-name">${comp.name} ${genderIcon}</div>
        <div class="portrait-race">${comp.race} - ${comp.personality}</div>
        <div class="portrait-desc">${comp.description}</div>
        <div class="companion-meters" style="margin-top:8px">
          <div class="meter-row">
            <span class="meter-label">Mood:</span>
            <div class="meter-bar"><div class="meter-fill" style="width:${comp.mood}%;background:${moodColor}"></div></div>
            <span class="meter-text" style="color:${moodColor}">${moodLabel}</span>
          </div>
          <div class="meter-row">
            <span class="meter-label">Bond:</span>
            <div class="meter-bar"><div class="meter-fill" style="width:${comp.affinity}%;background:${affinityColor}"></div></div>
            <span class="meter-text" style="color:${affinityColor}">${affinityLabel}</span>
          </div>
        </div>
      </div>`;

    document.getElementById('interaction-content').innerHTML = '<p class="info-text">Choose an interaction...</p>';

    const actions = document.getElementById('interaction-actions');
    actions.innerHTML = '';
    const interactions = [
      { id: 'talk', label: 'Have a Conversation', icon: '💬' },
      { id: 'drink', label: 'Share a Drink', icon: '🥂' },
      { id: 'homeworld', label: 'Ask About Homeworld', icon: '🌍' },
      { id: 'game', label: 'Play a Game', icon: '🎲' },
      { id: 'stargaze', label: 'Stargaze Together', icon: '✨' },
    ];

    interactions.forEach(i => {
      const btn = document.createElement('button');
      btn.className = 'interact-btn';
      btn.innerHTML = `<span class="interact-icon">${i.icon}</span> ${i.label}`;
      btn.onclick = () => doCompanionInteraction(companionTypeId, i.id);
      actions.appendChild(btn);
    });
  });
}

function doCompanionInteraction(companionTypeId, action) {
  socket.emit('interactCompanion', { companionTypeId, action }, (result) => {
    if (result.success) {
      const content = document.getElementById('interaction-content');
      const changeText = [];
      if (result.affinityChange > 0) changeText.push(`<span style="color:var(--green)">Bond +${result.affinityChange}</span>`);
      if (result.moodChange > 0) changeText.push(`<span style="color:var(--green)">Mood +${result.moodChange}</span>`);
      if (result.affinityChange < 0) changeText.push(`<span style="color:var(--red)">Bond ${result.affinityChange}</span>`);
      if (result.moodChange < 0) changeText.push(`<span style="color:var(--red)">Mood ${result.moodChange}</span>`);

      content.innerHTML = `
        <div class="interaction-dialogue">
          <p>${result.message}</p>
          <div class="interaction-changes">${changeText.join(' ')}</div>
        </div>`;

      // Refresh the meters
      openCompanionInteraction(companionTypeId);
    } else {
      log(result.message, 'warning');
    }
  });
}

function closeInteraction() {
  activeCompanionId = null;
  document.getElementById('companion-interaction').style.display = 'none';
  document.getElementById('quarters-companions').style.display = 'block';
  document.getElementById('hire-section').style.display = 'block';
  loadQuartersPanel();
}

// ============ INIT ============

// Auto-login if token exists
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('itw_token');
  if (saved) {
    token = saved;
    connectSocket();
  }

  // Handle Enter key on auth forms
  document.getElementById('login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('reg-playername').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doRegister();
  });
});
