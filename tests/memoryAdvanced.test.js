const assert = require('assert');
const db = require('../database/db.js');
const { formatRelativeTimeEs } = require('../services/geminiService.js');

describe('Advanced Memory (Hybrid, Episodes, Privacy, Relative Time) Tests', () => {
	const testUserId = 'test_adv_mem_user_1';
	const testGuildId = 'test_adv_guild_1';
	const testChannelId = 'test_adv_ep_chan_1';

	after(() => {
		db.db.exec(`DELETE FROM channel_episodes WHERE channel_id = '${testChannelId}';`);
		db.db.exec(`DELETE FROM memories WHERE user_id = '${testUserId}';`);
		db.db.exec(`DELETE FROM users WHERE user_id = '${testUserId}';`);
	});

	it('should encode, decode, and compute cosine similarity accurately', () => {
		const vecA = [1, 0, 0, 0];
		const vecB = [0.9, 0.1, 0, 0];
		const vecC = [0, 1, 0, 0];

		const blob = db.encodeEmbedding(vecA);
		assert.ok(Buffer.isBuffer(blob));

		const decoded = db.decodeEmbedding(blob);
		assert.strictEqual(decoded.length, 4);
		assert.ok(Math.abs(decoded[0] - 1) < 1e-6);

		const simAB = db.cosineSimilarity(decoded, new Float32Array(vecB));
		const simAC = db.cosineSimilarity(decoded, new Float32Array(vecC));
		assert.ok(simAB > 0.98);
		assert.strictEqual(simAC, 0);
	});

	it('should retrieve semantic matches via hybrid search even when FTS5 keywords do not match, and increment access_count', () => {
		db.getOrCreateUser(testUserId, 'advuser', 'Adv User', testGuildId);

		const id1 = db.addMemory(testUserId, testGuildId, 'trabajo', 'Está creando una ticketera llamada TikeFaz', 4, {
			channelId: 'pub_1',
			isPrivate: false,
			confidence: 'high',
			embedding: [0.95, 0.05, 0, 0],
		});
		db.addMemory(testUserId, testGuildId, 'juego', 'Le gusta jugar Hollow Knight en PC', 3, {
			channelId: 'pub_1',
			isPrivate: false,
			confidence: 'high',
			embedding: [0, 0.99, 0.05, 0],
		});

		const results = db.searchMemoriesHybrid('emprendimiento boletos eventos', [1, 0, 0, 0], 3, {
			userId: testUserId,
			guildId: testGuildId,
			channelId: 'pub_2',
			includePrivate: false,
		});

		assert.ok(results.length >= 1);
		assert.strictEqual(results[0].id, id1);

		const updatedRow = db.db.prepare('SELECT access_count FROM memories WHERE id = ?').get(id1);
		assert.ok(updatedRow.access_count >= 1);
	});

	it('should isolate private DM/channel memories from other public channels', () => {
		const privId = db.addMemory(testUserId, testGuildId, 'vida', 'Secreto contado solo por DM privado', 5, {
			channelId: 'dm_priv_1',
			isPrivate: true,
			confidence: 'high',
			embedding: [0, 0, 1, 0],
		});

		const publicList = db.getUserMemories(testUserId, 10, {
			channelId: 'pub_other',
			includePrivate: false,
		});
		assert.ok(!publicList.some(m => m.id === privId), 'Private memory must not appear in another public channel');

		const sameChannelList = db.getUserMemories(testUserId, 10, {
			channelId: 'dm_priv_1',
			includePrivate: false,
		});
		assert.ok(sameChannelList.some(m => m.id === privId), 'Private memory should appear in its own DM/channel');

		const hybridPublic = db.searchMemoriesHybrid('secreto privado', [0, 0, 1, 0], 5, {
			userId: testUserId,
			guildId: testGuildId,
			channelId: 'pub_other',
			includePrivate: false,
		});
		assert.ok(!hybridPublic.some(m => m.id === privId), 'Hybrid search must not leak private memory');

		const hybridAllowed = db.searchMemoriesHybrid('secreto privado', [0, 0, 1, 0], 5, {
			userId: testUserId,
			guildId: testGuildId,
			channelId: 'pub_other',
			includePrivate: true,
		});
		assert.ok(hybridAllowed.some(m => m.id === privId));
	});

	it('should store and retrieve recent channel episodes in chronological order', () => {
		db.addChannelEpisode(testGuildId, testChannelId, 'Hablaron de organizar torneo de Balatro', 'Koonts, Cruzel', 35);
		db.addChannelEpisode(testGuildId, testChannelId, 'Debatieron sobre precios de GPUs usadas', 'Koonts, Giancarlo', 35);

		const episodes = db.getRecentChannelEpisodes(testChannelId, 3);
		assert.strictEqual(episodes.length, 2);
		assert.ok(episodes[0].summary.includes('Balatro'));
		assert.ok(episodes[1].summary.includes('GPUs'));
	});

	it('should format relative dates in Spanish cleanly', () => {
		const now = new Date();
		const toSqlite = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

		assert.strictEqual(formatRelativeTimeEs(toSqlite(new Date(now.getTime() - 10 * 60_000))), 'hace un rato');
		assert.strictEqual(formatRelativeTimeEs(toSqlite(new Date(now.getTime() - 5 * 3_600_000))), 'hace 5 h');
		assert.strictEqual(formatRelativeTimeEs(toSqlite(new Date(now.getTime() - 30 * 3_600_000))), 'ayer');
		assert.strictEqual(formatRelativeTimeEs(toSqlite(new Date(now.getTime() - 4 * 86_400_000))), 'hace 4 días');
	});
});
