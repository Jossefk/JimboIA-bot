const { SlashCommandBuilder } = require('discord.js');
const { joinVoice, leaveVoice, speakText, getVoiceConnection } = require('../../services/voiceService.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('voz')
		.setDescription('Controla la presencia de voz de Jimbo en los canales de voz.')
		.addSubcommand(sub =>
			sub
				.setName('unirse')
				.setDescription('Une a Jimbo a tu canal de voz actual para hablar y escuchar.'),
		)
		.addSubcommand(sub =>
			sub
				.setName('salir')
				.setDescription('Desconecta a Jimbo del canal de voz.'),
		)
		.addSubcommand(sub =>
			sub
				.setName('hablar')
				.setDescription('Haz que Jimbo diga algo en voz alta en el canal de voz.')
				.addStringOption(opt =>
					opt
						.setName('mensaje')
						.setDescription('El texto que Jimbo dirá con su voz venezolana')
						.setRequired(true),
				),
		),

	/**
	 * @param {import("discord.js").Client} client
	 * @param {import("discord.js").ChatInputCommandInteraction} interaction
	 */
	async execute(client, interaction) {
		const subcommand = interaction.options.getSubcommand();
		const guild = interaction.guild;

		if (!guild) {
			return interaction.reply({ content: 'Este comando solo puede usarse en un servidor.', flags: 64 });
		}

		if (subcommand === 'unirse') {
			const memberVoice = interaction.member?.voice?.channel;
			if (!memberVoice) {
				return interaction.reply({
					content: '🃏 ¡Epa chamo! Tienes que estar metido en un canal de voz para que me pueda unir contigo.',
					flags: 64,
				});
			}

			await interaction.deferReply();
			try {
				await joinVoice(memberVoice);
				return interaction.editReply(`🃏 ¡Listo mi pana! Me uní al canal de voz **${memberVoice.name}**. ¡Háblame por micrófono o pídeme que diga algo!`);
			}
			catch (err) {
				console.error('[COMMAND VOZ] Error al unirse:', err);
				return interaction.editReply('🃏 ¡Naguará, no me pude conectar al canal de voz! Revisa si tengo permisos para unirme y hablar.');
			}
		}

		if (subcommand === 'salir') {
			const conn = getVoiceConnection(guild.id);
			if (!conn) {
				return interaction.reply({ content: '🃏 Si ni siquiera estoy metido en ningún canal de voz, chamo.', flags: 64 });
			}

			leaveVoice(guild.id);
			return interaction.reply('🃏 ¡Hablamos luego panas! Me salí del canal de voz a seguir contando cartas.');
		}

		if (subcommand === 'hablar') {
			const conn = getVoiceConnection(guild.id);
			if (!conn) {
				return interaction.reply({
					content: '🃏 Primero tienes que unirme a un canal de voz con `/voz unirse` para que pueda hablar.',
					flags: 64,
				});
			}

			const text = interaction.options.getString('mensaje');
			await interaction.deferReply();
			const spoken = await speakText(guild.id, text);

			if (spoken) {
				return interaction.editReply(`🔊 Diciendo en el voice: *"${text}"*`);
			}
			else {
				return interaction.editReply('🃏 Se me trabó la lengua balatreando ese texto, intenta otra vez.');
			}
		}
	},
};
