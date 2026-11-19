const assert = require('assert');
const { executeToolCall, jimboFunctionDeclarations } = require('../services/toolsService.js');
const db = require('../database/db.js');

describe('Tools Service Tests', () => {
	const testUserId = 'test_tool_user_777';
	const testChannelId = 'test_channel_888';
	const testGuildId = 'test_guild_999';

	after(() => {
		db.db.exec(`DELETE FROM reminders WHERE user_id = '${testUserId}';`);
		db.db.exec(`DELETE FROM memories WHERE user_id = '${testUserId}';`);
		db.db.exec(`DELETE FROM users WHERE user_id = '${testUserId}';`);
	});

	it('should declare tools properly', () => {
		assert.strictEqual(jimboFunctionDeclarations.length, 4);
		const names = jimboFunctionDeclarations.map(t => t.name);
		assert.ok(names.includes('set_reminder'));
		assert.ok(names.includes('get_dolar_rate'));
		assert.ok(names.includes('search_memory'));
		assert.ok(names.includes('save_memory'));
	});

	it('should execute save_memory tool and deduplicate similar memories', async () => {
		db.getOrCreateUser(testUserId, 'tooluser', 'Tool User');
		const res1 = await executeToolCall({
			name: 'save_memory',
			args: {
				category: 'trabajo',
				content: 'Trabaja como programador backend en Node.js',
				importance: 4,
			},
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });

		assert.strictEqual(res1.status, 'success');
		assert.ok(res1.memory_id > 0);

		// Guardar un recuerdo muy similar debe actualizar el existente en vez de duplicarlo
		const res2 = await executeToolCall({
			name: 'save_memory',
			args: {
				category: 'trabajo',
				content: 'Trabaja como programador backend en Node.js y Docker',
				importance: 5,
			},
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });

		assert.strictEqual(res2.memory_id, res1.memory_id);
		const memories = db.getUserMemories(testUserId, 10);
		assert.strictEqual(memories.length, 1);
		assert.strictEqual(memories[0].importance, 5);
	});

	it('should execute set_reminder tool correctly', async () => {
		db.getOrCreateUser(testUserId, 'tooluser', 'Tool User');
		const result = await executeToolCall({
			name: 'set_reminder',
			args: {
				reminder_text: 'Apagar la arepera',
				minutes_from_now: 15,
				send_dm: false,
			},
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });

		assert.strictEqual(result.status, 'success');
		assert.strictEqual(result.reminder_text, 'Apagar la arepera');
		assert.ok(result.reminder_id > 0);
	});

	it('should execute get_dolar_rate tool with conversions', async () => {
		const result = await executeToolCall({
			name: 'get_dolar_rate',
			args: {
				amount_usd: 10,
			},
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });

		assert.ok(result.tasa_bcv !== undefined);
		assert.ok(result.conversion_usd_a_ves !== undefined);
		assert.strictEqual(result.conversion_usd_a_ves.monto_usd, 10);
	});
});
