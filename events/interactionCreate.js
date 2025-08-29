const { Events, EmbedBuilder } = require('discord.js');
const { activeGames } = require('../gameManager.js');
const { getHandValue, getHandString } = require('../utils/blackjackUtils.js');

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
            } catch (error) {
                console.error(error);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: 'Hubo un error balatreando este comando.', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'Hubo un error balatreando este comando.', ephemeral: true });
                }
            }
            return; // Detenemos la ejecución si era un comando
        }

        // --- MANEJADOR PARA BOTONES DE BLACKJACK ---
        if (interaction.isButton() && interaction.customId.startsWith('blackjack')) {
            // Desestructuramos el ID del botón: blackjack_accion_idDelUsuario
            const [action, subAction, userId] = interaction.customId.split('_');

            // Verificamos que el usuario que hace clic es quien inició la partida
            if (interaction.user.id !== userId) {
                return interaction.reply({ content: "No puedes interactuar en la partida de otra persona.", ephemeral: true });
            }

            const game = activeGames.get(userId);
            if (!game) {
                // Si la partida no existe, edita el mensaje para notificarlo y elimina los botones.
                await interaction.update({ content: 'Esta partida de Blackjack ha finalizado o expirado.', components: [] });
                return;
            }

            // --- Lógica del botón "Pedir Carta (Hit)" ---
            if (subAction === 'hit') {
                game.playerHand.push(game.deck.pop());
                game.playerValue = getHandValue(game.playerHand);

                // Si el jugador se pasa de 21, pierde
                if (game.playerValue > 21) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000) // Rojo
                        .setTitle('¡Te pasaste de 21! Has perdido.')
                        .addFields(
                            { name: `Mano de Jimbo (${getHandValue(game.dealerHand)})`, value: getHandString(game.dealerHand) },
                            { name: `Tu Mano (${game.playerValue})`, value: getHandString(game.playerHand) }
                        );
                    
                    await interaction.update({ embeds: [embed], components: [] }); // components: [] para eliminar los botones
                    activeGames.delete(userId); // Limpiamos la partida del gestor
                    return;
                }

                // Si no, actualizamos el embed con la nueva mano del jugador
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('♠️ Partida de Blackjack ♦️')
                    .addFields(
                        { name: `Mano de Jimbo`, value: getHandString(game.dealerHand, true) },
                        { name: `Tu Mano (${game.playerValue})`, value: getHandString(game.playerHand) }
                        
                    )
                    .setFooter({ text: `Turno de ${interaction.user.displayName}` });

                await interaction.update({ embeds: [embed] });
            }
            
            // --- Lógica del botón "Plantarse (Stand)" ---
            if (subAction === 'stand') {
                // Es el turno del crupier. Revela su carta y pide hasta llegar a 18 o más.
                let dealerValue = getHandValue(game.dealerHand);
                while (dealerValue < 18) {
                    game.dealerHand.push(game.deck.pop());
                    dealerValue = getHandValue(game.dealerHand);
                }

                // Determinamos el ganador
                const playerValue = getHandValue(game.playerHand);
                let resultMessage = '';
                let color = 0x808080; // Gris para empate

                if (dealerValue > 21 || playerValue > dealerValue) {
                    resultMessage = '¡Balatraciones, has ganado! 🥳';
                    color = 0x00FF00; // Verde
                } else if (playerValue < dealerValue) {
                    resultMessage = '¡Jimbo Gana, no le sabes al Balatreo! 😥';
                    color = 0xFF0000; // Rojo
                } else {
                    resultMessage = '¡Es un empate!';
                }
                
                const embed = new EmbedBuilder()
                    .setColor(color)
                    .setTitle(resultMessage)
                    .addFields(
                        { name: `Mano de Jimbo (${dealerValue})`, value: getHandString(game.dealerHand) },
                        { name: `Tu Mano (${playerValue})`, value: getHandString(game.playerHand) }
                    );

                await interaction.update({ embeds: [embed], components: [] }); // Actualiza el mensaje final y quita los botones
                activeGames.delete(userId); // Limpiamos la partida
            }
        }
    },
};
