const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../../database/db.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('perfil')
		.setDescription('Consulta tu expediente del Limbo, saldo de fichas, mochila y recuerdos de Jimbo.')
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

		const userRecord = db.getOrCreateUser(targetUser.id, targetUser.username, displayName, interaction.guildId);
		const memories = db.getUserMemories(targetUser.id, 6);
		const inventory = db.getUserInventory(targetUser.id, 6);
		const activeContract = db.getActiveContract(targetUser.id);

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

		const fields = [
			{ name: '🎭 Afinidad con Jimbo', value: `${userRecord.affinity} pts (${affinityStatus})`, inline: true },
			{ name: '🪙 Fichas', value: `**${userRecord.chips}** fichas`, inline: true },
			{ name: '🎲 Historial Blackjack', value: `${userRecord.total_games_won}V / ${userRecord.total_games_played}P (Winrate: ${winRate})`, inline: true },
		];

		if (userRecord.real_name || userRecord.aliases) {
			const identityParts = [];
			if (userRecord.real_name) identityParts.push(`Nombre: **${userRecord.real_name}**`);
			if (userRecord.aliases) identityParts.push(`Apodos: ${userRecord.aliases}`);
			fields.push({ name: '🪪 Identidad', value: identityParts.join(' • ') });
		}

		if (userRecord.personality_notes && userRecord.personality_notes.trim()) {
			fields.push({ name: '📝 Resumen de Perfil', value: userRecord.personality_notes.trim() });
		}

		if (inventory.length > 0) {
			const invSummary = inventory.map(i => `• ${i.item_name} (x${i.quantity})`).join('\n');
			fields.push({ name: '🎒 Mochila del Limbo', value: invSummary });
		}

		if (activeContract) {
			fields.push({
				name: '📜 Contrato Activo',
				value: `${activeContract.contract_text} _(Recompensa: ${activeContract.reward_chips} 🪙)_`,
			});
		}

		fields.push({ name: '🧠 Lo que Jimbo recuerda de ti', value: memoriesList });

		const embed = new EmbedBuilder()
			.setColor(0x2B2D31)
			.setAuthor({ name: `Expediente de ${displayName}`, iconURL: targetUser.displayAvatarURL() })
			.setTitle('🕯️ Expediente de Viajero del Limbo')
			.addFields(fields)
			.setTimestamp()
			.setFooter({ text: 'Usa /memoria ver para IDs o /tienda ver para mercancía.' });

		await interaction.reply({ embeds: [embed] });
	},
};
