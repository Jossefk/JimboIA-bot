const assert = require('assert');
const { executeToolCall, jimboFunctionDeclarations } = require('../services/toolsService.js');
const db = require('../database/db.js');

describe('Tools Service Tests', () => {
	const testUserId = 'test_tool_user_777';
	const secondUserId = 'test_tool_user_778';
	const testChannelId = 'test_channel_888';
	const testGuildId = 'test_guild_999';

	after(() => {
		db.db.exec(`DELETE FROM daily_contracts WHERE user_id IN ('${testUserId}', '${secondUserId}');`);
		db.db.exec(`DELETE FROM user_inventory WHERE user_id IN ('${testUserId}', '${secondUserId}');`);
		db.db.exec(`DELETE FROM reminders WHERE user_id IN ('${testUserId}', '${secondUserId}');`);
		db.db.exec(`DELETE FROM memories WHERE user_id IN ('${testUserId}', '${secondUserId}');`);
		db.db.exec(`DELETE FROM users WHERE user_id IN ('${testUserId}', '${secondUserId}');`);
	});

	it('should declare tools properly', () => {
		assert.strictEqual(jimboFunctionDeclarations.length, 9);
		const names = jimboFunctionDeclarations.map(t => t.name);
		assert.ok(names.includes('set_reminder'));
		assert.ok(names.includes('get_dolar_rate'));
		assert.ok(names.includes('search_memory'));
		assert.ok(names.includes('save_memory'));
		assert.ok(names.includes('get_person_profile'));
		assert.ok(names.includes('update_person_profile'));
		assert.ok(names.includes('limbo_shop'));
		assert.ok(names.includes('existential_invoice'));
		assert.ok(names.includes('limbo_contract'));
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

	it('should execute update_person_profile, save_memory with target_name, and get_person_profile', async () => {
		db.getOrCreateUser(secondUserId, 'cruzeldev', 'Cruzel', testGuildId);

		const updateRes = await executeToolCall({
			name: 'update_person_profile',
			args: {
				target_name: 'Cruzel',
				real_name: 'Carlos',
				aliases: 'El Pana',
				personality_notes: 'Emprendedor de boletería',
			},
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });

		assert.strictEqual(updateRes.status, 'success');
		assert.strictEqual(updateRes.profile.real_name, 'Carlos');

		const saveRes = await executeToolCall({
			name: 'save_memory',
			args: {
				target_name: 'Carlos',
				category: 'trabajo',
				content: 'Compara nombres entre TikeFaz y TikeFacil',
				importance: 4,
			},
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });

		assert.strictEqual(saveRes.status, 'success');
		assert.strictEqual(saveRes.target_user, 'Cruzel');

		const profileRes = await executeToolCall({
			name: 'get_person_profile',
			args: { query: 'El Pana' },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });

		assert.strictEqual(profileRes.found, true);
		assert.strictEqual(profileRes.real_name, 'Carlos');
		assert.ok(profileRes.memories.some(m => m.recuerdo.includes('TikeFaz')));
	});

	it('should execute limbo_shop catalog, buy, insufficient_funds, inventory, and use', async () => {
		db.getOrCreateUser(testUserId, 'tooluser', 'Tool User', testGuildId);
		db.setChips(testUserId, 100);

		const catalogRes = await executeToolCall({
			name: 'limbo_shop',
			args: { action: 'catalog' },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(catalogRes.saldo_fichas, 100);
		assert.ok(catalogRes.mercancia.length >= 6);

		const buyRes = await executeToolCall({
			name: 'limbo_shop',
			args: { action: 'buy', item_key: 'empanada_limbo' },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(buyRes.status, 'success');
		assert.strictEqual(buyRes.gastado, 40);
		assert.strictEqual(buyRes.nuevo_saldo, 60);

		const failBuyRes = await executeToolCall({
			name: 'limbo_shop',
			args: { action: 'buy', item_key: 'amuleto_corpoelec' },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(failBuyRes.status, 'insufficient_funds');
		assert.strictEqual(failBuyRes.saldo_actual, 60);

		const invRes = await executeToolCall({
			name: 'limbo_shop',
			args: { action: 'inventory' },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(invRes.mochila.length, 1);
		assert.strictEqual(invRes.mochila[0].item_key, 'empanada_limbo');

		const useRes = await executeToolCall({
			name: 'limbo_shop',
			args: { action: 'use', item_key: 'empanada_limbo' },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(useRes.status, 'consumed');
		assert.strictEqual(useRes.restantes, 0);
	});

	it('should execute existential_invoice returning profile and real memories', async () => {
		const invRes = await executeToolCall({
			name: 'existential_invoice',
			args: { target_name: 'Cruzel' },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });

		assert.strictEqual(invRes.found, true);
		assert.strictEqual(invRes.persona, 'Cruzel');
		assert.strictEqual(invRes.ficha.nombre_real, 'Carlos');
		assert.ok(invRes.recuerdos.some(r => r.contenido.includes('TikeFaz')));
	});

	it('should execute limbo_contract create, prevent duplicate, complete, and enforce daily cooldown', async () => {
		db.setChips(testUserId, 100);

		const createRes = await executeToolCall({
			name: 'limbo_contract',
			args: {
				action: 'create',
				contract_text: 'Tomar un vaso de agua y estirar la espalda',
				reward_chips: 80,
			},
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(createRes.status, 'created');
		assert.strictEqual(createRes.contract.reward_chips, 80);

		const dupRes = await executeToolCall({
			name: 'limbo_contract',
			args: { action: 'create', contract_text: 'Otra mision', reward_chips: 100 },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(dupRes.status, 'already_active');

		const completeRes = await executeToolCall({
			name: 'limbo_contract',
			args: { action: 'complete' },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(completeRes.status, 'completed');
		assert.strictEqual(completeRes.reward, 80);
		assert.strictEqual(completeRes.newBalance, 180);

		const cooldownRes = await executeToolCall({
			name: 'limbo_contract',
			args: { action: 'create', contract_text: 'Otra mas hoy', reward_chips: 100 },
		}, { userId: testUserId, channelId: testChannelId, guildId: testGuildId });
		assert.strictEqual(cooldownRes.status, 'cooldown');
	});
});
