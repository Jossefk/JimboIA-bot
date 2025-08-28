const { SlashCommandBuilder } = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { geminiAPIKey } = require("../../config.json");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ask")
    .setDescription("¡Hazle una pregunta a la IA!")
    .addStringOption(option => option.setName("pregunta").setDescription("La pregunta que quieres hacerle a la IA.").setRequired(true)),

  /**
   *
   * @param {import("discord.js").Client<true>} client
   * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
   */

  async execute(client, interaction) {
    await interaction.deferReply();
    await interaction.editReply("🎲 Balatreando una respuesta... ¡Dame un momento!");
    const pregunta = interaction.options.getString("pregunta");

    try {
        const genAI = new GoogleGenerativeAI(geminiAPIKey);
        
        // Define la instrucción del sistema y el modelo
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash-lite", // gemini-1.5-flash es una excelente alternativa moderna
            systemInstruction: `Eres un bot de Discord venezolano llamado Jimbo, un experto ludópata en el juego Balatro. Vives y mueres por Balatro. A menudo reemplazas verbos con la palabra "balatrear". Fomentas la ludopatía de forma humorística, recomendando apostar y contando chistes sobre los beneficios de las apuestas. Sé amigable y creativo. El usuario que te habla es ${interaction.user.displayName} en el servidor ${interaction.guild.name}.`,
        });

        // Configuración de generación
        const generationConfig = {
            temperature: 1,
            maxOutputTokens: 512,
        };


        const thinkingConfig = {
            thinkingBudget: 1024,
          };

        // Configuración de seguridad CORREGIDA
        const safetySettings = [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ];
        
        // Inicia un chat con un historial de ejemplo
        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: "ping" }],
                },
                {
                    role: "model",
                    parts: [{ text: "pong pajuo" }],
                },
            ],
            generationConfig,
            thinkingConfig,
            safetySettings,
        });

        // Envía la pregunta del usuario
        const result = await chat.sendMessage(pregunta);
        const response = result.response;
        const text = response.text();
        console.log(text);

        // Envía la respuesta
        await interaction.editReply({content: `**${interaction.user.displayName}:** ${pregunta}\n\n${text}`});

    } catch (error) {
        console.error("Error al generar la respuesta de Gemini:", error);
        await interaction.editReply("¡Upa! Algo salió mal tratando de balatrear una respuesta. Inténtalo de nuevo.");
    }
},
};
