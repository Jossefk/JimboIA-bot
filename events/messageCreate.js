const { Events } = require('discord.js');
const db = require('../database/db.js');
const { generateJimboResponse, splitDiscordMessage } = require('../services/geminiService.js');
const { chimeInRate: defaultChimeRate } = require('../config.js');

// Palabras clave que llaman la atención de Jimbo
const JIMBO_DIRECT_KEYWORDS = ['jimbo', 'jimbot'];
const BALATRO_KEYWORDS = ['balatro', 'joker', 'blackjack'];
const REACTION_EMOJIS = ['💀', '🔥', '👀', '🃏', '🎰'];

// Cooldown ligero por canal para evitar spam de respuestas espontáneas
const channelCooldowns = new Map();

/**
 * Extrae adjuntos de imagen/audio tanto de message.attachments como de embeds de imagen
 */
function extractMediaFromMessage(msg) {
	if (!msg) return [];
	const items = [];

	if (msg.attachments && msg.attachments.size > 0) {
		for (const att of msg.attachments.values()) {
			items.push({
				url: att.url,
				name: att.name || '',
				contentType: att.contentType || '',
				size: att.size || 0,
			});
		}
	}

	if (msg.embeds && msg.embeds.length > 0) {
		for (const emb of msg.embeds) {
			const imgUrl = emb.image?.url || (emb.data?.type === 'image' ? emb.thumbnail?.url || emb.url : null);
			if (imgUrl && !items.some(i => i.url === imgUrl)) {
				items.push({
					url: imgUrl,
					name: imgUrl.split('?')[0].split('/').pop() || 'embed.png',
					contentType: 'image/png',
					size: 0,
				});
			}
		}
	}

	return items;
}

/**
 * Limpia menciones <@id> reemplazándolas por nombres legibles para el modelo
 */
function formatReadableContent(msg, botUserId = null) {
	if (!msg) return '';
	let text = msg.content || '';

	if (botUserId) {
		text = text.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
	}

	if (msg.mentions?.users?.size > 0) {
		for (const [id, u] of msg.mentions.users.entries()) {
			if (id === botUserId) continue;
			const member = msg.guild?.members?.cache?.get(id);
			const readable = member?.displayName || u.displayName || u.username;
			text = text.replace(new RegExp(`<@!?${id}>`, 'g'), `@${readable}`);
		}
	}

	return text.trim();
}

module.exports = {
	name: Events.MessageCreate,
	extractMediaFromMessage,
	formatReadableContent,
	async execute(message) {
		// Ignorar mensajes de otros bots (o de sí mismo)
		if (message.author.bot) return;

		const directMedia = extractMediaFromMessage(message);

		// Solo procesar si hay texto o archivos multimedia
		if (!message.content && directMedia.length === 0) return;

		const clientUser = message.client.user;
		const contentLower = (message.content || '').toLowerCase();

		// Registrar o actualizar al usuario en la base de datos SQLite
		const displayName = message.member?.displayName || message.author.displayName || message.author.username;
		const user = db.getOrCreateUser(message.author.id, message.author.username, displayName);

		// 1. Detectar si fue mencionado directamente
		const isDirectMention = message.mentions.users.has(clientUser.id);

		// 2. Detectar si es una respuesta (Reply) a un mensaje previo (de Jimbo o de otro usuario)
		let isReplyToJimbo = false;
		let referencedMsgObj = null;
		let referencedContext = null;

		if (message.reference && message.reference.messageId) {
			try {
				referencedMsgObj = await message.channel.messages.fetch(message.reference.messageId);
				if (referencedMsgObj) {
					if (referencedMsgObj.author.id === clientUser.id) {
						isReplyToJimbo = true;
					}
					const refAuthor = referencedMsgObj.member?.displayName
						|| referencedMsgObj.author?.displayName
						|| referencedMsgObj.author?.username
						|| 'Usuario';
					const refText = formatReadableContent(referencedMsgObj);
					const refMedia = extractMediaFromMessage(referencedMsgObj);
					const mediaNote = refMedia.length > 0 ? ' [Adjunto multimedia]' : '';
					referencedContext = {
						author: refAuthor,
						content: `${refText}${mediaNote}`.trim() || '[Adjunto multimedia]',
					};
				}
			}
			catch {
				// Ignorar error al buscar mensaje referenciado
			}
		}

		// 3. Detectar si llaman a Jimbo por su nombre
		const mentionsName = JIMBO_DIRECT_KEYWORDS.some(kw => contentLower.includes(kw));

		// 4. Detectar si hablan de Balatro
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
			shouldRespond = true;
		}
		else if (mentionsName) {
			shouldRespond = Math.random() < 0.85;
		}
		else if (mentionsBalatro) {
			shouldRespond = Math.random() < 0.2;
			isSpontaneous = true;
		}
		else {
			const effectiveChimeRate = serverSettings?.chime_in_rate ?? defaultChimeRate ?? 0.03;
			shouldRespond = Math.random() < effectiveChimeRate;
			isSpontaneous = true;
		}

		// A veces reacciona con emojis en vez de escribir
		if (!shouldRespond && (mentionsBalatro || Math.random() < 0.03)) {
			try {
				const randomEmoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
				await message.react(randomEmoji);
			}
			catch {
				// Permiso de reacción faltante
			}
			return;
		}

		if (!shouldRespond) return;

		// Respetar cooldown por canal si la respuesta es espontánea
		if (isSpontaneous) {
			const now = Date.now();
			const lastResponse = channelCooldowns.get(message.channelId) || 0;
			if (now - lastResponse < 40_000) {
				return;
			}
			channelCooldowns.set(message.channelId, now);
		}

		try {
			await message.channel.sendTyping();

			// Obtener los últimos mensajes del canal para contexto e inspección de imágenes recientes
			let contextMessages = [];
			let recentChannelMedia = [];
			try {
				const fetchedMessages = await message.channel.messages.fetch({ limit: 12 });
				const previousMsgs = Array.from(fetchedMessages.values())
					.filter(m => m.id !== message.id)
					.reverse();

				contextMessages = previousMsgs
					.map(m => {
						const author = m.member?.displayName || m.author.displayName || m.author.username;
						const cleanText = formatReadableContent(m);
						const media = extractMediaFromMessage(m);
						const mediaTag = media.length > 0
							? ` [Adjunto: ${media.map(a => a.name || 'archivo').join(', ')}]`
							: '';
						return {
							author,
							content: `${cleanText}${mediaTag}`.trim(),
						};
					})
					.filter(m => m.content);

				// Si el mensaje actual no trae foto ni responde a uno con foto, revisar si los últimos 2 mensajes tienen una imagen reciente
				const recentCandidates = previousMsgs.slice(-2).reverse();
				for (const prev of recentCandidates) {
					const ageMs = Date.now() - prev.createdTimestamp;
					if (ageMs <= 90_000) {
						const prevMedia = extractMediaFromMessage(prev);
						if (prevMedia.length > 0) {
							const refersToVisual = /\b(foto|imagen|captura|meme|mira|ve esto|que ves|qué ves|que dice|qué dice|lee|arriba|eso|esa)\b/i.test(contentLower);
							const sameAuthorFollowUp = prev.author.id === message.author.id && ageMs <= 45_000;
							if (refersToVisual || sameAuthorFollowUp) {
								recentChannelMedia = prevMedia;
								break;
							}
						}
					}
				}
			}
			catch (fetchErr) {
				console.error('Error obteniendo mensajes recientes del canal:', fetchErr);
			}

			// Consolidar adjuntos: adjuntos del mensaje actual > adjuntos del mensaje respondido > imagen reciente del canal
			const referencedMedia = extractMediaFromMessage(referencedMsgObj);
			const attachments = directMedia.length > 0
				? directMedia
				: referencedMedia.length > 0
					? referencedMedia
					: recentChannelMedia;

			// Limpiar la mención al bot del texto del mensaje
			let cleanUserMessage = formatReadableContent(message, clientUser.id);
			if (!cleanUserMessage && attachments.length > 0) {
				const hasAudio = attachments.some(a =>
					(a.contentType && a.contentType.startsWith('audio/')) ||
					/\.(ogg|opus|mp3|wav|m4a|aac)$/i.test(a.name || ''),
				);
				cleanUserMessage = hasAudio
					? 'Escucha esta nota de voz o audio y respóndeme.'
					: 'Mira esta imagen y dime qué opinas.';
			}

			// Generar respuesta con Gemini y el sistema de memoria SQLite
			const responseText = await generateJimboResponse({
				user,
				guildName: message.guild?.name || 'Servidor',
				channelName: message.channel?.name || 'chat',
				channelId: message.channelId,
				guildId: message.guildId,
				contextMessages,
				referencedMessage: referencedContext,
				userMessage: cleanUserMessage,
				attachments,
				isSerious: false,
				isSpontaneous,
			});

			// Retardo breve y natural antes de enviar (0.7s a 1.8s)
			const delay = Math.min(1800, Math.max(700, responseText.length * 10));
			await new Promise(resolve => setTimeout(resolve, delay));

			const messageChunks = splitDiscordMessage(responseText);

			for (let i = 0; i < messageChunks.length; i++) {
				if (i === 0 && (isDirectMention || isReplyToJimbo)) {
					await message.reply({ content: messageChunks[i], allowedMentions: { repliedUser: false } });
				}
				else {
					await message.channel.send(messageChunks[i]);
				}
			}

			channelCooldowns.set(message.channelId, Date.now());
		}
		catch (error) {
			console.error('[messageCreate] Error al generar respuesta de Jimbo:', error);
			if (isDirectMention || isReplyToJimbo) {
				await message.reply({
					content: '¡Naguará, me dio un lagazo mental chamo! Intenta de nuevo en un segundo.',
					allowedMentions: { repliedUser: false },
				});
			}
		}
	},
};
