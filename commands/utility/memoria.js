const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../../database/db.js');
const { embedMemoryInBackground } = require('../../services/geminiService.js');
const { ownerId } = require('../../config.js');

const DEFAULT_ALLOWED_OWNER = '217632647294222336';

function isAdminOrOwner(interaction) {
	return Boolean(
		interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
		|| interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
		|| interaction.user.id === DEFAULT_ALLOWED_OWNER
		|| (ownerId && interaction.user.id === ownerId),
	);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('memoria')
		.setDescription('Consulta o administra las fichas de personas y recuerdos que guarda Jimbo.')
		.addSubcommand(sub =>
			sub
				.setName('ver')
				.setDescription('Muestra el directorio de personas conocidas o los recuerdos detallados de un usuario.')
				.addUserOption(opt =>
					opt
						.setName('usuario')
						.setDescription('Usuario específico a consultar (si se omite, muestra el directorio del servidor).')
						.setRequired(false),
				)
				.addBooleanOption(opt =>
					opt
						.setName('privado')
						.setDescription('Mostrar la respuesta solo para ti (por defecto: no).')
						.setRequired(false),
				),
		)
		.addSubcommand(sub =>
			sub
				.setName('ficha')
				.setDescription('(Admins) Configura nombre real, apodos o notas de perfil de una persona.')
				.addUserOption(opt =>
					opt
						.setName('usuario')
						.setDescription('Persona cuya ficha deseas actualizar.')
						.setRequired(true),
				)
				.addStringOption(opt =>
					opt
						.setName('nombre')
						.setDescription('Nombre real (ej. Jossef).')
						.setRequired(false),
				)
				.addStringOption(opt =>
					opt
						.setName('apodos')
						.setDescription('Apodos separados por coma (ej. Koonts, Josse).')
						.setRequired(false),
				)
				.addStringOption(opt =>
					opt
						.setName('notas')
						.setDescription('Resumen breve de su perfil o vibra.')
						.setRequired(false),
				),
		)
		.addSubcommand(sub =>
			sub
				.setName('agregar')
				.setDescription('(Admins) Añade un recuerdo manual a la memoria de una persona.')
				.addUserOption(opt =>
					opt
						.setName('usuario')
						.setDescription('Persona sobre la que quieres guardar el recuerdo.')
						.setRequired(true),
				)
				.addStringOption(opt =>
					opt
						.setName('dato')
						.setDescription('El dato o hecho a recordar.')
						.setRequired(true),
				)
				.addStringOption(opt =>
					opt
						.setName('categoria')
						.setDescription('Categoría del recuerdo.')
						.addChoices(
							{ name: 'Gusto', value: 'gusto' },
							{ name: 'Trabajo / Estudio', value: 'trabajo' },
							{ name: 'Anécdota', value: 'anecdota' },
							{ name: 'Vida personal', value: 'vida' },
							{ name: 'Anime', value: 'anime' },
							{ name: 'Juego', value: 'juego' },
							{ name: 'General', value: 'general' },
						)
						.setRequired(false),
				)
				.addIntegerOption(opt =>
					opt
						.setName('importancia')
						.setDescription('Nivel de importancia del 1 al 5 (por defecto 3).')
						.setMinValue(1)
						.setMaxValue(5)
						.setRequired(false),
				),
		)
		.addSubcommand(sub =>
			sub
				.setName('borrar')
				.setDescription('(Admins) Elimina un recuerdo específico por #ID o todos los de un usuario.')
				.addIntegerOption(opt =>
					opt
						.setName('id')
						.setDescription('Número #ID del recuerdo a eliminar (visible en /memoria ver).')
						.setRequired(false),
				)
				.addUserOption(opt =>
					opt
						.setName('usuario')
						.setDescription('Borra TODOS los recuerdos de este usuario si no especificas #ID.')
						.setRequired(false),
				),
		),

	/**
	 * @param {import("discord.js").Client<true>} client
	 * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
	 */
	async execute(client, interaction) {
		const sub = interaction.options.getSubcommand();

		if (sub === 'ver') {
			const targetUser = interaction.options.getUser('usuario');
			const isPrivate = interaction.options.getBoolean('privado') || false;
			const flags = isPrivate ? 64 : undefined;

			if (!targetUser) {
				const users = db.getKnownUsers(interaction.guildId, 25);
				if (users.length === 0) {
					return interaction.reply({
						content: 'Todavía no tengo personas registradas en este servidor.',
						flags: 64,
					});
				}

				const lines = users.map(u => {
					const namePart = u.real_name ? ` — **${u.real_name}**` : '';
					const notesPart = u.personality_notes
						? `\n  _${u.personality_notes.slice(0, 90)}${u.personality_notes.length > 90 ? '...' : ''}_`
						: '';
					return `• **${u.display_name || u.username}**${namePart} (${u.memory_count} recuerdos)${notesPart}`;
				});

				let description = lines.join('\n');
				if (description.length > 3950) {
					description = description.slice(0, 3947) + '...';
				}

				const embed = new EmbedBuilder()
					.setColor(0x0099FF)
					.setTitle('🧠 Personas que Jimbo recuerda en el servidor')
					.setDescription(description)
					.setFooter({ text: 'Usa /memoria ver usuario:@alguien para ver su ficha y recuerdos con #ID' });

				return interaction.reply({ embeds: [embed], flags });
			}

			const member = interaction.guild
				? await interaction.guild.members.fetch(targetUser.id).catch(() => null)
				: null;
			const displayName = member?.displayName || targetUser.displayName || targetUser.username;
			const userRecord = db.getOrCreateUser(targetUser.id, targetUser.username, displayName, interaction.guildId);
			const isRestrictedChannel = !interaction.guildId || (
				interaction.guild?.roles?.everyone
				&& typeof interaction.channel?.permissionsFor === 'function'
				&& !interaction.channel.permissionsFor(interaction.guild.roles.everyone)?.has('ViewChannel')
			);
			const canShowPrivate = isRestrictedChannel || (isPrivate && (isAdminOrOwner(interaction) || targetUser.id === interaction.user.id));
			const memories = db.getUserMemories(targetUser.id, 30, {
				channelId: interaction.channelId,
				includePrivate: canShowPrivate,
			});

			let memoriesText = memories.length > 0
				? memories.map(m => `${m.is_private ? '🔒 ' : ''}\`#${m.id}\` **[${m.category}]** *(imp:${m.importance})* — ${m.content}`).join('\n')
				: '_No hay recuerdos registrados todavía para este usuario._';

			if (memoriesText.length > 3900) {
				memoriesText = memoriesText.slice(0, 3897) + '...';
			}

			const embed = new EmbedBuilder()
				.setColor(0x0099FF)
				.setAuthor({ name: `Ficha de ${displayName}`, iconURL: targetUser.displayAvatarURL() })
				.addFields(
					{ name: '🪪 Nombre real', value: userRecord.real_name || '_Sin definir_', inline: true },
					{ name: '🏷️ Apodos', value: userRecord.aliases || '_Sin definir_', inline: true },
					{ name: '🎭 Afinidad', value: `${userRecord.affinity} pts`, inline: true },
					{ name: '📝 Resumen de perfil', value: userRecord.personality_notes || '_Sin notas_' },
				)
				.setDescription(`**Recuerdos guardados (${memories.length}):**\n${memoriesText}`)
				.setFooter({ text: 'Admins: usa /memoria ficha, /memoria agregar o /memoria borrar' });

			return interaction.reply({ embeds: [embed], flags });
		}

		if (!isAdminOrOwner(interaction)) {
			return interaction.reply({
				content: 'Solo administradores pueden editar o borrar fichas y recuerdos.',
				flags: 64,
			});
		}

		if (sub === 'ficha') {
			const targetUser = interaction.options.getUser('usuario');
			const nombre = interaction.options.getString('nombre');
			const apodos = interaction.options.getString('apodos');
			const notas = interaction.options.getString('notas');

			if (nombre === null && apodos === null && notas === null) {
				return interaction.reply({
					content: 'Debes indicar al menos un campo para actualizar (`nombre`, `apodos` o `notas`).',
					flags: 64,
				});
			}

			const member = interaction.guild
				? await interaction.guild.members.fetch(targetUser.id).catch(() => null)
				: null;
			const displayName = member?.displayName || targetUser.displayName || targetUser.username;
			db.getOrCreateUser(targetUser.id, targetUser.username, displayName, interaction.guildId);

			const updated = db.updateUserProfile(targetUser.id, {
				realName: nombre ?? undefined,
				aliases: apodos ?? undefined,
				personalityNotes: notas ?? undefined,
			});

			return interaction.reply({
				content: `✅ Ficha de **${displayName}** actualizada.\n• **Nombre:** ${updated.real_name || '—'}\n• **Apodos:** ${updated.aliases || '—'}\n• **Notas:** ${updated.personality_notes || '—'}`,
				flags: 64,
			});
		}

		if (sub === 'agregar') {
			const targetUser = interaction.options.getUser('usuario');
			const dato = interaction.options.getString('dato');
			const categoria = interaction.options.getString('categoria') || 'general';
			const importancia = interaction.options.getInteger('importancia') || 3;

			const member = interaction.guild
				? await interaction.guild.members.fetch(targetUser.id).catch(() => null)
				: null;
			const displayName = member?.displayName || targetUser.displayName || targetUser.username;
			db.getOrCreateUser(targetUser.id, targetUser.username, displayName, interaction.guildId);

			const memoryId = db.addMemory(targetUser.id, interaction.guildId, categoria, dato, importancia, {
				channelId: interaction.channelId,
				isPrivate: false,
				confidence: 'high',
			});
			if (memoryId) {
				embedMemoryInBackground(memoryId, dato).catch(() => {
					// Silencioso en background
				});
			}
			return interaction.reply({
				content: `✅ Recuerdo \`#${memoryId}\` guardado para **${displayName}** en [${categoria}]: ${dato}`,
				flags: 64,
			});
		}

		if (sub === 'borrar') {
			const id = interaction.options.getInteger('id');
			const targetUser = interaction.options.getUser('usuario');

			if (id !== null) {
				const deleted = db.deleteMemory(id, targetUser ? targetUser.id : null);
				return interaction.reply({
					content: deleted
						? `🗑️ Recuerdo \`#${id}\` eliminado.`
						: `No encontré el recuerdo \`#${id}\`${targetUser ? ' para ese usuario' : ''}.`,
					flags: 64,
				});
			}

			if (targetUser) {
				const count = db.deleteAllUserMemories(targetUser.id);
				return interaction.reply({
					content: count > 0
						? `🗑️ Se eliminaron **${count}** recuerdos de **${targetUser.displayName || targetUser.username}**.`
						: 'Ese usuario no tenía recuerdos guardados.',
					flags: 64,
				});
			}

			return interaction.reply({
				content: 'Debes indicar el `#id` del recuerdo o un `usuario` para borrar.',
				flags: 64,
			});
		}
	},
};
