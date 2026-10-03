const assert = require('assert');
const { executeToolCall, jimboFunctionDeclarations } = require('../services/toolsService.js');
const db = require('../database/db.js');

describe('Tools Service Tests', () => {
	const testUserId = 'test_tool_user_777';
	const testChannelId = 'test_channel_888';
	const testGuildId = 'test_guild_999';

	after(() => {
		db.db.exec(`DELETE FROM reminders WHERE user_id = '${testUserId}';`);
		db.db.exec(`DELETE FROM users WHERE user_id = '${testUserId}';`);
	});

	it('should declare tools properly', () => {
		assert.strictEqual(jimboFunctionDeclarations.length, 3);
		const names = jimboFunctionDeclarations.map(t => t.name);
		assert.ok(names.includes('set_reminder'));
		assert.ok(names.includes('get_dolar_rate'));
		assert.ok(names.includes('search_memory'));
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
