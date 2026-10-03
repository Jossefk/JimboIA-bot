const { Events } = require('discord.js');
const { startReminderTicker } = require('../services/reminderTicker.js');

module.exports = {
	name: Events.ClientReady,

	// Este evento solo se ejecuta una vez
	once: true,
	execute(client) {
		console.log(`¡Listo! a balatrear como ${client.user.tag}`);
		startReminderTicker(client);
	},
};