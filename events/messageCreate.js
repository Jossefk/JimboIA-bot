const { Events } = require('discord.js');
const db = require('../database/db.js');
const {
	generateJimboResponse,
	extractBatchMemoriesInBackground,
	summarizeChannelEpisodeInBackground,
	splitDiscordMessage,
} = require('../services/geminiService.js');
const { buildGuildRoster, formatRosterForPrompt } = require('../utils/rosterUtils.js');
const { chimeInRate: defaultChimeRate } = require('../config.js');

// Palabras clave que llaman la atención de Jimbo
const JIMBO_DIRECT_KEYWORDS = ['jimbo', 'jimbot'];
const LIMBO_KEYWORDS = ['pocion', 'poción', 'empanada', 'limbo', 'almas', 'chamba', 'quincena', 'blackjack', 'mercancia', 'mercancía'];
const REACTION_EMOJIS = ['💀', '🧪', '🥟', '🕯️', '👀', '🔥'];

// Cooldown ligero por canal para evitar spam de respuestas espontáneas
const channelCooldowns = new Map();

// Buffers por canal para aprendizaje pasivo y episodios resumidos
const PASSIVE_BATCH_SIZE = 10;
const EPISODE_BATCH_SIZE = 35;
const passiveChannelBuffers = new Map();
const episodeChannelBuffers = new Map();

function isPrivateChannel(message) {
	if (!message.guildId) return true;
	const everyoneRole = message.guild?.roles?.everyone;
	if (everyoneRole && typeof message.channel?.permissionsFor === 'function') {
		return !message.channel.permissionsFor(everyoneRole)?.has('ViewChannel');
	}
	return false;
}

function enqueuePassiveMessage(message, displayName, isPrivate = false) {
	const cleanText = formatReadableContent(message);
	if (!cleanText || cleanText.length < 5 || cleanText.startsWith('/')) return;
	if (/^(jaja+|jeje+|xd+|lol|ok|si|sí|no|epa|hola|buenas)$/i.test(cleanText)) return;

	const buffer = passiveChannelBuffers.get(message.channelId) || [];
	buffer.push({
		userId: message.author.id,
		username: message.author.username,
		displayName,
		content: cleanText,
	});

	if (buffer.length >= PASSIVE_BATCH_SIZE) {
		passiveChannelBuffers.set(message.channelId, []);
		extractBatchMemoriesInBackground({
			guildId: message.guildId,
			channelId: message.channelId,
			isPrivate,
			messages: buffer,
		}).catch(err => {
			console.error('[MEMORIA LOTE] Error en análisis pasivo:', err.message || err);
		});
	}
	else {
		passiveChannelBuffers.set(message.channelId, buffer);
	}
}

function enqueueEpisodeMessage(message, displayName) {
	const cleanText = formatReadableContent(message);
	if (!cleanText || cleanText.length < 3 || cleanText.startsWith('/')) return;

	const buffer = episodeChannelBuffers.get(message.channelId) || [];
	buffer.push({
		author: displayName,
		content: cleanText.slice(0, 220),
	});

	if (buffer.length >= EPISODE_BATCH_SIZE) {
		episodeChannelBuffers.set(message.channelId, []);
		summarizeChannelEpisodeInBackground({
			guildId: message.guildId,
			channelId: message.channelId,
			messages: buffer,
		}).catch(err => {
			console.error('[EPISODIO] Error resumiendo bloque de canal:', err.message || err);
		});
	}
	else {
		episodeChannelBuffers.set(message.channelId, buffer);
	}
}

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
		const user = db.getOrCreateUser(message.author.id, message.author.username, displayName, message.guildId);

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

		// 4. Detectar si hablan de temas del puesto del Limbo o la rutina
		const mentionsLimbo = LIMBO_KEYWORDS.some(kw => contentLower.includes(kw));

		// Obtener configuración del servidor
		const serverSettings = message.guildId ? db.getServerSettings(message.guildId) : null;
		const allowedChannels = serverSettings?.allowed_channels || [];

		// Si hay canales restringidos y este no está en la lista, solo responder si fue mencionado directamente
		if (allowedChannels.length > 0 && !allowedChannels.includes(message.channelId) && !isDirectMention && !isReplyToJimbo) {
			return;
		}

		const isPrivate = isPrivateChannel(message);
		enqueueEpisodeMessage(message, displayName);

		// Determinar si Jimbo debe responder o intervenir
		let shouldRespond = false;
		let isSpontaneous = false;

		if (isDirectMention || isReplyToJimbo) {
			shouldRespond = true;
		}
		else if (mentionsName) {
			shouldRespond = Math.random() < 0.85;
		}
		else if (mentionsLimbo) {
			shouldRespond = Math.random() < 0.15;
			isSpontaneous = true;
		}
		else {
			const effectiveChimeRate = serverSettings?.chime_in_rate ?? defaultChimeRate ?? 0.03;
			shouldRespond = Math.random() < effectiveChimeRate;
			isSpontaneous = true;
		}

		// Si no va a responder, acumular el mensaje para aprendizaje pasivo por lotes
		if (!shouldRespond) {
			enqueuePassiveMessage(message, displayName, isPrivate);
			if (mentionsLimbo || Math.random() < 0.03) {
				try {
					const randomEmoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
					await message.react(randomEmoji);
				}
				catch {
					// Permiso de reacción faltante
				}
			}
			return;
		}

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

			// Construir directorio de miembros del servidor para el prompt
			const { entries, hasPresence } = buildGuildRoster(message.guild, message.channel);
			const guildRosterText = formatRosterForPrompt(entries, hasPresence);

			// Generar respuesta con Gemini y el sistema de memoria SQLite
			const responseText = await generateJimboResponse({
				user,
				guildName: message.guild?.name || 'Servidor',
				channelName: message.channel?.name || 'chat',
				channelId: message.channelId,
				guildId: message.guildId,
				guild: message.guild,
				guildRosterText,
				contextMessages,
				referencedMessage: referencedContext,
				userMessage: cleanUserMessage,
				attachments,
				isSerious: false,
				isSpontaneous,
				isPrivate,
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
					content: 'Se fue la luz en el callejón del Limbo chamo, dame un segundo e intenta otra vez.',
					allowedMentions: { repliedUser: false },
				});
			}
		}
	},
};
