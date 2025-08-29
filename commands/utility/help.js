const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('help')
		.setDescription('Muestra todos los comandos disponibles.'),

	async execute(client, interaction) {
		const commands = client.commands;
		const embed = new EmbedBuilder()
			.setColor(0x0099FF)
			.setTitle('Comandos de JimboAI-bot')
			.setDescription('Aquí tienes una lista de todos los comandos disponibles:');

		commands.forEach(command => {
			embed.addFields({ name: `/${command.data.name}`, value: command.data.description });
		});

		await interaction.reply({ embeds: [embed], ephemeral: true });
	},
};
