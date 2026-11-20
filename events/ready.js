const { Events } = require('discord.js');
const { startReminderTicker } = require('../services/reminderTicker.js');
const db = require('../database/db.js');

module.exports = {
	name: Events.ClientReady,

	// Este evento solo se ejecuta una vez
	once: true,
	async execute(client) {
		console.log(`¡Listo! Conectado como ${client.user.tag}`);
		startReminderTicker(client);

		if (!client.hasPrivilegedIntents) return;

		for (const guild of client.guilds.cache.values()) {
			try {
				const members = await guild.members.fetch();
				let count = 0;
				for (const member of members.values()) {
					if (member.user?.bot) continue;
					db.getOrCreateUser(member.id, member.user.username, member.displayName, guild.id);
					count++;
				}
				console.log(`[ROSTER] Sincronizados ${count} miembros en "${guild.name}".`);
			}
			catch (err) {
				console.warn(`[ROSTER] No se pudieron sincronizar miembros de "${guild.name}":`, err.message || err);
			}
		}
	},
};
