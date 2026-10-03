// commands/utility/blackjack.js

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { activeGames } = require('../../gameManager.js');
const { createDeck, shuffleDeck, getHandValue, getHandString } = require('../../utils/blackjackUtils.js');
const db = require('../../database/db.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('blackjack')
		.setDescription('Inicia una partida de Blackjack con fichas contra Jimbo.')
		.addIntegerOption(option =>
			option
				.setName('apuesta')
				.setDescription('Cantidad de fichas a apostar (mínimo 10, por defecto 50).')
				.setMinValue(10)
				.setRequired(false),
		),

	async execute(client, interaction) {
		const userId = interaction.user.id;
		const displayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;

		// Obtener o registrar usuario en SQLite
		let user = db.getOrCreateUser(userId, interaction.user.username, displayName);

		// Si el usuario está quebrado (0 fichas), Jimbo le da un rescate
		if (user.chips < 10) {
			db.addChips(userId, 100);
			db.addMemory(userId, interaction.guildId, 'deuda', 'Jimbo le dio un préstamo de cortesía de 100 fichas porque quedó en la ruina', 2);
			user = db.getOrCreateUser(userId, interaction.user.username, displayName);
			await interaction.channel.send(`💸 **¡Auxilio de la Casa!** Jimbo vio que <@${userId}> estaba pelando bolas con 0 fichas y le prestó **100 fichas de cortesía** para que siga balatreando.`);
		}

		// Determinar monto de apuesta
		const inputBet = interaction.options.getInteger('apuesta') || 50;
		if (inputBet > user.chips) {
			return interaction.reply({
				content: `🃏 ¡Epa loco! Estás apostando **${inputBet} fichas** pero solo tienes **${user.chips} fichas**. Ajusta la apuesta o no hay trato.`,
				flags: 64,
			});
		}

		const bet = inputBet;

		// Evitar que un usuario tenga múltiples partidas activas
		if (activeGames.has(userId)) {
			return interaction.reply({ content: 'Ya tienes una partida de Blackjack en curso. ¡Termínala primero antes de tirar más cartas!', flags: 64 });
		}

		// --- Configuración Inicial del Juego ---
		const deck = shuffleDeck(createDeck());
		const playerHand = [deck.pop(), deck.pop()];
		const dealerHand = [deck.pop(), deck.pop()];

		const game = {
			deck,
			playerHand,
			dealerHand,
			playerValue: getHandValue(playerHand),
			dealerValue: getHandValue(dealerHand),
			bet,
			gameOver: false,
		};

		// Guardar la partida en nuestro gestor de estado
		activeGames.set(userId, game);

		// --- Crear la Interfaz en Discord ---
		const createGameEmbed = () => {
			return new EmbedBuilder()
				.setColor(0x0099FF)
				.setTitle('♠️ Partida de Blackjack Balatriana ♦️')
				.setDescription(`💰 **Apuesta en juego:** ${bet} fichas (Saldo: ${user.chips} fichas)`)
				.addFields(
					{ name: '🃏 Mano de Jimbo', value: getHandString(dealerHand, true), inline: true },
					{ name: `🎴 Tu Mano (${getHandValue(playerHand)})`, value: getHandString(playerHand), inline: true },
				)
				.setFooter({ text: `Turno de ${displayName} | ¡A balatrear!` });
		};

		const buttons = new ActionRowBuilder()
			.addComponents(
				new ButtonBuilder()
					.setCustomId(`blackjack_hit_${userId}`)
					.setLabel('Pedir Carta (Hit)')
					.setStyle(ButtonStyle.Success)
					.setEmoji('➕'),
				new ButtonBuilder()
					.setCustomId(`blackjack_stand_${userId}`)
					.setLabel('Plantarse (Stand)')
					.setStyle(ButtonStyle.Danger)
					.setEmoji('✋'),
			);

		await interaction.reply({ embeds: [createGameEmbed()], components: [buttons] });
	},
};