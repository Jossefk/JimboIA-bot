// commands/games/blackjack.js

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { activeGames } = require('../../gameManager.js'); // Importaremos esto más tarde
const { createDeck, shuffleDeck, getHandValue, getHandString } = require('../../utils/blackjackUtils.js'); // Y esto también

module.exports = {
    data: new SlashCommandBuilder()
        .setName('blackjack')
        .setDescription('Inicia una partida de Blackjack contra Jimbo.'),

    async execute(client, interaction) {
        const userId = interaction.user.id;

        // Evitar que un usuario tenga múltiples partidas activas
        if (activeGames.has(userId)) {
            return interaction.reply({ content: 'Ya tienes una partida de Blackjack en curso. ¡Termínala primero!', ephemeral: true });
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
            gameOver: false,
        };

        // Guardar la partida en nuestro gestor de estado
        activeGames.set(userId, game);

        // --- Crear la Interfaz en Discord ---
        const createGameEmbed = () => {
            return new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('♠️ Partida de Blackjack ♦️')
                .addFields(
                    { name: `Mano de Jimbo`, value: getHandString(dealerHand, true) },
                    { name: `Tu Mano (${getHandValue(playerHand)})`, value: getHandString(playerHand) }
                )
                .setFooter({ text: `Turno de ${interaction.user.displayName}` });
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
                    .setEmoji('✋')
            );
            
        // Comprobar si hay Blackjack inicial
        if (game.playerValue === 21) {
            // Lógica de finalización si el jugador tiene Blackjack
            // (La dejaremos para el manejador de botones para simplificar)
        }

        await interaction.reply({ embeds: [createGameEmbed()], components: [buttons] });
    },
};