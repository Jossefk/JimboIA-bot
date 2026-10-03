const { Events, EmbedBuilder } = require('discord.js');
const { activeGames } = require('../gameManager.js');
const { getHandValue, getHandString } = require('../utils/blackjackUtils.js');
const db = require('../database/db.js');

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {
		const client = interaction.client;

		// --- MANEJADOR PARA COMANDOS SLASH ---
		if (interaction.isChatInputCommand()) {
			const command = interaction.client.commands.get(interaction.commandName);

			if (!command) {
				console.error(`No command matching ${interaction.commandName} was found.`);
				return;
			}

			try {
				await command.execute(client, interaction);
			}
			catch (error) {
				console.error(error);
				if (interaction.replied || interaction.deferred) {
					await interaction.followUp({ content: 'Hubo un error balatreando este comando.', flags: 64 });
				}
				else {
					await interaction.reply({ content: 'Hubo un error balatreando este comando.', flags: 64 });
				}
			}
			return;
		}

		// --- MANEJADOR PARA BOTONES DE BLACKJACK ---
		if (interaction.isButton() && interaction.customId.startsWith('blackjack')) {
			const [, subAction, userId] = interaction.customId.split('_');

			if (interaction.user.id !== userId) {
				return interaction.reply({ content: 'No puedes meter mano en la partida de otra persona.', flags: 64 });
			}

			const game = activeGames.get(userId);
			if (!game) {
				await interaction.update({ content: 'Esta partida de Blackjack ya finalizó o expiró.', components: [] });
				return;
			}

			const bet = game.bet || 50;

			// --- Lógica del botón "Pedir Carta (Hit)" ---
			if (subAction === 'hit') {
				game.playerHand.push(game.deck.pop());
				game.playerValue = getHandValue(game.playerHand);

				// Si el jugador se pasa de 21, pierde
				if (game.playerValue > 21) {
					const updatedUser = db.recordGameResult(userId, false, -bet);
					db.adjustAffinity(userId, -1);

					if (updatedUser.chips === 0) {
						db.addMemory(userId, interaction.guildId, 'quiebra', 'Quedó en bancarrota total jugando Blackjack contra Jimbo', 3);
					}

					const embed = new EmbedBuilder()
						.setColor(0xFF0000)
						.setTitle('💥 ¡Te pasaste de 21! Has perdido.')
						.setDescription(`Perdiste **${bet} fichas** 🪙. Saldo actual: **${updatedUser.chips} fichas**.`)
						.addFields(
							{ name: `Mano de Jimbo (${getHandValue(game.dealerHand)})`, value: getHandString(game.dealerHand), inline: true },
							{ name: `Tu Mano (${game.playerValue})`, value: getHandString(game.playerHand), inline: true },
						)
						.setFooter({ text: updatedUser.chips === 0 ? '¡Estás en la quiebra absoluta!' : '¡Mejor suerte en la próxima mano!' });

					await interaction.update({ embeds: [embed], components: [] });
					activeGames.delete(userId);
					return;
				}

				// Si no, actualizamos el embed con la nueva mano del jugador
				const embed = new EmbedBuilder()
					.setColor(0x0099FF)
					.setTitle('♠️ Partida de Blackjack Balatriana ♦️')
					.setDescription(`💰 **Apuesta en juego:** ${bet} fichas`)
					.addFields(
						{ name: '🃏 Mano de Jimbo', value: getHandString(game.dealerHand, true), inline: true },
						{ name: `🎴 Tu Mano (${game.playerValue})`, value: getHandString(game.playerHand), inline: true },
					)
					.setFooter({ text: `Turno de ${interaction.user.displayName}` });

				await interaction.update({ embeds: [embed] });
			}

			// --- Lógica del botón "Plantarse (Stand)" ---
			if (subAction === 'stand') {
				let dealerValue = getHandValue(game.dealerHand);
				while (dealerValue < 18) {
					game.dealerHand.push(game.deck.pop());
					dealerValue = getHandValue(game.dealerHand);
				}

				const playerValue = getHandValue(game.playerHand);
				let resultMessage = '';
				let color = 0x808080;
				let deltaChips = 0;
				let won = false;

				if (dealerValue > 21 || playerValue > dealerValue) {
					resultMessage = '🎉 ¡Balatraciones, has ganado!';
					color = 0x00FF00;
					deltaChips = bet;
					won = true;
				}
				else if (playerValue < dealerValue) {
					resultMessage = '💀 ¡Jimbo Gana, no le sabes al Balatreo!';
					color = 0xFF0000;
					deltaChips = -bet;
					won = false;
				}
				else {
					resultMessage = '⚖️ ¡Es un empate! Recuperas tu apuesta.';
					deltaChips = 0;
				}

				let updatedUser;
				if (deltaChips !== 0) {
					updatedUser = db.recordGameResult(userId, won, deltaChips);
					db.adjustAffinity(userId, won ? 2 : -1);

					if (won && bet >= 150) {
						db.addMemory(userId, interaction.guildId, 'victoria', `Ganó una apuesta fuerte de ${bet} fichas en Blackjack`, 2);
					}
					else if (!won && updatedUser.chips === 0) {
						db.addMemory(userId, interaction.guildId, 'quiebra', 'Quedó en bancarrota total jugando Blackjack contra Jimbo', 3);
					}
				}
				else {
					updatedUser = db.getOrCreateUser(userId, interaction.user.username);
				}

				const chipsFeedback = deltaChips > 0
					? `¡Ganaste **+${deltaChips} fichas**! 🪙`
					: deltaChips < 0
						? `Perdiste **${Math.abs(deltaChips)} fichas** 🪙.`
						: 'No ganas ni pierdes fichas.';

				const embed = new EmbedBuilder()
					.setColor(color)
					.setTitle(resultMessage)
					.setDescription(`${chipsFeedback}\nSaldo actual: **${updatedUser.chips} fichas**.`)
					.addFields(
						{ name: `🃏 Mano de Jimbo (${dealerValue})`, value: getHandString(game.dealerHand), inline: true },
						{ name: `🎴 Tu Mano (${playerValue})`, value: getHandString(game.playerHand), inline: true },
					)
					.setFooter({ text: `Afinidad con Jimbo: ${updatedUser.affinity}` });

				await interaction.update({ embeds: [embed], components: [] });
				activeGames.delete(userId);
			}
		}
	},
};
