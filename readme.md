# Intergalactic Trade Wars

A modern web-based reimagining of the classic TradeWars 2002, blending nostalgic space trading gameplay with EVE Online-inspired features. Navigate a procedurally generated galaxy, trade commodities, wage war, colonize planets, and build corporate empires — all from your browser.

## Game Summary

Intergalactic Trade Wars is a multiplayer space trading and combat game. Players pilot ships through a sector-based galaxy, buying and selling commodities at ports, engaging in player-vs-player combat, claiming planets, training skills, and forming corporations. A turn-based action system keeps gameplay strategic, while real-time WebSocket communication brings the universe to life.

## Features

### Trading & Economy
- **Port Trading** — Buy and sell ore, organics, and equipment at ports with dynamic pricing across multiple port classes.
- **Player Market** — EVE Online-style order book with automatic bid/ask matching for player-to-player trading.

### Ships & Upgrades
- **15 Ship Types** — From the starter Merchant Cruiser to the mighty Imperial StarShip and pirate-exclusive Havoc GunStar.
- **Modular Upgrades** — Install engines, weapons, shields, cargo expanders, scanners, cloaking devices, and more.

### Combat
- **PvP Combat** — Attack other players with fighters and mines; combat odds factor in ship type, equipment, and skills.
- **Mine Warfare** — Deploy mines in sectors to defend territory or ambush rivals.
- **NPC Encounters** — Face Federation patrols, Ferrengi pirates, and alien traders as you explore.

### Exploration & Navigation
- **Procedurally Generated Galaxy** — 500 sectors (configurable) connected by warp lanes.
- **Interactive Galaxy Map** — HTML5 Canvas visualization showing sectors, ports, planets, wormholes, and online players.
- **Wormholes** — Temporary unstable passages between distant sectors that decay over time.

### Planets & Colonization
- **7 Planet Classes** — Earth, Oceanic, Mountainous, Volcanic, Glacial, Desert, and Gaseous, each with unique production rates.
- **Citadels** — Build fortified bases with military and production modules on your planets.

### Progression
- **14 Skills** — Train Trade Efficiency, Combat Tactics, Navigation, Wormhole Theory, Colonial Admin, and more.
- **Alignment System** — Ranges from -999 (pirate) to +999 (lawful), unlocking different ships and NPC interactions.
- **Leaderboard** — Rankings by kills, credits, experience, and alignment.

### Social
- **Corporations** — Create or join player-run corps with shared treasuries and member management.
- **Captain's Quarters** — Recruit and interact with 10 unique companion characters, each with their own personality and affinity system.
- **Messaging** — In-game communication between players.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js, Express |
| Real-time | Socket.IO |
| Database | SQLite (better-sqlite3) |
| Auth | JWT, bcryptjs |
| Frontend | Vanilla JS, HTML5 Canvas, CSS3 |

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)

### Steps

```bash
# Clone the repository
git clone https://github.com/faustus1005/IntergalacticTradeWars.git
cd IntergalacticTradeWars

# Install dependencies
npm install

# Start the server
npm start
```

The server launches at **http://localhost:3000** by default. The database and universe are automatically created on first run.

### Development Mode

```bash
npm run dev
```

Starts the server with `--watch` for automatic restarts on file changes.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `UNIVERSE_SIZE` | `500` | Number of sectors to generate |
| `JWT_SECRET` | *(built-in default)* | Token signing key — **change this in production** |

You can set these in a `.env` file or pass them directly:

```bash
PORT=8080 UNIVERSE_SIZE=1000 npm start
```

## Connecting to the Game

1. Open your browser and navigate to **http://localhost:3000** (or your configured host/port).
2. **Register** a new account with a username and password.
3. **Log in** to enter the galaxy and start trading.

Sessions persist via JWT tokens stored in your browser, so you can close and reopen without losing progress.

## License

See [LICENSE](LICENSE) for details.
