const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const geminiAPIKey = process.env.GEMINI_API_KEY;

// Configuración de la API de Gemini
const genAI = new GoogleGenerativeAI(geminiAPIKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });


module.exports = {
    data: new SlashCommandBuilder()
        .setName('resumen')
        .setDescription('Genera un resumen del chat utilizando IA.'),

    async execute(client, interaction) {
        // --- Creación de los Botones ---
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('summary_day')
                    .setLabel('Del día')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('summary_24h')
                    .setLabel('Últimas 24 horas')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('summary_1h')
                    .setLabel('Última hora')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('summary_custom')
                    .setLabel('Personalizado')
                    .setStyle(ButtonStyle.Secondary),
            );

        // --- Envío del mensaje inicial con los botones ---
        const response = await interaction.reply({
            content: 'Selecciona el período de tiempo para el resumen del chat:',
            components: [row],
            flags: 64, // Para que solo el usuario que ejecutó el comando lo vea
        });

        // --- Colector para escuchar la interacción con los botones ---
        // Filtramos para que solo el usuario original pueda interactuar
        const collectorFilter = i => i.user.id === interaction.user.id;
        const collector = response.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: collectorFilter,
            time: 60_000 // El colector estará activo por 60 segundos
        });

        collector.on('collect', async i => {
            let hoursToFetch;

            // --- Lógica para la opción "Personalizado" ---
            if (i.customId === 'summary_custom') {
                await i.update({ content: 'Por favor, envía un mensaje con el número de horas que quieres resumir (ej. `3`).', components: [] });

                const messageCollector = interaction.channel.createMessageCollector({
                    filter: m => m.author.id === interaction.user.id,
                    time: 30_000, // El usuario tiene 30 segundos para responder
                    max: 1,
                });

                messageCollector.on('collect', async msg => {
                    const parsedHours = parseInt(msg.content);
                    if (isNaN(parsedHours) || parsedHours <= 0) {
                        await msg.reply('Número inválido. Por favor, intenta de nuevo con el comando `/resumen`.');
                        return;
                    }
                    await msg.delete(); // Borramos el mensaje del usuario con el número
                    await i.editReply({ content: `Generando resumen de las últimas ${parsedHours} horas...`, components: [] });
                    await generateSummary(i, parsedHours);
                });

                messageCollector.on('end', collected => {
                    if (collected.size === 0) {
                        i.editReply({ content: 'No recibí una respuesta. Por favor, intenta de nuevo.', components: [] });
                    }
                });
                return; // Salimos para no ejecutar el resto del código
            }

            // --- Determinar las horas a buscar según el botón presionado ---
            switch (i.customId) {
                case 'summary_day':
                    const now = new Date();
                    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    hoursToFetch = (now - startOfDay) / 3600000; // Horas desde la medianoche
                    break;
                case 'summary_24h':
                    hoursToFetch = 24;
                    break;
                case 'summary_1h':
                    hoursToFetch = 1;
                    break;
            }
            const userDisplayName = interaction.user.displayName;
            // --- Mensaje de espera y llamada a la función principal ---
            await i.update({ content: `Generando resumen de las últimas ${Math.round(hoursToFetch)} horas...`, components: [] });
            await generateSummary(i, hoursToFetch, userDisplayName);
        });
    },
};

// --- Función Principal para Generar el Resumen ---
async function generateSummary(interaction, hours, userDisplayName) {
    try {
        const channel = interaction.channel;
        const cutoffDate = new Date().getTime() - (hours * 60 * 60 * 1000);

        // --- Recopilación de mensajes ---
        const messages = await channel.messages.fetch({ limit: 100 });
        const filteredMessages = messages.filter(msg => msg.createdTimestamp > cutoffDate && !msg.author.bot);

        if (filteredMessages.size === 0) {
            await interaction.followUp({ content: 'No se encontraron mensajes en el período de tiempo seleccionado.', flags: 64 });
            return;
        }

        // --- Formateo del historial del chat ---
        const chatHistory = filteredMessages.map(msg => `${msg.author.username}: ${msg.content}`).reverse().join('\n');

        const prompt = `Eres un asistente de Discord experto en resumir conversaciones. Analiza el siguiente historial de chat y crea un resumen claro y conciso en español. Destaca los puntos más importantes, decisiones tomadas y temas de conversación principales. El resumen debe ser fácil de entender para alguien que no ha leído el chat.

Aquí está el historial del chat:
---
${chatHistory}
---

Genera el resumen.`;

        // --- Llamada a la API de Gemini ---
        const result = await model.generateContent(prompt);
        const summary = await result.response.text();

        // --- Creación y envío del Embed con el resumen ---
        const summaryEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`📜 Resumen del Chat - Últimas ${Math.round(hours)} horas`)
            .setDescription(summary)
            .setTimestamp()
            .setFooter({ text: `Resumen generado por ${userDisplayName}` });

        await interaction.followUp({ embeds: [summaryEmbed] });

    } catch (error) {
        console.error('Error generando el resumen:', error);
        await interaction.followUp({ content: 'Ocurrió un error al intentar generar el resumen. Revisa la consola para más detalles.', flags: 64 });
    }
}