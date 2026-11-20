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

CREATE TABLE IF NOT EXISTS channel_episodes (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT,
	channel_id TEXT NOT NULL,
	summary TEXT NOT NULL,
	participants TEXT DEFAULT '',
	message_count INTEGER DEFAULT 0,
	created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channel_episodes_channel
ON channel_episodes(channel_id, id DESC);

CREATE TABLE IF NOT EXISTS user_inventory (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	item_key TEXT NOT NULL,
	item_name TEXT NOT NULL,
	item_effect TEXT DEFAULT '',
	quantity INTEGER DEFAULT 1,
	acquired_at TEXT DEFAULT (datetime('now')),
	FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_inventory_unique
ON user_inventory(user_id, item_key);

CREATE TABLE IF NOT EXISTS daily_contracts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	guild_id TEXT,
	contract_text TEXT NOT NULL,
	reward_chips INTEGER DEFAULT 100,
	status TEXT DEFAULT 'active',
	created_at TEXT DEFAULT (datetime('now')),
	completed_at TEXT DEFAULT NULL,
	FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_contracts_user
ON daily_contracts(user_id, status, id DESC);

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

// Migración idempotente de columnas de perfil en users
const userColumns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userColumns.includes('real_name')) {
	db.exec('ALTER TABLE users ADD COLUMN real_name TEXT DEFAULT \'\';');
}
if (!userColumns.includes('aliases')) {
	db.exec('ALTER TABLE users ADD COLUMN aliases TEXT DEFAULT \'\';');
}
if (!userColumns.includes('last_guild_id')) {
	db.exec('ALTER TABLE users ADD COLUMN last_guild_id TEXT DEFAULT NULL;');
}
if (!userColumns.includes('last_seen_at')) {
	db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT NULL;');
}

// Migración idempotente de columnas avanzadas en memories
const memoryColumns = db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
if (!memoryColumns.includes('embedding')) {
	db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB DEFAULT NULL;');
}
if (!memoryColumns.includes('channel_id')) {
	db.exec('ALTER TABLE memories ADD COLUMN channel_id TEXT DEFAULT NULL;');
}
if (!memoryColumns.includes('is_private')) {
	db.exec('ALTER TABLE memories ADD COLUMN is_private INTEGER DEFAULT 0;');
}
if (!memoryColumns.includes('confidence')) {
	db.exec('ALTER TABLE memories ADD COLUMN confidence TEXT DEFAULT \'medium\';');
}
if (!memoryColumns.includes('access_count')) {
	db.exec('ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0;');
}
if (!memoryColumns.includes('last_accessed_at')) {
	db.exec('ALTER TABLE memories ADD COLUMN last_accessed_at TEXT DEFAULT NULL;');
}

// Prepared statements reutilizables
const stmtGetUser = db.prepare('SELECT * FROM users WHERE user_id = ?');
const stmtUpsertInventoryItem = db.prepare(`
	INSERT INTO user_inventory (user_id, item_key, item_name, item_effect, quantity)
	VALUES (?, ?, ?, ?, ?)
	ON CONFLICT(user_id, item_key) DO UPDATE SET
		quantity = quantity + excluded.quantity,
		item_name = excluded.item_name,
		item_effect = excluded.item_effect,
		acquired_at = datetime('now')
`);
const stmtGetInventoryItem = db.prepare(`
	SELECT * FROM user_inventory
	WHERE user_id = ? AND item_key = ?
`);
const stmtGetUserInventory = db.prepare(`
	SELECT item_key, item_name, item_effect, quantity, acquired_at
	FROM user_inventory
	WHERE user_id = ? AND quantity > 0
	ORDER BY acquired_at DESC
	LIMIT ?
`);
const stmtDecrementInventoryItem = db.prepare(`
	UPDATE user_inventory
	SET quantity = quantity - 1
	WHERE user_id = ? AND item_key = ?
`);
const stmtDeleteInventoryItem = db.prepare(`
	DELETE FROM user_inventory
	WHERE user_id = ? AND item_key = ?
`);
const stmtGetActiveContract = db.prepare(`
	SELECT * FROM daily_contracts
	WHERE user_id = ? AND status = 'active'
	ORDER BY id DESC
	LIMIT 1
`);
const stmtGetTodayCompletedContract = db.prepare(`
	SELECT id FROM daily_contracts
	WHERE user_id = ? AND status = 'completed' AND date(completed_at) = date('now')
	LIMIT 1
`);
const stmtCreateDailyContract = db.prepare(`
	INSERT INTO daily_contracts (user_id, guild_id, contract_text, reward_chips, status)
	VALUES (?, ?, ?, ?, 'active')
`);
const stmtCompleteDailyContract = db.prepare(`
	UPDATE daily_contracts
	SET status = 'completed', completed_at = datetime('now')
	WHERE id = ?
`);
const stmtInsertUser = db.prepare(`
	INSERT INTO users (user_id, username, display_name, chips, affinity, last_guild_id, last_seen_at)
	VALUES (?, ?, ?, 1000, 0, ?, datetime('now'))
`);
const stmtUpdateUserInfo = db.prepare(`
	UPDATE users
	SET username = ?,
		display_name = ?,
		last_guild_id = COALESCE(?, last_guild_id),
		last_seen_at = datetime('now'),
		updated_at = datetime('now')
	WHERE user_id = ?
`);
const stmtTouchUser = db.prepare(`
	UPDATE users
	SET last_guild_id = COALESCE(?, last_guild_id),
		last_seen_at = datetime('now')
	WHERE user_id = ?
`);
const stmtUpdateUserProfile = db.prepare(`
	UPDATE users
	SET real_name = ?,
		aliases = ?,
		personality_notes = ?,
		updated_at = datetime('now')
	WHERE user_id = ?
`);
const stmtDeleteAllUserMemories = db.prepare(`
	DELETE FROM memories WHERE user_id = ?
`);
const stmtGetKnownUsersAll = db.prepare(`
	SELECT u.*, COALESCE(mc.cnt, 0) AS memory_count
	FROM users u
	LEFT JOIN (SELECT user_id, COUNT(*) AS cnt FROM memories GROUP BY user_id) mc
		ON mc.user_id = u.user_id
	ORDER BY COALESCE(u.last_seen_at, u.updated_at) DESC, u.updated_at DESC
	LIMIT ?
`);
const stmtGetKnownUsersByGuild = db.prepare(`
	SELECT u.*, COALESCE(mc.cnt, 0) AS memory_count
	FROM users u
	LEFT JOIN (SELECT user_id, COUNT(*) AS cnt FROM memories GROUP BY user_id) mc
		ON mc.user_id = u.user_id
	WHERE u.last_guild_id = ? OR u.last_guild_id IS NULL
	ORDER BY COALESCE(u.last_seen_at, u.updated_at) DESC, u.updated_at DESC
	LIMIT ?
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
	INSERT INTO memories (user_id, guild_id, category, content, importance, channel_id, is_private, confidence)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateMemory = db.prepare(`
	UPDATE memories
	SET category = ?, content = ?, importance = ?, created_at = datetime('now')
	WHERE id = ?
`);
const stmtUpdateMemoryDedupe = db.prepare(`
	UPDATE memories
	SET category = ?, content = ?, importance = ?, is_private = ?, confidence = ?, created_at = datetime('now')
	WHERE id = ?
`);
const stmtSetMemoryEmbedding = db.prepare(`
	UPDATE memories
	SET embedding = ?
	WHERE id = ?
`);
const stmtTouchMemory = db.prepare(`
	UPDATE memories
	SET access_count = COALESCE(access_count, 0) + 1,
		last_accessed_at = datetime('now')
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
const stmtGetUserMemoriesAll = db.prepare(`
	SELECT id, user_id, guild_id, channel_id, is_private, confidence, access_count, category, content, importance, created_at
	FROM memories
	WHERE user_id = ?
	ORDER BY importance DESC, id DESC
	LIMIT ?
`);
const stmtGetUserMemoriesPublic = db.prepare(`
	SELECT id, user_id, guild_id, channel_id, is_private, confidence, access_count, category, content, importance, created_at
	FROM memories
	WHERE user_id = ?
		AND (COALESCE(is_private, 0) = 0 OR (channel_id IS NOT NULL AND channel_id = ?))
	ORDER BY importance DESC, id DESC
	LIMIT ?
`);
const stmtGetEmbeddingCandidatesAll = db.prepare(`
	SELECT m.id, m.user_id, m.guild_id, m.channel_id, m.is_private, m.confidence, m.access_count,
		m.category, m.content, m.importance, m.created_at, m.embedding, u.username, u.display_name
	FROM memories m
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE m.embedding IS NOT NULL
	ORDER BY m.id DESC
	LIMIT 300
`);
const stmtGetEmbeddingCandidatesScoped = db.prepare(`
	SELECT m.id, m.user_id, m.guild_id, m.channel_id, m.is_private, m.confidence, m.access_count,
		m.category, m.content, m.importance, m.created_at, m.embedding, u.username, u.display_name
	FROM memories m
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE m.embedding IS NOT NULL
		AND (m.user_id = ? OR m.guild_id = ? OR m.guild_id IS NULL)
	ORDER BY m.id DESC
	LIMIT 300
`);
const stmtAddChannelEpisode = db.prepare(`
	INSERT INTO channel_episodes (guild_id, channel_id, summary, participants, message_count)
	VALUES (?, ?, ?, ?, ?)
`);
const stmtPruneChannelEpisodes = db.prepare(`
	DELETE FROM channel_episodes
	WHERE id IN (
		SELECT id FROM channel_episodes
		WHERE channel_id = ?
		ORDER BY id DESC
		LIMIT -1 OFFSET 30
	)
`);
const stmtGetRecentChannelEpisodes = db.prepare(`
	SELECT id, guild_id, channel_id, summary, participants, message_count, created_at
	FROM channel_episodes
	WHERE channel_id = ?
	ORDER BY id DESC
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
function getOrCreateUser(userId, username, displayName, guildId = null) {
	const effectiveDisplay = displayName || username;
	let user = stmtGetUser.get(userId);
	if (!user) {
		stmtInsertUser.run(userId, username, effectiveDisplay, guildId || null);
		user = stmtGetUser.get(userId);
	}
	else if (user.username !== username || user.display_name !== effectiveDisplay || (guildId && user.last_guild_id !== guildId)) {
		stmtUpdateUserInfo.run(username, effectiveDisplay, guildId || null, userId);
		user = stmtGetUser.get(userId);
	}
	else {
		stmtTouchUser.run(guildId || null, userId);
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

function encodeEmbedding(values) {
	if (!values || typeof values.length !== 'number' || values.length === 0) return null;
	const floatArr = values instanceof Float32Array ? values : new Float32Array(values);
	return Buffer.from(floatArr.buffer, floatArr.byteOffset, floatArr.byteLength);
}

function decodeEmbedding(blob) {
	if (!blob) return null;
	const bytes = new Uint8Array(blob);
	if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
	return new Float32Array(bytes.buffer);
}

function cosineSimilarity(vecA, vecB) {
	if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < vecA.length; i++) {
		const a = vecA[i];
		const b = vecB[i];
		dot += a * b;
		normA += a * a;
		normB += b * b;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

function computeRecencyScore(sqliteDateStr) {
	if (!sqliteDateStr || typeof sqliteDateStr !== 'string') return 0.5;
	const iso = sqliteDateStr.includes('T')
		? sqliteDateStr
		: `${sqliteDateStr.replace(' ', 'T')}Z`;
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return 0.5;
	const ageDays = Math.max(0, (Date.now() - ms) / 86_400_000);
	return Math.exp(-0.015 * ageDays);
}

/**
 * Guarda el vector embedding de un recuerdo existente
 */
function setMemoryEmbedding(memoryId, values) {
	if (!memoryId) return false;
	const encoded = encodeEmbedding(values);
	if (!encoded) return false;
	const res = stmtSetMemoryEmbedding.run(encoded, memoryId);
	return res.changes > 0;
}

/**
 * Incrementa el contador de acceso de los recuerdos consultados
 */
function touchMemories(memoryIds = []) {
	if (!Array.isArray(memoryIds) || memoryIds.length === 0) return;
	for (const id of memoryIds) {
		if (id) stmtTouchMemory.run(id);
	}
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
function addMemory(userId, guildId, category, content, importance = 2, options = {}) {
	if (!content || typeof content !== 'string') return null;
	const cleanContent = content.trim();
	if (!cleanContent) return null;
	const cleanCategory = (category || 'general').trim().toLowerCase();
	const clampedImportance = Math.min(5, Math.max(1, Number(importance) || 2));
	const {
		channelId = null,
		isPrivate = false,
		confidence = 'medium',
		embedding = null,
	} = options || {};
	const privateFlag = isPrivate ? 1 : 0;
	const cleanConfidence = confidence || 'medium';

	if (userId) {
		const existingMemories = stmtGetUserMemoriesAll.all(userId, 50);
		const newNorm = normalizeText(cleanContent);
		const newWords = extractSignificantWords(cleanContent);

		for (const mem of existingMemories) {
			const oldNorm = normalizeText(mem.content);
			let isMatch = oldNorm === newNorm;

			if (!isMatch && newWords.length >= 2) {
				const oldWords = new Set(extractSignificantWords(mem.content));
				if (oldWords.size >= 2) {
					const overlap = newWords.filter(w => oldWords.has(w)).length;
					const minLen = Math.min(newWords.length, oldWords.size);
					const similarity = overlap / minLen;
					const threshold = mem.category === cleanCategory ? 0.65 : 0.8;
					if (similarity >= threshold) {
						isMatch = true;
					}
				}
			}

			if (isMatch) {
				const mergedImportance = Math.max(mem.importance, clampedImportance);
				const mergedPrivate = (mem.is_private || privateFlag) ? 1 : 0;
				stmtUpdateMemoryDedupe.run(
					cleanCategory,
					cleanContent,
					mergedImportance,
					mergedPrivate,
					cleanConfidence,
					mem.id,
				);
				if (embedding) {
					setMemoryEmbedding(mem.id, embedding);
				}
				return mem.id;
			}
		}
	}

	const result = stmtAddMemory.run(
		userId || null,
		guildId || null,
		cleanCategory,
		cleanContent,
		clampedImportance,
		channelId || null,
		privateFlag,
		cleanConfidence,
	);
	const insertedId = Number(result.lastInsertRowid);

	if (embedding && insertedId) {
		setMemoryEmbedding(insertedId, embedding);
	}

	if (userId) {
		stmtPruneUserMemories.run(userId, MAX_MEMORIES_PER_USER);
	}

	return insertedId;
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
 * Obtiene las memorias asociadas a un usuario específico respetando privacidad de canal/DM
 */
function getUserMemories(userId, limit = 6, options = {}) {
	const { channelId = null, includePrivate = false } = options || {};
	if (includePrivate) {
		return stmtGetUserMemoriesAll.all(userId, limit);
	}
	return stmtGetUserMemoriesPublic.all(userId, channelId || '', limit);
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
	SELECT m.id, m.user_id, m.guild_id, m.channel_id, m.is_private, m.confidence, m.access_count,
		m.category, m.content, m.importance, m.created_at, u.username, u.display_name
	FROM memories_fts fts
	JOIN memories m ON m.id = fts.rowid
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE memories_fts MATCH ?
	ORDER BY rank, m.importance DESC
	LIMIT ?
`);
const stmtSearchMemoriesPublic = db.prepare(`
	SELECT m.id, m.user_id, m.guild_id, m.channel_id, m.is_private, m.confidence, m.access_count,
		m.category, m.content, m.importance, m.created_at, u.username, u.display_name
	FROM memories_fts fts
	JOIN memories m ON m.id = fts.rowid
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE memories_fts MATCH ?
		AND (COALESCE(m.is_private, 0) = 0 OR (m.channel_id IS NOT NULL AND m.channel_id = ?))
	ORDER BY rank, m.importance DESC
	LIMIT ?
`);
const stmtSearchMemoriesScoped = db.prepare(`
	SELECT m.id, m.user_id, m.guild_id, m.channel_id, m.is_private, m.confidence, m.access_count,
		m.category, m.content, m.importance, m.created_at, u.username, u.display_name
	FROM memories_fts fts
	JOIN memories m ON m.id = fts.rowid
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE memories_fts MATCH ?
		AND (m.user_id = ? OR m.guild_id = ? OR m.guild_id IS NULL)
	ORDER BY rank, m.importance DESC
	LIMIT ?
`);
const stmtSearchMemoriesScopedPublic = db.prepare(`
	SELECT m.id, m.user_id, m.guild_id, m.channel_id, m.is_private, m.confidence, m.access_count,
		m.category, m.content, m.importance, m.created_at, u.username, u.display_name
	FROM memories_fts fts
	JOIN memories m ON m.id = fts.rowid
	LEFT JOIN users u ON u.user_id = m.user_id
	WHERE memories_fts MATCH ?
		AND (m.user_id = ? OR m.guild_id = ? OR m.guild_id IS NULL)
		AND (COALESCE(m.is_private, 0) = 0 OR (m.channel_id IS NOT NULL AND m.channel_id = ?))
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
		const includePrivate = Boolean(options.includePrivate);
		const channelId = options.channelId || '';

		if (options.userId || options.guildId) {
			if (includePrivate) {
				return stmtSearchMemoriesScoped.all(ftsQuery, options.userId || '', options.guildId || '', limit);
			}
			return stmtSearchMemoriesScopedPublic.all(ftsQuery, options.userId || '', options.guildId || '', channelId, limit);
		}
		if (includePrivate) {
			return stmtSearchMemories.all(ftsQuery, limit);
		}
		return stmtSearchMemoriesPublic.all(ftsQuery, channelId, limit);
	}
	catch {
		return [];
	}
}

/**
 * Búsqueda híbrida (FTS5 + similitud coseno con embeddings) combinada con RRF, importancia y frescura
 */
function searchMemoriesHybrid(query, queryEmbedding = null, limit = 5, options = {}) {
	const ftsResults = searchMemories(query, limit * 3, options);
	const includePrivate = Boolean(options.includePrivate);
	const channelId = options.channelId || '';

	const queryVec = queryEmbedding ? new Float32Array(queryEmbedding) : null;
	let vecResults = [];

	if (queryVec && queryVec.length > 0) {
		const rawCandidates = (options.userId || options.guildId)
			? stmtGetEmbeddingCandidatesScoped.all(options.userId || '', options.guildId || '')
			: stmtGetEmbeddingCandidatesAll.all();

		const scored = [];
		for (const row of rawCandidates) {
			if (!includePrivate && row.is_private && row.channel_id !== channelId) {
				continue;
			}
			const vec = decodeEmbedding(row.embedding);
			const sim = cosineSimilarity(queryVec, vec);
			if (sim >= 0.42) {
				const cleanRow = { ...row };
				delete cleanRow.embedding;
				scored.push({ row: cleanRow, sim });
			}
		}

		scored.sort((a, b) => b.sim - a.sim);
		vecResults = scored.slice(0, limit * 3).map(s => s.row);
	}

	const merged = new Map();
	const addRanked = (list) => {
		for (let i = 0; i < list.length; i++) {
			const item = list[i];
			const rrf = 1 / (60 + i + 1);
			const existing = merged.get(item.id);
			if (existing) {
				existing.rrf += rrf;
			}
			else {
				merged.set(item.id, { item, rrf });
			}
		}
	};

	addRanked(ftsResults);
	addRanked(vecResults);

	const ranked = Array.from(merged.values())
		.map(({ item, rrf }) => {
			const score = rrf + ((item.importance || 1) * 0.001) + (computeRecencyScore(item.created_at) * 0.004);
			return { item, score };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(entry => entry.item);

	if (ranked.length > 0) {
		touchMemories(ranked.map(m => m.id));
	}

	return ranked;
}

/**
 * Registra un episodio resumido de conversación de canal y mantiene máximo 30 por canal
 */
function addChannelEpisode(guildId, channelId, summary, participants = '', messageCount = 0) {
	if (!channelId || !summary || typeof summary !== 'string') return null;
	const res = stmtAddChannelEpisode.run(
		guildId || null,
		channelId,
		summary.trim().slice(0, 260),
		(participants || '').trim().slice(0, 200),
		Number(messageCount) || 0,
	);
	stmtPruneChannelEpisodes.run(channelId);
	return Number(res.lastInsertRowid);
}

/**
 * Obtiene los episodios recientes del canal en orden cronológico
 */
function getRecentChannelEpisodes(channelId, limit = 3) {
	if (!channelId) return [];
	return stmtGetRecentChannelEpisodes.all(channelId, limit).reverse();
}

/**
 * Actualiza los campos de perfil de un usuario (nombre real, apodos, notas)
 */
function updateUserProfile(userId, { realName, aliases, personalityNotes } = {}) {
	if (!userId) return null;
	const current = stmtGetUser.get(userId);
	if (!current) return null;

	const nextRealName = (realName !== undefined && realName !== null)
		? String(realName).trim().slice(0, 80)
		: (current.real_name || '');
	const nextAliases = (aliases !== undefined && aliases !== null)
		? String(aliases).trim().slice(0, 150)
		: (current.aliases || '');
	const nextNotes = (personalityNotes !== undefined && personalityNotes !== null)
		? String(personalityNotes).trim().slice(0, 250)
		: (current.personality_notes || '');

	stmtUpdateUserProfile.run(nextRealName, nextAliases, nextNotes, userId);
	return stmtGetUser.get(userId);
}

/**
 * Obtiene la lista de usuarios conocidos en el servidor (o globalmente) con conteo de recuerdos
 */
function getKnownUsers(guildId = null, limit = 30) {
	if (guildId) {
		return stmtGetKnownUsersByGuild.all(guildId, limit);
	}
	return stmtGetKnownUsersAll.all(limit);
}

/**
 * Busca un usuario por mención, ID, nick, nombre real o apodos
 */
function findUserByName(query, guildId = null) {
	if (!query || typeof query !== 'string') return null;
	const trimmed = query.trim();
	if (!trimmed) return null;

	const mentionMatch = trimmed.match(/^<@!?(\d+)>$/) || trimmed.match(/^(\d{15,25})$/);
	if (mentionMatch) {
		return stmtGetUser.get(mentionMatch[1]) || null;
	}

	const normQuery = normalizeText(trimmed.replace(/^@+/, ''));
	if (!normQuery) return null;

	const users = getKnownUsers(guildId, 100);
	let partialMatch = null;

	for (const u of users) {
		const candidates = [
			u.display_name,
			u.username,
			u.real_name,
			...(u.aliases ? u.aliases.split(',') : []),
		]
			.map(v => normalizeText(v || ''))
			.filter(Boolean);

		if (candidates.some(c => c === normQuery)) {
			return u;
		}
		if (!partialMatch && candidates.some(c => c.includes(normQuery) || normQuery.includes(c))) {
			partialMatch = u;
		}
	}

	return partialMatch;
}

/**
 * Elimina todos los recuerdos de un usuario y retorna el total eliminado
 */
function deleteAllUserMemories(userId) {
	if (!userId) return 0;
	const res = stmtDeleteAllUserMemories.run(userId);
	return Number(res.changes);
}

/**
 * Añade un ítem de la tienda del Limbo a la mochila del usuario
 */
function addInventoryItem(userId, itemKey, itemName, itemEffect = '', qty = 1) {
	if (!userId || !itemKey || !itemName) return null;
	const cleanQty = Math.max(1, Number(qty) || 1);
	stmtUpsertInventoryItem.run(userId, itemKey, itemName, itemEffect || '', cleanQty);
	return stmtGetInventoryItem.get(userId, itemKey) || null;
}

/**
 * Obtiene los ítems activos en la mochila de un usuario
 */
function getUserInventory(userId, limit = 15) {
	if (!userId) return [];
	return stmtGetUserInventory.all(userId, limit);
}

/**
 * Consume una unidad de un ítem de la mochila del usuario
 */
function consumeInventoryItem(userId, itemKey) {
	if (!userId || !itemKey) return null;
	const item = stmtGetInventoryItem.get(userId, itemKey);
	if (!item || item.quantity <= 0) return null;

	if (item.quantity <= 1) {
		stmtDeleteInventoryItem.run(userId, itemKey);
	}
	else {
		stmtDecrementInventoryItem.run(userId, itemKey);
	}

	return {
		...item,
		remaining: Math.max(0, item.quantity - 1),
	};
}

/**
 * Obtiene el contrato diario activo de un usuario
 */
function getActiveContract(userId) {
	if (!userId) return null;
	return stmtGetActiveContract.get(userId) || null;
}

/**
 * Crea un contrato diario en el Limbo si el usuario no tiene uno activo ni completado hoy
 */
function createDailyContract(userId, guildId, contractText, rewardChips = 100) {
	if (!userId) return { status: 'error' };
	const active = getActiveContract(userId);
	if (active) {
		return { status: 'already_active', contract: active };
	}

	const completedToday = stmtGetTodayCompletedContract.get(userId);
	if (completedToday) {
		return { status: 'cooldown' };
	}

	const reward = Math.min(200, Math.max(40, Math.round(Number(rewardChips) || 100)));
	const res = stmtCreateDailyContract.run(userId, guildId || null, String(contractText || '').trim().slice(0, 220), reward);
	const contract = db.prepare('SELECT * FROM daily_contracts WHERE id = ?').get(Number(res.lastInsertRowid));
	return { status: 'created', contract };
}

/**
 * Marca como completado el contrato activo del usuario y entrega fichas
 */
function completeDailyContract(userId) {
	if (!userId) return { status: 'no_active_contract' };
	const active = getActiveContract(userId);
	if (!active) {
		return { status: 'no_active_contract' };
	}

	stmtCompleteDailyContract.run(active.id);
	const newBalance = addChips(userId, active.reward_chips);
	adjustAffinity(userId, 1);

	return {
		status: 'completed',
		contract: active,
		reward: active.reward_chips,
		newBalance,
	};
}

module.exports = {
	db,
	getOrCreateUser,
	updateUserProfile,
	getKnownUsers,
	findUserByName,
	addChips,
	setChips,
	adjustAffinity,
	recordGameResult,
	addMemory,
	updateMemory,
	deleteMemory,
	deleteAllUserMemories,
	setMemoryEmbedding,
	touchMemories,
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
	searchMemoriesHybrid,
	addChannelEpisode,
	getRecentChannelEpisodes,
	encodeEmbedding,
	decodeEmbedding,
	cosineSimilarity,
	addInventoryItem,
	getUserInventory,
	consumeInventoryItem,
	getActiveContract,
	createDailyContract,
	completeDailyContract,
};
