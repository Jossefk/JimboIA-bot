const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../../database/db.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('configurar')
		.setDescription('Configura el comportamiento social de Jimbo en el servidor (Solo Administradores).')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.addSubcommand(sub =>
			sub
				.setName('probabilidad')
				.setDescription('Ajusta la probabilidad de que Jimbo intervenga espontáneamente en las conversaciones.')
				.addIntegerOption(opt =>
					opt
						.setName('porcentaje')
						.setDescription('Porcentaje de intervención espontánea (ej. 3 para 3%, entre 0 y 20).')
						.setMinValue(0)
						.setMaxValue(20)
						.setRequired(true),
				),
		)
		.addSubcommand(sub =>
			sub
				.setName('canal')
				.setDescription('Permite o desactiva las intervenciones espontáneas en un canal específico.')
				.addChannelOption(opt =>
					opt
						.setName('objetivo')
						.setDescription('Canal de texto a configurar.')
						.setRequired(true),
				),
		)
		.addSubcommand(sub =>
			sub
				.setName('estado')
				.setDescription('Muestra la configuración actual de Jimbo en este servidor.'),
		),

	/**
	 * @param {import("discord.js").Client<true>} client
	 * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
	 */
	async execute(client, interaction) {
		const guildId = interaction.guildId;
		const sub = interaction.options.getSubcommand();
		const currentSettings = db.getServerSettings(guildId);

		if (sub === 'probabilidad') {
			const porcentaje = interaction.options.getInteger('porcentaje');
			const newRate = porcentaje / 100;
			db.updateServerSettings(guildId, { chime_in_rate: newRate });
			return interaction.reply({
				content: `✅ Probabilidad de intervención espontánea ajustada a **${porcentaje}%** para este servidor.`,
				flags: 64,
			});
		}

		if (sub === 'canal') {
			const channel = interaction.options.getChannel('objetivo');
			let allowedChannels = currentSettings.allowed_channels || [];

			if (allowedChannels.includes(channel.id)) {
				allowedChannels = allowedChannels.filter(id => id !== channel.id);
				db.updateServerSettings(guildId, { allowed_channels: allowedChannels });
				return interaction.reply({
					content: `🔇 <#${channel.id}> ya no recibirá comentarios espontáneos de Jimbo (solo responderá si lo mencionan directamente).`,
					flags: 64,
				});
			}
			else {
				allowedChannels.push(channel.id);
				db.updateServerSettings(guildId, { allowed_channels: allowedChannels });
				return interaction.reply({
					content: `📢 <#${channel.id}> añadido a los canales con charla espontánea de Jimbo.`,
					flags: 64,
				});
			}
		}

		if (sub === 'estado') {
			const ratePercent = Math.round(currentSettings.chime_in_rate * 100);
			const channelsDisplay = currentSettings.allowed_channels.length > 0
				? currentSettings.allowed_channels.map(id => `<#${id}>`).join(', ')
				: '_Todos los canales del servidor tienen permitido el chime-in._';

			const embed = new EmbedBuilder()
				.setColor(0x0099FF)
				.setTitle('⚙️ Configuración Social de Jimbo')
				.addFields(
					{ name: '🎲 Probabilidad de charla espontánea', value: `${ratePercent}% de los mensajes`, inline: true },
					{ name: '📍 Canales autorizados para charla espontánea', value: channelsDisplay },
				)
				.setFooter({ text: 'Usa /configurar probabilidad o /configurar canal para modificar.' });

			return interaction.reply({ embeds: [embed] });
		}
	},
};
