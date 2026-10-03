const { Events } = require('discord.js');
const db = require('../database/db.js');
const { generateJimboResponse, splitDiscordMessage } = require('../services/geminiService.js');
const { chimeInRate: defaultChimeRate } = require('../config.js');

// Palabras clave que llaman la atención de Jimbo
const JIMBO_DIRECT_KEYWORDS = ['jimbo', 'jimbot'];
const BALATRO_KEYWORDS = ['balatro', 'joker', 'ludopata', 'ludopatia', 'apuesta', 'apostar', 'blackjack', 'poker', 'ciega grande', 'tarot'];
const REACTION_EMOJIS = ['🃏', '🎰', '💸', '🎲', '👀', '💀', '🔥'];

// Cooldown ligero por canal para evitar spam descontrolado de respuestas automáticas
const channelCooldowns = new Map();

module.exports = {
	name: Events.MessageCreate,
	async execute(message) {
		// Ignorar mensajes de otros bots (o de sí mismo)
		if (message.author.bot) return;

		// Solo procesar si hay contenido o adjuntos
		if (!message.content && message.attachments.size === 0) return;

		const clientUser = message.client.user;
		const contentLower = message.content.toLowerCase();

		// Registrar o actualizar al usuario en la base de datos SQLite
		const displayName = message.member?.displayName || message.author.displayName || message.author.username;
		const user = db.getOrCreateUser(message.author.id, message.author.username, displayName);

		// 1. Detectar si fue mencionado directamente
		const isDirectMention = message.mentions.users.has(clientUser.id);

		// 2. Detectar si es una respuesta (Reply) a un mensaje previo de Jimbo
		let isReplyToJimbo = false;
		if (message.reference && message.reference.messageId) {
			try {
				const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
				if (referencedMessage && referencedMessage.author.id === clientUser.id) {
					isReplyToJimbo = true;
				}
			}
			catch {
				// Ignorar error al buscar mensaje referenciado
			}
		}

		// 3. Detectar si llaman a Jimbo por su nombre
		const mentionsName = JIMBO_DIRECT_KEYWORDS.some(kw => contentLower.includes(kw));

		// 4. Detectar si hablan de temas favoritos de Jimbo (Balatro / apuestas)
		const mentionsBalatro = BALATRO_KEYWORDS.some(kw => contentLower.includes(kw));

		// Obtener configuración del servidor
		const serverSettings = message.guildId ? db.getServerSettings(message.guildId) : null;
		const allowedChannels = serverSettings?.allowed_channels || [];

		// Si hay canales restringidos y este no está en la lista, solo responder si fue mencionado directamente
		if (allowedChannels.length > 0 && !allowedChannels.includes(message.channelId) && !isDirectMention && !isReplyToJimbo) {
			return;
		}

		// Determinar si Jimbo debe responder o intervenir
		let shouldRespond = false;
		let isSpontaneous = false;

		if (isDirectMention || isReplyToJimbo) {
			// Si le hablan directamente a él, responde siempre
			shouldRespond = true;
		}
		else if (mentionsName) {
			// Si mencionan su nombre en el chat, 80% de probabilidad de responder
			shouldRespond = Math.random() < 0.8;
		}
		else if (mentionsBalatro) {
			// Si hablan de Balatro o apuestas, 35% de probabilidad de meterse en la conversación
			shouldRespond = Math.random() < 0.35;
			isSpontaneous = true;
		}
		else {
			// Intervención espontánea aleatoria (Chime-in) en la conversación del día a día
			const effectiveChimeRate = serverSettings?.chime_in_rate || defaultChimeRate || 0.03;
			shouldRespond = Math.random() < effectiveChimeRate;
			isSpontaneous = true;
		}

		// Comportamiento de "persona real": A veces reacciona con emojis en vez de escribir un mensaje
		if (!shouldRespond && (mentionsBalatro || Math.random() < 0.04)) {
			try {
				const randomEmoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
				await message.react(randomEmoji);
			}
			catch {
				// Permiso de reacción faltante o error menor
			}
			return;
		}

		if (!shouldRespond) return;

		// Respetar cooldown por canal si la respuesta es espontánea para no saturar
		if (isSpontaneous) {
			const now = Date.now();
			const lastResponse = channelCooldowns.get(message.channelId) || 0;
			if (now - lastResponse < 35_000) {
				// Si respondió hace menos de 35 segundos de forma espontánea, no spammear
				return;
			}
			channelCooldowns.set(message.channelId, now);
		}

		// Limpiar la mención al bot del texto del mensaje para no confundir a la IA
		let cleanUserMessage = message.content.replace(new RegExp(`<@!?${clientUser.id}>`, 'g'), '').trim();
		if (!cleanUserMessage && message.attachments.size > 0) {
			const hasAudio = Array.from(message.attachments.values()).some(a =>
				(a.contentType && a.contentType.startsWith('audio/')) ||
				(a.name && (a.name.endsWith('.ogg') || a.name.endsWith('.mp3') || a.name.endsWith('.wav'))),
			);
			cleanUserMessage = hasAudio
				? 'Escucha atentamente esta nota de voz o audio que te acabo de mandar y respóndeme con tu estilo.'
				: '¿Qué opinas de esta foto que acabo de mandar?';
		}

		try {
			// Simular que una persona real está escribiendo
			await message.channel.sendTyping();

			// Obtener los últimos 10 mensajes del canal para tener contexto de la conversación
			let contextMessages = [];
			try {
				const fetchedMessages = await message.channel.messages.fetch({ limit: 12 });
				contextMessages = fetchedMessages
					.filter(m => m.id !== message.id && m.content)
					.reverse()
					.map(m => ({
						author: m.member?.displayName || m.author.displayName || m.author.username,
						content: m.content,
					}));
			}
			catch (fetchErr) {
				console.error('Error obteniendo mensajes recientes del canal:', fetchErr);
			}

			// Extraer adjuntos si hay imágenes o audios
			const attachments = Array.from(message.attachments.values());

			// Generar respuesta con Gemini y el cerebro de SQLite
			const responseText = await generateJimboResponse({
				user,
				guildName: message.guild?.name || 'Servidor',
				channelName: message.channel?.name || 'chat',
				channelId: message.channelId,
				guildId: message.guildId,
				contextMessages,
				userMessage: cleanUserMessage,
				attachments,
				isSerious: false,
			});

			// Simular un pequeño retardo humano proporcional antes de mandar el mensaje (entre 1s y 2.5s)
			const delay = Math.min(2500, Math.max(1000, responseText.length * 15));
			await new Promise(resolve => setTimeout(resolve, delay));

			// Dividir en caso de exceder el límite de 2000 caracteres de Discord
			const messageChunks = splitDiscordMessage(responseText);

			for (let i = 0; i < messageChunks.length; i++) {
				if (i === 0 && (isDirectMention || isReplyToJimbo)) {
					// Responder citando el mensaje del usuario si fue directo
					await message.reply({ content: messageChunks[i], allowedMentions: { repliedUser: false } });
				}
				else {
					await message.channel.send(messageChunks[i]);
				}
			}

			// Actualizar marca de tiempo de actividad del canal
			channelCooldowns.set(message.channelId, Date.now());
		}
		catch (error) {
			console.error('[messageCreate] Error al generar respuesta de Jimbo:', error);
			if (isDirectMention || isReplyToJimbo) {
				await message.reply({
					content: '🃏 ¡Naguará, se me cayeron las cartas al piso! Me dio un error balatreando la respuesta, intenta de nuevo en un ratico.',
					allowedMentions: { repliedUser: false },
				});
			}
		}
	},
};
