const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../../database/db.js');
const { generateJimboResponse } = require('../../services/geminiService.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('ask')
		.setDescription('¡Hazle una pregunta a Jimbo!')
		.addStringOption(option =>
			option
				.setName('pregunta')
				.setDescription('La pregunta que quieres hacerle a Jimbo.')
				.setRequired(true),
		),

	/**
	 * @param {import("discord.js").Client<true>} client
	 * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
	 */
	async execute(client, interaction) {
		await interaction.deferReply();
		const pregunta = interaction.options.getString('pregunta');

		try {
			const displayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
			const user = db.getOrCreateUser(interaction.user.id, interaction.user.username, displayName);

			const replyText = await generateJimboResponse({
				user,
				guildName: interaction.guild?.name || 'Servidor',
				channelName: interaction.channel?.name || 'canal',
				contextMessages: [],
				userMessage: pregunta,
				isSerious: false,
			});

			const responseEmbed = new EmbedBuilder()
				.setColor(0x0099FF)
				.setAuthor({
					name: `Pregunta de ${displayName}`,
					iconURL: interaction.user.displayAvatarURL(),
				})
				.setTitle('🃏 Jimbo te balatrea una respuesta:')
				.addFields({ name: 'Tu pregunta:', value: pregunta.length > 250 ? pregunta.substring(0, 247) + '...' : pregunta })
				.setDescription(replyText.length > 4000 ? replyText.substring(0, 3995) + '...' : replyText)
				.setTimestamp()
				.setFooter({ text: `Fichas: ${user.chips} 🪙 | Afinidad: ${user.affinity}` });

			await interaction.editReply({ embeds: [responseEmbed] });
		}
		catch (error) {
			console.error('Error al generar la respuesta de Gemini en /ask:', error);
			await interaction.editReply('🃏 ¡Upa! Algo salió mal tratando de balatrear una respuesta. Inténtalo de nuevo.');
		}
	},
};
