const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../../database/db.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('ranking')
		.setDescription('Muestra el top de panas con más fichas en el callejón del Limbo.'),

	/**
	 * @param {import("discord.js").Client<true>} client
	 * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
	 */
	async execute(client, interaction) {
		const topUsers = db.getLeaderboard(10);

		if (topUsers.length === 0) {
			return interaction.reply({ content: 'Aún no hay viajeros con fichas registradas en el callejón.', flags: 64 });
		}

		const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

		const leaderboardText = topUsers
			.map((u, index) => {
				const medal = medals[index] || `#${index + 1}`;
				return `${medal} **${u.display_name || u.username}** — **${u.chips}** 🪙 _(${u.total_games_won} victorias)_`;
			})
			.join('\n');

		const embed = new EmbedBuilder()
			.setColor(0xFEE75C)
			.setTitle('🕯️ Ranking de Fichas del Limbo')
			.setDescription(leaderboardText)
			.setTimestamp()
			.setFooter({ text: 'Mercancía fiada no existe en este callejón.' });

		await interaction.reply({ embeds: [embed] });
	},
};
