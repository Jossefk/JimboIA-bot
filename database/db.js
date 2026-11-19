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
const stmtUpdateMemory = db.prepare(`
	UPDATE memories
	SET category = ?, content = ?, importance = ?, created_at = datetime('now')
	WHERE id = ?
`);
const stmtDeleteMemory = db.prepare(`
	DELETE FROM memories WHERE id = ?
`);
const stmtDeleteUserMemory = db.prepare(`
	DELETE FROM memories WHERE id = ? AND user_id = ?
`);
const stmtUpdatePersonalityNotes = db.prepare(`
	UPDATE users
	SET personality_notes = ?, updated_at = datetime('now')
	WHERE user_id = ?
`);
const stmtGetUserMemories = db.prepare(`
	SELECT id, user_id, guild_id, category, content, importance, created_at
	FROM memories
	WHERE user_id = ?
	ORDER BY importance DESC, id DESC
	LIMIT ?
`);
const stmtGetServerMemories = db.prepare(`
	SELECT m.id, m.user_id, m.guild_id, m.category, m.content, m.importance, m.created_at,
		u.username, u.display_name
	FROM memories m
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE m.guild_id = ?
	ORDER BY m.importance DESC, m.id DESC
	LIMIT ?
`);
const stmtPruneUserMemories = db.prepare(`
	DELETE FROM memories
	WHERE id IN (
		SELECT id FROM memories
		WHERE user_id = ?
		ORDER BY importance DESC, id DESC
		LIMIT -1 OFFSET ?
	)
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

const MAX_MEMORIES_PER_USER = 30;

const STOPWORDS_ES = new Set([
	'de', 'la', 'que', 'el', 'en', 'y', 'a', 'los', 'del', 'se', 'las', 'por', 'un', 'para',
	'con', 'no', 'una', 'su', 'al', 'lo', 'como', 'mas', 'más', 'pero', 'sus', 'le', 'ya',
	'o', 'este', 'si', 'sí', 'porque', 'esta', 'está', 'entre', 'cuando', 'muy', 'sin',
	'sobre', 'tambien', 'también', 'me', 'hasta', 'hay', 'donde', 'dónde', 'quien', 'quién',
	'desde', 'todo', 'nos', 'durante', 'todos', 'uno', 'les', 'ni', 'contra', 'otros',
	'ese', 'eso', 'ante', 'ellos', 'esto', 'mi', 'mis', 'tu', 'tus', 'antes', 'algunos',
	'unos', 'yo', 'otro', 'otras', 'otra', 'tanto', 'esa', 'estos', 'mucho', 'quienes',
	'nada', 'muchos', 'cual', 'cuál', 'poco', 'ella', 'estar', 'estas', 'algunas', 'algo',
	'nosotros', 'hola', 'jimbo', 'jimbot', 'chamo', 'pana', 'epa', 'que', 'qué', 'como',
	'cómo', 'eres', 'soy', 'fue', 'son', 'era', 'ser', 'tiene', 'tengo', 'hacer', 'hace',
	'and', 'or', 'not', 'near',
]);

function normalizeText(str = '') {
	return str
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\w\sñ]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractSignificantWords(str = '') {
	return normalizeText(str)
		.split(' ')
		.filter(w => w.length >= 3 && !STOPWORDS_ES.has(w));
}

/**
 * Actualiza las notas de personalidad/perfil resumido de un usuario
 */
function updatePersonalityNotes(userId, notes) {
	if (!userId || typeof notes !== 'string') return;
	stmtUpdatePersonalityNotes.run(notes.trim().slice(0, 250), userId);
}

/**
 * Guarda una nueva memoria o actualiza una existente si es muy similar (evita duplicados)
 */
function addMemory(userId, guildId, category, content, importance = 2) {
	if (!content || typeof content !== 'string') return null;
	const cleanContent = content.trim();
	if (!cleanContent) return null;
	const cleanCategory = (category || 'general').trim().toLowerCase();
	const clampedImportance = Math.min(5, Math.max(1, Number(importance) || 2));

	if (userId) {
		const existingMemories = stmtGetUserMemories.all(userId, 50);
		const newNorm = normalizeText(cleanContent);
		const newWords = extractSignificantWords(cleanContent);

		for (const mem of existingMemories) {
			const oldNorm = normalizeText(mem.content);
			if (oldNorm === newNorm) {
				const mergedImportance = Math.max(mem.importance, clampedImportance);
				stmtUpdateMemory.run(cleanCategory, cleanContent, mergedImportance, mem.id);
				return mem.id;
			}

			if (newWords.length >= 2) {
				const oldWords = new Set(extractSignificantWords(mem.content));
				if (oldWords.size >= 2) {
					const overlap = newWords.filter(w => oldWords.has(w)).length;
					const minLen = Math.min(newWords.length, oldWords.size);
					const similarity = overlap / minLen;
					const threshold = mem.category === cleanCategory ? 0.65 : 0.8;
					if (similarity >= threshold) {
						const mergedImportance = Math.max(mem.importance, clampedImportance);
						stmtUpdateMemory.run(cleanCategory, cleanContent, mergedImportance, mem.id);
						return mem.id;
					}
				}
			}
		}
	}

	const result = stmtAddMemory.run(userId || null, guildId || null, cleanCategory, cleanContent, clampedImportance);

	if (userId) {
		stmtPruneUserMemories.run(userId, MAX_MEMORIES_PER_USER);
	}

	return Number(result.lastInsertRowid);
}

/**
 * Actualiza un recuerdo existente por su ID
 */
function updateMemory(memoryId, { category, content, importance }) {
	if (!memoryId || !content) return false;
	const clampedImportance = Math.min(5, Math.max(1, Number(importance) || 2));
	const res = stmtUpdateMemory.run((category || 'general').trim().toLowerCase(), content.trim(), clampedImportance, memoryId);
	return res.changes > 0;
}

/**
 * Elimina un recuerdo por su ID (opcionalmente validando que pertenezca al userId)
 */
function deleteMemory(memoryId, userId = null) {
	if (!memoryId) return false;
	const res = userId
		? stmtDeleteUserMemory.run(memoryId, userId)
		: stmtDeleteMemory.run(memoryId);
	return res.changes > 0;
}

/**
 * Obtiene las memorias asociadas a un usuario específico
 */
function getUserMemories(userId, limit = 6) {
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
	SELECT m.id, m.user_id, m.guild_id, m.category, m.content, m.importance, m.created_at,
		u.username, u.display_name
	FROM memories_fts fts
	JOIN memories m ON m.id = fts.rowid
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE memories_fts MATCH ?
	ORDER BY rank, m.importance DESC
	LIMIT ?
`);
const stmtSearchMemoriesScoped = db.prepare(`
	SELECT m.id, m.user_id, m.guild_id, m.category, m.content, m.importance, m.created_at,
		u.username, u.display_name
	FROM memories_fts fts
	JOIN memories m ON m.id = fts.rowid
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE memories_fts MATCH ?
		AND (m.user_id = ? OR m.guild_id = ? OR m.guild_id IS NULL)
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
 * Busca recuerdos en el índice FTS5 por palabras clave relevantes usando OR y prefijos
 */
function searchMemories(query, limit = 5, options = {}) {
	try {
		if (!query || typeof query !== 'string') return [];
		const rawTokens = query
			.replace(/[^\w\sñáéíóúü]/gi, ' ')
			.split(/\s+/)
			.map(t => t.trim())
			.filter(t => t.length >= 3 && !STOPWORDS_ES.has(t.toLowerCase()));

		if (rawTokens.length === 0) return [];

		// Construir expresión FTS5 con OR para encontrar cualquier recuerdo que coincida con palabras clave de la frase
		const uniqueTokens = [...new Set(rawTokens)].slice(0, 8);
		const ftsQuery = uniqueTokens.map(t => `"${t}"*`).join(' OR ');

		if (options.userId || options.guildId) {
			return stmtSearchMemoriesScoped.all(ftsQuery, options.userId || '', options.guildId || '', limit);
		}
		return stmtSearchMemories.all(ftsQuery, limit);
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
	updateMemory,
	deleteMemory,
	updatePersonalityNotes,
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
