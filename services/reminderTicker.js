const db = require('../database/db.js');

let tickerInterval = null;

/**
 * Inicia el ticker de recordatorios en segundo plano
 * @param {import('discord.js').Client} client
 */
function startReminderTicker(client) {
	if (tickerInterval) return;

	console.log('[TICKER] Servicio de recordatorios iniciado (intervalo: 30s).');

	tickerInterval = setInterval(async () => {
		try {
			const nowIso = new Date().toISOString();
			const dueReminders = db.getDueReminders(nowIso);

			if (!dueReminders || dueReminders.length === 0) return;

			for (const reminder of dueReminders) {
				try {
					const userTag = `<@${reminder.user_id}>`;
					const reminderContent = `⏰ ¡Epa ${userTag}! Te dije que te iba a recordar esto:\n> **${reminder.reminder_text}**\n🃏 ¡Ponte las pilas o balatreamos! ✨`;

					if (reminder.send_dm) {
						try {
							const user = await client.users.fetch(reminder.user_id);
							if (user) {
								await user.send(reminderContent);
							}
						}
						catch {
							// Si el usuario tiene los DMs cerrados, intentar enviar al canal
							const channel = await client.channels.fetch(reminder.channel_id);
							if (channel) {
								await channel.send(`${reminderContent}\n*(Intenté mandártelo por DM pero los tienes cerrados, chamo)*`);
							}
						}
					}
					else {
						const channel = await client.channels.fetch(reminder.channel_id);
						if (channel) {
							await channel.send(reminderContent);
						}
					}

					db.markReminderCompleted(reminder.id);
					console.log(`[TICKER] Recordatorio #${reminder.id} entregado con éxito a ${reminder.user_id}.`);
				}
				catch (err) {
					console.error(`[TICKER] Error enviando recordatorio #${reminder.id}:`, err);
					// Marcar completado si el canal/usuario no existe para no reintentar eternamente
					db.markReminderCompleted(reminder.id);
				}
			}
		}
		catch (error) {
			console.error('[TICKER] Error en ciclo de recordatorios:', error);
		}
	}, 30_000);
}

function stopReminderTicker() {
	if (tickerInterval) {
		clearInterval(tickerInterval);
		tickerInterval = null;
		console.log('[TICKER] Servicio de recordatorios detenido.');
	}
}

module.exports = {
	startReminderTicker,
	stopReminderTicker,
};
