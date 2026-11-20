const assert = require('assert');
const db = require('../database/db.js');
const { buildGuildRoster, formatRosterForPrompt } = require('../utils/rosterUtils.js');

describe('Roster Utils Tests', () => {
	const testGuildId = 'test_roster_guild_1';
	const user1 = 'roster_user_1';
	const user2 = 'roster_user_2';

	after(() => {
		db.db.exec(`DELETE FROM users WHERE user_id IN ('${user1}', '${user2}');`);
	});

	it('should build and format guild roster combining DB profiles and Discord presence', () => {
		db.getOrCreateUser(user1, 'koonts', 'Koonts', testGuildId);
		db.updateUserProfile(user1, {
			realName: 'Jossef',
			aliases: 'Josse',
			personalityNotes: 'Creador del bot',
		});

		db.getOrCreateUser(user2, 'giancarlo', 'Giancarlo', testGuildId);

		const fakeGuild = {
			id: testGuildId,
			client: { hasPrivilegedIntents: true },
			members: {
				cache: new Map([
					[user1, {
						id: user1,
						displayName: 'Koonts',
						user: { username: 'koonts', bot: false },
						presence: { status: 'online' },
					}],
					[user2, {
						id: user2,
						displayName: 'Giancarlo',
						user: { username: 'giancarlo', bot: false },
						presence: { status: 'offline' },
					}],
					['bot_999', {
						id: 'bot_999',
						displayName: 'ConviveDJ',
						user: { username: 'convivedj', bot: true },
						presence: { status: 'online' },
					}],
				]),
			},
		};

		const { entries, hasPresence } = buildGuildRoster(fakeGuild, null);
		assert.strictEqual(hasPresence, true);
		assert.ok(!entries.some(e => e.userId === 'bot_999'));
		assert.strictEqual(entries[0].userId, user1);

		const formatted = formatRosterForPrompt(entries, hasPresence);
		assert.ok(formatted.includes('Koonts (@koonts)'));
		assert.ok(formatted.includes('Nombre: Jossef'));
		assert.ok(formatted.includes('Apodos: Josse'));
		assert.ok(formatted.includes('Estado: en línea'));
		assert.ok(formatted.includes('Estado: desconectado'));
	});
});
