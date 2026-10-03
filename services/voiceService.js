const {
	joinVoiceChannel,
	createAudioPlayer,
	createAudioResource,
	AudioPlayerStatus,
	VoiceConnectionStatus,
	entersState,
	EndBehaviorType,
} = require('@discordjs/voice');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { geminiModel } = require('../config.js');
const { zeroSafetySettings, callGeminiWithCascade } = require('./geminiService.js');
const db = require('../database/db.js');

// Mapa de conexiones activas por servidor
const activeConnections = new Map();

/**
 * Limpia formato markdown de Discord y emojis para que la síntesis de voz suene limpia
 */
function cleanTextForTTS(text) {
	return text
		.replace(/<@!?\d+>/g, '')
		.replace(/<#\d+>/g, '')
		.replace(/<a?:\w+:\d+>/g, '')
		.replace(/[*_~`>#]/g, '')
		.replace(/\p{Extended_Pictographic}/gu, '')
		.replace(/\s+([.,!?;:])/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Reproduce texto en voz alta con acento venezolano en un servidor
 */
async function speakText(guildId, text) {
	const connData = activeConnections.get(guildId);
	if (!connData) return false;

	const clean = cleanTextForTTS(text);
	if (!clean) return false;

	try {
		const tts = new MsEdgeTTS();
		await tts.setMetadata('es-VE-SebastianNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
		const readableStream = tts.toStream(clean);

		const resource = createAudioResource(readableStream);
		connData.player.play(resource);

		return true;
	}
	catch (error) {
		console.error(`[VOICE] Error reproduciendo voz en guild ${guildId}:`, error);
		return false;
	}
}

/**
 * Une a Jimbo al canal de voz indicado
 */
async function joinVoice(voiceChannel) {
	const guildId = voiceChannel.guild.id;

	// Si ya está conectado en este servidor, retornar la existente
	if (activeConnections.has(guildId)) {
		return activeConnections.get(guildId);
	}

	const connection = joinVoiceChannel({
		channelId: voiceChannel.id,
		guildId: guildId,
		adapterCreator: voiceChannel.guild.voiceAdapterCreator,
		selfDeaf: false,
		selfMute: false,
	});

	const player = createAudioPlayer();
	connection.subscribe(player);

	const connData = {
		connection,
		player,
		channelId: voiceChannel.id,
		guildId: guildId,
		isSpeaking: false,
	};

	activeConnections.set(guildId, connData);

	try {
		await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
		console.log(`[VOICE] Conectado exitosamente al canal de voz "${voiceChannel.name}" en ${voiceChannel.guild.name}.`);

		// Saludo inicial de Jimbo en el canal de voz
		setTimeout(() => {
			speakText(guildId, '¡Qué pasó panas! Llegó Jimbo al voice, ¿qué es lo que se balatrea por acá?');
		}, 1000);
	}
	catch (err) {
		console.error('[VOICE] Error esperando estado Ready de conexión de voz:', err);
		leaveVoice(guildId);
		throw err;
	}

	connection.on(VoiceConnectionStatus.Disconnected, async () => {
		try {
			await Promise.race([
				entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
				entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
			]);
		}
		catch {
			leaveVoice(guildId);
		}
	});

	// Manejo de recepción de voz de usuarios
	setupVoiceReceiver(connData, voiceChannel);

	return connData;
}

/**
 * Escucha a los participantes del canal cuando terminan de hablar y responde
 */
function setupVoiceReceiver(connData, voiceChannel) {
	const receiver = connData.connection.receiver;

	receiver.speaking.on('start', (userId) => {
		// Evitar procesar si Jimbo está hablando o si es el propio bot
		if (connData.player.state.status === AudioPlayerStatus.Playing) return;
		if (userId === voiceChannel.client.user.id) return;

		// Suscribirse al stream de audio del usuario con detección de silencio (1.5 segundos)
		const opusStream = receiver.subscribe(userId, {
			end: {
				behavior: EndBehaviorType.AfterSilence,
				duration: 1500,
			},
		});

		const audioChunks = [];
		opusStream.on('data', chunk => audioChunks.push(chunk));

		opusStream.on('end', async () => {
			const totalBytes = audioChunks.reduce((acc, c) => acc + c.length, 0);
			// Ignorar ruidos muy cortos o estática (menos de 6KB)
			if (totalBytes < 6000) return;

			if (connData.player.state.status === AudioPlayerStatus.Playing) return;

			try {
				const member = await voiceChannel.guild.members.fetch(userId).catch(() => null);
				const speakerName = member?.displayName || member?.user?.username || 'un pana';
				db.getOrCreateUser(userId, member?.user?.username || speakerName, speakerName);

				const combinedBuffer = Buffer.concat(audioChunks);
				const base64Audio = combinedBuffer.toString('base64');

				const voicePrompt = `Eres Jimbo en un canal de voz de Discord. El usuario "${speakerName}" te acaba de hablar por micrófono.
Escucha atentamente el audio adjunto y respóndele de forma muy concisa (1 o 2 oraciones cortas, máximo 30 palabras) con tu estilo venezolano, bromista y enérgico para que se escuche natural al hablar por voz.
Evita listas o textos largos. Sé directo y divertido.`;

				const res = await callGeminiWithCascade(aiClient =>
					aiClient.models.generateContent({
						model: geminiModel,
						contents: [{
							role: 'user',
							parts: [
								{ text: voicePrompt },
								{
									inlineData: {
										mimeType: 'audio/ogg',
										data: base64Audio,
									},
								},
							],
						}],
						config: {
							temperature: 0.9,
							safetySettings: zeroSafetySettings,
						},
					}),
				);

				if (res.text) {
					await speakText(connData.guildId, res.text);
				}
			}
			catch (error) {
				console.error('[VOICE] Error procesando voz entrante:', error);
			}
		});
	});
}

/**
 * Desconecta a Jimbo del canal de voz
 */
function leaveVoice(guildId) {
	const connData = activeConnections.get(guildId);
	if (connData) {
		try {
			connData.player.stop();
			connData.connection.destroy();
		}
		catch {
			// Ignorar error al destruir
		}
		activeConnections.delete(guildId);
		console.log(`[VOICE] Desconectado del canal de voz en guild ${guildId}.`);
		return true;
	}
	return false;
}

/**
 * Obtiene la conexión activa de un guild si existe
 */
function getVoiceConnection(guildId) {
	return activeConnections.get(guildId) || null;
}

module.exports = {
	joinVoice,
	leaveVoice,
	speakText,
	getVoiceConnection,
	cleanTextForTTS,
};
