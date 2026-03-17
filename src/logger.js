const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SECURITY: 4 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] || LOG_LEVELS.INFO;

function getTimestamp() {
  return new Date().toISOString();
}

function formatLogEntry(level, category, message, meta = {}) {
  return JSON.stringify({
    timestamp: getTimestamp(),
    level,
    category,
    message,
    ...meta
  });
}

function getLogFilePath(category) {
  const date = new Date().toISOString().slice(0, 10);
  if (category === 'security' || category === 'access') {
    return path.join(LOG_DIR, `security-${date}.log`);
  }
  return path.join(LOG_DIR, `app-${date}.log`);
}

function writeLog(level, category, message, meta = {}) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;

  const entry = formatLogEntry(level, category, message, meta);
  const filePath = getLogFilePath(category);

  // Write to file asynchronously (non-blocking)
  fs.appendFile(filePath, entry + '\n', (err) => {
    if (err) console.error('Failed to write log:', err.message);
  });

  // Also output to console with appropriate method
  const consoleLine = `[${getTimestamp()}] [${level}] [${category}] ${message}`;
  if (level === 'ERROR' || level === 'SECURITY') {
    console.error(consoleLine);
  } else if (level === 'WARN') {
    console.warn(consoleLine);
  } else {
    console.log(consoleLine);
  }
}

// Persist security events to the database for audit trail
function writeSecurityLog(db, event, details = {}) {
  try {
    db.prepare(`
      INSERT INTO security_log (event_type, user_id, player_id, ip_address, details, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      event,
      details.userId || null,
      details.playerId || null,
      details.ip || null,
      JSON.stringify(details)
    );
  } catch (err) {
    console.error('Failed to write security log to DB:', err.message);
  }
}

const logger = {
  // General application logging
  debug(category, message, meta) {
    writeLog('DEBUG', category, message, meta);
  },
  info(category, message, meta) {
    writeLog('INFO', category, message, meta);
  },
  warn(category, message, meta) {
    writeLog('WARN', category, message, meta);
  },
  error(category, message, meta) {
    writeLog('ERROR', category, message, meta);
  },

  // Security-specific logging (always writes to security log file + DB)
  security(db, event, message, details = {}) {
    writeLog('SECURITY', 'security', message, { event, ...details });
    writeSecurityLog(db, event, details);
  },

  // Access logging for HTTP requests
  access(method, url, statusCode, ip, userId, duration) {
    writeLog('INFO', 'access', `${method} ${url} ${statusCode}`, {
      method, url, statusCode, ip, userId, durationMs: duration
    });
  }
};

module.exports = logger;
