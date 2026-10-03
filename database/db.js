const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Asegurar directorio data/
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'jimbo.sqlite');
const db = new DatabaseSync(dbPath);

// Configurar WAL para lecturas y escrituras eficientes
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Inicializar tablas
db.exec(`
CREATE TABLE IF NOT EXISTS users (
	user_id TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	display_name TEXT,
	chips INTEGER DEFAULT 1000,
	affinity INTEGER DEFAULT 0,
	personality_notes TEXT DEFAULT '',
	total_games_played INTEGER DEFAULT 0,
	total_games_won INTEGER DEFAULT 0,
	created_at TEXT DEFAULT (datetime('now')),
	updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT,
	guild_id TEXT,
	category TEXT DEFAULT 'general',
	content TEXT NOT NULL,
	importance INTEGER DEFAULT 1,
	created_at TEXT DEFAULT (datetime('now')),
	FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
	guild_id TEXT PRIMARY KEY,
	chime_in_rate REAL DEFAULT 0.03,
	allowed_channels TEXT DEFAULT '[]',
	personality_override TEXT DEFAULT NULL,
	updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	guild_id TEXT,
	reminder_text TEXT NOT NULL,
	trigger_at TEXT NOT NULL,
	send_dm INTEGER DEFAULT 0,
	status TEXT DEFAULT 'pending',
	created_at TEXT DEFAULT (datetime('now')),
	FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminders_pending 
ON reminders(status, trigger_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
	content,
	category,
	content='memories',
	content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
	INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES('delete', old.id, old.content, old.category);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES('delete', old.id, old.content, old.category);
	INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;
`);

// Sincronizar FTS5 si ya existían memorias previas
try {
	db.exec(`
		INSERT OR IGNORE INTO memories_fts(rowid, content, category)
		SELECT id, content, category FROM memories
		WHERE id NOT IN (SELECT rowid FROM memories_fts);
	`);
}
catch {
	// Ignorar si ya está sincronizado
}

// Prepared statements reutilizables
const stmtGetUser = db.prepare('SELECT * FROM users WHERE user_id = ?');
const stmtInsertUser = db.prepare(`
	INSERT INTO users (user_id, username, display_name, chips, affinity)
	VALUES (?, ?, ?, 1000, 0)
`);
const stmtUpdateUserInfo = db.prepare(`
	UPDATE users
	SET username = ?, display_name = ?, updated_at = datetime('now')
	WHERE user_id = ?
`);
const stmtAddChips = db.prepare(`
	UPDATE users
	SET chips = MAX(0, chips + ?), updated_at = datetime('now')
	WHERE user_id = ?
`);
const stmtSetChips = db.prepare(`
	UPDATE users
	SET chips = MAX(0, ?), updated_at = datetime('now')
	WHERE user_id = ?
`);
const stmtAdjustAffinity = db.prepare(`
	UPDATE users
	SET affinity = MIN(100, MAX(-100, affinity + ?)), updated_at = datetime('now')
	WHERE user_id = ?
`);
const stmtRecordGame = db.prepare(`
	UPDATE users
	SET total_games_played = total_games_played + 1,
		total_games_won = total_games_won + ?,
		chips = MAX(0, chips + ?),
		updated_at = datetime('now')
	WHERE user_id = ?
`);
const stmtAddMemory = db.prepare(`
	INSERT INTO memories (user_id, guild_id, category, content, importance)
	VALUES (?, ?, ?, ?, ?)
`);
const stmtGetUserMemories = db.prepare(`
	SELECT id, category, content, importance, created_at
	FROM memories
	WHERE user_id = ?
	ORDER BY importance DESC, id DESC
	LIMIT ?
`);
const stmtGetServerMemories = db.prepare(`
	SELECT id, user_id, category, content, importance, created_at
	FROM memories
	WHERE guild_id = ?
	ORDER BY id DESC
	LIMIT ?
`);
const stmtGetLeaderboard = db.prepare(`
	SELECT user_id, username, display_name, chips, total_games_won, total_games_played
	FROM users
	ORDER BY chips DESC
	LIMIT ?
`);
const stmtGetServerSettings = db.prepare('SELECT * FROM server_settings WHERE guild_id = ?');
const stmtUpsertServerSettings = db.prepare(`
	INSERT INTO server_settings (guild_id, chime_in_rate, allowed_channels, updated_at)
	VALUES (?, ?, ?, datetime('now'))
	ON CONFLICT(guild_id) DO UPDATE SET
		chime_in_rate = excluded.chime_in_rate,
		allowed_channels = excluded.allowed_channels,
		updated_at = datetime('now')
`);

/**
 * Obtiene o crea un usuario en la base de datos
 */
function getOrCreateUser(userId, username, displayName) {
	let user = stmtGetUser.get(userId);
	if (!user) {
		stmtInsertUser.run(userId, username, displayName || username);
		user = stmtGetUser.get(userId);
	}
	else if (user.username !== username || user.display_name !== displayName) {
		stmtUpdateUserInfo.run(username, displayName || username, userId);
		user.username = username;
		user.display_name = displayName;
	}
	return user;
}

/**
 * Añade (o resta) fichas a un usuario
 */
function addChips(userId, amount) {
	stmtAddChips.run(amount, userId);
	return stmtGetUser.get(userId)?.chips ?? 0;
}

/**
 * Establece el saldo de fichas
 */
function setChips(userId, chips) {
	stmtSetChips.run(chips, userId);
	return stmtGetUser.get(userId)?.chips ?? 0;
}

/**
 * Ajusta la afinidad de Jimbo con el usuario (-100 a +100)
 */
function adjustAffinity(userId, delta) {
	stmtAdjustAffinity.run(delta, userId);
	return stmtGetUser.get(userId)?.affinity ?? 0;
}

/**
 * Registra una partida de juego (ej. Blackjack)
 */
function recordGameResult(userId, won, chipsDelta) {
	stmtRecordGame.run(won ? 1 : 0, chipsDelta, userId);
	return stmtGetUser.get(userId);
}

/**
 * Guarda una nueva memoria o aprendizaje
 */
function addMemory(userId, guildId, category, content, importance = 1) {
	stmtAddMemory.run(userId || null, guildId || null, category, content, importance);
}

/**
 * Obtiene las memorias asociadas a un usuario específico
 */
function getUserMemories(userId, limit = 5) {
	return stmtGetUserMemories.all(userId, limit);
}

/**
 * Obtiene las memorias y anécdotas de un servidor
 */
function getServerMemories(guildId, limit = 5) {
	return stmtGetServerMemories.all(guildId, limit);
}

/**
 * Obtiene el top de usuarios con más fichas (tabla de clasificación)
 */
function getLeaderboard(limit = 10) {
	return stmtGetLeaderboard.all(limit);
}

/**
 * Obtiene la configuración de un servidor
 */
function getServerSettings(guildId) {
	const settings = stmtGetServerSettings.get(guildId);
	if (!settings) {
		return {
			guild_id: guildId,
			chime_in_rate: 0.03,
			allowed_channels: [],
		};
	}
	let allowedChannels = [];
	try {
		allowedChannels = JSON.parse(settings.allowed_channels || '[]');
	}
	catch {
		allowedChannels = [];
	}
	return {
		guild_id: settings.guild_id,
		chime_in_rate: settings.chime_in_rate,
		allowed_channels: allowedChannels,
	};
}

/**
 * Actualiza la configuración de un servidor
 */
function updateServerSettings(guildId, { chime_in_rate, allowed_channels }) {
	const current = getServerSettings(guildId);
	const newRate = chime_in_rate !== undefined ? chime_in_rate : current.chime_in_rate;
	const newChannels = allowed_channels !== undefined ? JSON.stringify(allowed_channels) : JSON.stringify(current.allowed_channels);
	stmtUpsertServerSettings.run(guildId, newRate, newChannels);
}

const stmtAddReminder = db.prepare(`
	INSERT INTO reminders (user_id, channel_id, guild_id, reminder_text, trigger_at, send_dm, status)
	VALUES (?, ?, ?, ?, ?, ?, 'pending')
`);
const stmtGetDueReminders = db.prepare(`
	SELECT id, user_id, channel_id, guild_id, reminder_text, trigger_at, send_dm
	FROM reminders
	WHERE status = 'pending' AND trigger_at <= ?
	ORDER BY trigger_at ASC
`);
const stmtMarkReminderCompleted = db.prepare(`
	UPDATE reminders
	SET status = 'completed'
	WHERE id = ?
`);
const stmtGetUserPendingReminders = db.prepare(`
	SELECT id, reminder_text, trigger_at, send_dm
	FROM reminders
	WHERE user_id = ? AND status = 'pending'
	ORDER BY trigger_at ASC
	LIMIT ?
`);
const stmtSearchMemories = db.prepare(`
	SELECT m.id, m.user_id, m.guild_id, m.category, m.content, m.importance, m.created_at
	FROM memories_fts fts
	JOIN memories m ON m.id = fts.rowid
	WHERE memories_fts MATCH ?
	ORDER BY rank, m.importance DESC
	LIMIT ?
`);

/**
 * Añade un recordatorio a la base de datos
 */
function addReminder(userId, channelId, guildId, reminderText, triggerAt, sendDm = 0) {
	const result = stmtAddReminder.run(userId, channelId, guildId || null, reminderText, triggerAt, sendDm ? 1 : 0);
	return Number(result.lastInsertRowid);
}

/**
 * Obtiene los recordatorios pendientes que ya deben ser disparados
 */
function getDueReminders(nowIso = new Date().toISOString()) {
	return stmtGetDueReminders.all(nowIso);
}

/**
 * Marca un recordatorio como completado
 */
function markReminderCompleted(id) {
	stmtMarkReminderCompleted.run(id);
}

/**
 * Obtiene los recordatorios pendientes de un usuario
 */
function getUserPendingReminders(userId, limit = 5) {
	return stmtGetUserPendingReminders.all(userId, limit);
}

/**
 * Busca recuerdos en el índice FTS5 por palabras clave
 */
function searchMemories(query, limit = 5) {
	try {
		const sanitized = query.replace(/[^\w\sñáéíóú]/gi, ' ').trim();
		if (!sanitized) return [];
		return stmtSearchMemories.all(sanitized, limit);
	}
	catch {
		return [];
	}
}

module.exports = {
	db,
	getOrCreateUser,
	addChips,
	setChips,
	adjustAffinity,
	recordGameResult,
	addMemory,
	getUserMemories,
	getServerMemories,
	getLeaderboard,
	getServerSettings,
	updateServerSettings,
	addReminder,
	getDueReminders,
	markReminderCompleted,
	getUserPendingReminders,
	searchMemories,
};
