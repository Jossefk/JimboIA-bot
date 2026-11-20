const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../../database/db.js');
const { LIMBO_ITEMS, findLimboItem } = require('../../utils/limboCatalog.js');

const itemChoices = LIMBO_ITEMS.map(item => ({
	name: `${item.name} (${item.price} 🪙)`,
	value: item.key,
}));

module.exports = {
	data: new SlashCommandBuilder()
		.setName('tienda')
		.setDescription('Puesto clandestino de Jimbo en el Limbo: pociones chimbas, empanadas y reliquias.')
		.addSubcommand(sub =>
			sub
				.setName('ver')
				.setDescription('Mira la mercancía dudosa que Jimbo vende hoy por debajo de la mesa.'),
		)
		.addSubcommand(sub =>
			sub
				.setName('comprar')
				.setDescription('Cómprale una poción, empanada o reliquia a Jimbo con tus fichas.')
				.addStringOption(opt =>
					opt
						.setName('item')
						.setDescription('Producto del catálogo clandestino.')
						.setRequired(true)
						.addChoices(...itemChoices),
				),
		)
		.addSubcommand(sub =>
			sub
				.setName('mochila')
				.setDescription('Revisa qué porquerías del Limbo cargas en tu mochila.')
				.addUserOption(opt =>
					opt
						.setName('usuario')
						.setDescription('Usuario cuya mochila quieres revisar (opcional).')
						.setRequired(false),
				),
		)
		.addSubcommand(sub =>
			sub
				.setName('usar')
				.setDescription('Consume o activa un producto de tu mochila del Limbo.')
				.addStringOption(opt =>
					opt
						.setName('item')
						.setDescription('Producto que deseas consumir.')
						.setRequired(true)
						.addChoices(...itemChoices),
				),
		),

	/**
	 * @param {import("discord.js").Client<true>} client
	 * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
	 */
	async execute(client, interaction) {
		const sub = interaction.options.getSubcommand();
		const displayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
		const userRecord = db.getOrCreateUser(interaction.user.id, interaction.user.username, displayName, interaction.guildId);

		if (sub === 'ver') {
			const catalogText = LIMBO_ITEMS
				.map(item => `• **${item.name}** — \`${item.price} 🪙\`\n  _${item.effect}_`)
				.join('\n');

			const embed = new EmbedBuilder()
				.setColor(0x2B2D31)
				.setTitle('🧪 Puesto Clandestino de Jimbo en el Limbo')
				.setDescription(`_Pssst... acércate a la barra, viajero. Sin garantías ni devoluciones._\n\n${catalogText}`)
				.setFooter({ text: `Tu saldo actual: ${userRecord.chips} fichas 🪙 | Usa /tienda comprar` });

			return interaction.reply({ embeds: [embed] });
		}

		if (sub === 'comprar') {
			const itemKey = interaction.options.getString('item');
			const item = findLimboItem(itemKey);
			if (!item) {
				return interaction.reply({ content: 'Esa vaina no la vendo aquí, chamo.', flags: 64 });
			}

			if (userRecord.chips < item.price) {
				return interaction.reply({
					content: `🕯️ Pssst... **${item.name}** cuesta **${item.price} fichas**, y apenas cargas **${userRecord.chips}**. Consigue fichas en \`/blackjack\` o pide un contrato diario antes de venir a fiar.`,
					flags: 64,
				});
			}

			const nuevoSaldo = db.addChips(interaction.user.id, -item.price);
			db.addInventoryItem(interaction.user.id, item.key, item.name, item.effect, 1);

			return interaction.reply({
				content: `🧪 Trato hecho, **${displayName}**. Te llevas **${item.name}** por **${item.price} fichas**.\n_${item.effect}_\nSaldo restante: **${nuevoSaldo} fichas** 🪙.`,
			});
		}

		if (sub === 'mochila') {
			const targetUser = interaction.options.getUser('usuario') || interaction.user;
			const member = interaction.guild
				? await interaction.guild.members.fetch(targetUser.id).catch(() => null)
				: null;
			const targetDisplay = member?.displayName || targetUser.displayName || targetUser.username;
			db.getOrCreateUser(targetUser.id, targetUser.username, targetDisplay, interaction.guildId);

			const inventory = db.getUserInventory(targetUser.id, 15);
			const invText = inventory.length > 0
				? inventory.map(i => `• **${i.item_name}** \`x${i.quantity}\`\n  _${i.item_effect}_`).join('\n')
				: '_Mochila vacía. Puro aire y deudas del Limbo._';

			const embed = new EmbedBuilder()
				.setColor(0x2B2D31)
				.setAuthor({ name: `Mochila de ${targetDisplay}`, iconURL: targetUser.displayAvatarURL() })
				.setTitle('🎒 Mercancía Encaletada')
				.setDescription(invText)
				.setFooter({ text: 'Usa /tienda usar para consumir algún producto.' });

			return interaction.reply({ embeds: [embed] });
		}

		if (sub === 'usar') {
			const itemKey = interaction.options.getString('item');
			const item = findLimboItem(itemKey);
			if (!item) {
				return interaction.reply({ content: 'Producto no reconocido.', flags: 64 });
			}

			const consumed = db.consumeInventoryItem(interaction.user.id, item.key);
			if (!consumed) {
				return interaction.reply({
					content: `No tienes **${item.name}** en tu mochila. Cómprala primero en \`/tienda comprar\`.`,
					flags: 64,
				});
			}

			return interaction.reply({
				content: `🥟 **${displayName}** se echó **${consumed.item_name}**.\n_${consumed.item_effect}_\n(Te quedan \`x${consumed.remaining}\` en la mochila).`,
			});
		}
	},
};
