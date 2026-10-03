const assert = require('assert');
const db = require('../database/db.js');

describe('Reminders and FTS5 Tests', () => {
	const testUserId = 'test_reminders_user_123';
	const testChannelId = 'test_channel_456';
	const testGuildId = 'test_guild_789';

	after(() => {
		db.db.exec(`DELETE FROM reminders WHERE user_id = '${testUserId}';`);
		db.db.exec(`DELETE FROM memories WHERE user_id = '${testUserId}';`);
		db.db.exec(`DELETE FROM users WHERE user_id = '${testUserId}';`);
	});

	it('should add a reminder and retrieve it when due', () => {
		db.getOrCreateUser(testUserId, 'testreminder', 'Test Reminder');
		const pastTrigger = new Date(Date.now() - 10_000).toISOString();
		const reminderId = db.addReminder(testUserId, testChannelId, testGuildId, 'Comprar pan dulce', pastTrigger, 0);

		assert.ok(reminderId > 0, 'Reminder ID should be greater than 0');

		const due = db.getDueReminders(new Date().toISOString());
		const found = due.find(r => r.id === reminderId);
		assert.ok(found, 'Should find the due reminder');
		assert.strictEqual(found.reminder_text, 'Comprar pan dulce');
		assert.strictEqual(found.user_id, testUserId);

		db.markReminderCompleted(reminderId);
		const dueAfter = db.getDueReminders(new Date().toISOString());
		const foundAfter = dueAfter.find(r => r.id === reminderId);
		assert.strictEqual(foundAfter, undefined, 'Completed reminder should not be in due list');
	});

	it('should search memories using FTS5 virtual table', () => {
		db.addMemory(testUserId, testGuildId, 'anime', 'Su anime favorito de toda la vida es One Piece', 4);
		db.addMemory(testUserId, testGuildId, 'trabajo', 'Trabaja remoto como desarrollador backend', 3);

		const search1 = db.searchMemories('Piece');
		assert.ok(search1.length >= 1, 'Should find memories with "Piece"');
		assert.ok(search1.some(m => m.content.includes('One Piece')));

		const search2 = db.searchMemories('remoto');
		assert.ok(search2.length >= 1, 'Should find memories with "remoto"');
		assert.ok(search2.some(m => m.content.includes('backend')));
	});
});
