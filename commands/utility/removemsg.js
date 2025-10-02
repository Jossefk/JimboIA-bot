const { SlashCommandBuilder } = require('discord.js');
const usuarioPermitido = '217632647294222336';


module.exports = {
    data: new SlashCommandBuilder()
        .setName('removemsg')
        .setDescription('Elimina mensajes de un canal que son más nuevos que un tiempo determinado en minutos.')
        .addIntegerOption(option =>
            option.setName('tiempo')
                .setDescription('El tiempo en minutos hacia atrás para eliminar mensajes.')
                .setRequired(true)),

    /**
     * @param {import("discord.js").Client<true>} client
     * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
     */
    async execute(client, interaction) {
        if (interaction.user.id !== usuarioPermitido) {
            return interaction.reply({ content: 'No tienes permiso para usar este comando.', flags: 64 });
        }

        const minutes = interaction.options.getInteger('tiempo');
        const timeAgo = Date.now() - (minutes * 60 * 1000);

        await interaction.deferReply({ flags: 64 });

        try {
            const messages = await interaction.channel.messages.fetch({ limit: 100 });
            const messagesToDelete = messages.filter(m => m.createdTimestamp > timeAgo);

            if (messagesToDelete.size === 0) {
                await interaction.editReply('No hay mensajes para eliminar en el período de tiempo especificado.');
                return;
            }

            await interaction.channel.bulkDelete(messagesToDelete, true);
            await interaction.editReply(`Se eliminaron ${messagesToDelete.size} mensajes.`);
        } catch (error) {
            console.error('Error al eliminar mensajes:', error);
            await interaction.editReply('Ocurrió un error al intentar eliminar los mensajes.');
        }
    },
};
