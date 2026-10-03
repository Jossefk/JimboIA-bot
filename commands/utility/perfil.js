const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../../database/db.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('perfil')
		.setDescription('Consulta tu perfil balatriano, saldo de fichas y recuerdos que Jimbo tiene de ti.')
		.addUserOption(option =>
			option
				.setName('usuario')
				.setDescription('El usuario que deseas consultar (opcional, por defecto tú).')
				.setRequired(false),
		),

	/**
	 * @param {import("discord.js").Client<true>} client
	 * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
	 */
	async execute(client, interaction) {
		const targetUser = interaction.options.getUser('usuario') || interaction.user;
		const member = interaction.guild ? await interaction.guild.members.fetch(targetUser.id).catch(() => null) : null;
		const displayName = member?.displayName || targetUser.displayName || targetUser.username;

		const userRecord = db.getOrCreateUser(targetUser.id, targetUser.username, displayName);
		const memories = db.getUserMemories(targetUser.id, 5);

		let affinityStatus = 'Neutral (aún se están conociendo)';
		if (userRecord.affinity >= 30) {
			affinityStatus = '🔥 ¡Pana del alma! (Le caes fino)';
		}
		else if (userRecord.affinity >= 10) {
			affinityStatus = '👍 Buena onda';
		}
		else if (userRecord.affinity <= -30) {
			affinityStatus = '💀 Enemigo jurado (te tiene rabia)';
		}
		else if (userRecord.affinity <= -10) {
			affinityStatus = '👀 Sospechoso / Te tiene en la mira';
		}

		const winRate = userRecord.total_games_played > 0
			? `${Math.round((userRecord.total_games_won / userRecord.total_games_played) * 100)}%`
			: 'N/A';

		const memoriesList = memories.length > 0
			? memories.map(m => `• **[${m.category}]**: ${m.content}`).join('\n')
			: '_Jimbo aún no ha registrado recuerdos personales sobre ti. ¡Háblale en el chat para que aprenda!_';

		const embed = new EmbedBuilder()
			.setColor(0x0099FF)
			.setAuthor({ name: `Perfil de ${displayName}`, iconURL: targetUser.displayAvatarURL() })
			.setTitle('🃏 Ficha de Jugador Balatriano')
			.addFields(
				{ name: '🪙 Fichas Disponibles', value: `**${userRecord.chips}** fichas`, inline: true },
				{ name: '🎭 Afinidad con Jimbo', value: `${userRecord.affinity} pts (${affinityStatus})`, inline: true },
				{ name: '🎲 Historial Blackjack', value: `${userRecord.total_games_won}V / ${userRecord.total_games_played}P (Winrate: ${winRate})`, inline: true },
				{ name: '🧠 Lo que Jimbo recuerda de ti', value: memoriesList },
			)
			.setTimestamp()
			.setFooter({ text: '¡Sigue balatreando para ganar más fichas y forjar tu historia!' });

		await interaction.reply({ embeds: [embed] });
	},
};
