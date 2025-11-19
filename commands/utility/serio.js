const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { geminiAPIKey } = require('../../config.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('serio')
		.setDescription('¡Hazle una pregunta a la IA!')
		.addStringOption(option => option.setName('pregunta').setDescription('La pregunta que quieres hacerle a la IA.').setRequired(true)),

	/**
   *
   * @param {import("discord.js").Client<true>} client
   * @param {import("discord.js").ChatInputCommandInteraction<"cached">} interaction
   */

	async execute(client, interaction) {
		await interaction.deferReply();
		await interaction.editReply('Creando una respuesta... ¡Dame un momento!');
		const pregunta = interaction.options.getString('pregunta');

		try {
			const genAI = new GoogleGenerativeAI(geminiAPIKey);

			// Define la instrucción del sistema y el modelo
			const model = genAI.getGenerativeModel({
				model: 'gemini-2.5-flash',
				systemInstruction: `Eres un bot de Discord venezolano llamado Jimbo. Sé amigable, serio, refinado y creativo. El usuario que te habla es ${interaction.user.displayName} en el servidor ${interaction.guild.name}.`,
			});

			// Configuración de generación
			const generationConfig = {
				temperature: 1,
				maxOutputTokens: 2048,
			};

			// Herramientas (Tools) - Se agrega Google Search
			const tools = [{
				googleSearch: {},
			}];

			// Configuración de seguridad
			const safetySettings = [
				{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
				{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
				{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
				{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
			];

			// Inicia un chat con la configuración y herramientas
			const chat = model.startChat({
				generationConfig,
				safetySettings,
				tools, // Se pasan las herramientas aquí
			});

			// Envía la pregunta del usuario
			const result = await chat.sendMessage(pregunta);
			const response = result.response;
			const text = response.text();
			console.log(text);

			// Borra el mensaje de "pensando..." que se mostró al principio.
			await interaction.deleteReply();

			// Crea el embed con la respuesta, similar al de /resumen.
			const responseEmbed = new EmbedBuilder()
				.setColor(0x0099FF)
				.setAuthor({ name: `Pregunta de ${interaction.user.displayName}`, iconURL: interaction.user.displayAvatarURL() })
				.setTitle('Jimbo se puso serio y te respondio:')
				.addFields({ name: 'Tu pregunta fue:', value: pregunta })
				.setDescription(text)
				.setTimestamp()
				.setFooter({ text: 'Jimbo serio' });

			// Envía el embed como un mensaje completamente nuevo en el canal.
			await interaction.channel.send({ embeds: [responseEmbed] });

		}
		catch (error) {
			console.error('Error al generar la respuesta de Gemini:', error);
			await interaction.editReply('¡Oops! Algo a salido mal ', error);
		}
	},
};
