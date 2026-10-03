const assert = require('assert');
const db = require('../database/db.js');

describe('Database (SQLite) Tests', () => {
	const testUserId = 'test_unit_user_999';

	after(() => {
		// Limpieza de datos de prueba
		db.db.exec(`DELETE FROM users WHERE user_id = '${testUserId}';`);
		db.db.exec(`DELETE FROM memories WHERE user_id = '${testUserId}';`);
	});

	it('should create and retrieve a user with initial chips', () => {
		const user = db.getOrCreateUser(testUserId, 'testunit', 'Test Unit');
		assert.strictEqual(user.user_id, testUserId);
		assert.strictEqual(user.chips, 1000);
		assert.strictEqual(user.affinity, 0);
	});

	it('should add and deduct chips correctly', () => {
		const newBalance = db.addChips(testUserId, 250);
		assert.strictEqual(newBalance, 1250);

		const deductedBalance = db.addChips(testUserId, -500);
		assert.strictEqual(deductedBalance, 750);
	});

	it('should adjust affinity within -100 and +100 bounds', () => {
		const aff1 = db.adjustAffinity(testUserId, 15);
		assert.strictEqual(aff1, 15);

		const aff2 = db.adjustAffinity(testUserId, 150);
		assert.strictEqual(aff2, 100);

		const aff3 = db.adjustAffinity(testUserId, -300);
		assert.strictEqual(aff3, -100);
	});

	it('should record game results and update statistics', () => {
		db.recordGameResult(testUserId, true, 100);
		const user = db.getOrCreateUser(testUserId, 'testunit', 'Test Unit');
		assert.strictEqual(user.total_games_played, 1);
		assert.strictEqual(user.total_games_won, 1);
	});

	it('should add and retrieve user memories', () => {
		db.addMemory(testUserId, 'guild_test', 'balatro', 'Ganó una mano de cuatro comodines', 3);
		const memories = db.getUserMemories(testUserId, 5);
		assert.strictEqual(memories.length, 1);
		assert.strictEqual(memories[0].category, 'balatro');
		assert.strictEqual(memories[0].content, 'Ganó una mano de cuatro comodines');
	});
});
