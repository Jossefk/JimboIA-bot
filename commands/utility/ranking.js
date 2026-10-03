const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../../database/db.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('ranking')
		.setDescription('Muestra el top de jugadores con más fichas del casino balatriano.'),

	/**
	 * @param {import("discord.js").Client<true>} client
	 * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
	 */
	async execute(client, interaction) {
		const topUsers = db.getLeaderboard(10);

		if (topUsers.length === 0) {
			return interaction.reply({ content: 'Aún no hay jugadores registrados en el casino.', flags: 64 });
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
			.setTitle('🏆 Salón de la Fama Balatriana')
			.setDescription(leaderboardText)
			.setTimestamp()
			.setFooter({ text: '¿Quién será el verdadero amo del Balatreo?' });

		await interaction.reply({ embeds: [embed] });
	},
};
