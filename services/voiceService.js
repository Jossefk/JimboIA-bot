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
const prism = require('prism-media');
const { geminiModel } = require('../config.js');
const { zeroSafetySettings, callGeminiWithCascade } = require('./geminiService.js');
const db = require('../database/db.js');

// Mapa de conexiones activas por servidor
const activeConnections = new Map();

/**
 * Convierte un buffer de audio PCM de 16-bit a formato WAV añadiendo la cabecera estándar RIFF de 44 bytes
 */
function pcmToWav(pcmData, sampleRate = 48000, numChannels = 2, bitDepth = 16) {
	const header = Buffer.alloc(44);
	const byteRate = sampleRate * numChannels * (bitDepth / 8);
	const blockAlign = numChannels * (bitDepth / 8);
	const dataSize = pcmData.length;
	const chunkSize = 36 + dataSize;

	header.write('RIFF', 0);
	header.writeUInt32LE(chunkSize, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	// SubChunk1Size (16 para PCM)
	header.writeUInt32LE(16, 16);
	// AudioFormat (1 para PCM lineal)
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(numChannels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitDepth, 34);
	header.write('data', 36);
	header.writeUInt32LE(dataSize, 40);

	return Buffer.concat([header, pcmData]);
}

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
		const { audioStream } = tts.toStream(clean);

		const resource = createAudioResource(audioStream);
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
		activeUsers: new Set(),
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
		if (connData.activeUsers.has(userId)) return;

		connData.activeUsers.add(userId);

		// Suscribirse al stream de audio del usuario con detección de silencio (1.2 segundos)
		const opusStream = receiver.subscribe(userId, {
			end: {
				behavior: EndBehaviorType.AfterSilence,
				duration: 1200,
			},
		});

		const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
		const pcmChunks = [];

		decoder.on('data', chunk => pcmChunks.push(chunk));
		decoder.on('error', err => {
			console.warn('[VOICE] Error en decodificador Opus:', err.message || err);
		});

		opusStream.pipe(decoder);

		const cleanup = () => {
			connData.activeUsers.delete(userId);
			try {
				opusStream.destroy();
				decoder.destroy();
			}
			catch {
				// Ignorar
			}
		};

		opusStream.on('error', err => {
			console.warn('[VOICE] Error en stream de voz entrante:', err.message || err);
			cleanup();
		});

		opusStream.on('end', async () => {
			cleanup();

			const totalBytes = pcmChunks.reduce((acc, c) => acc + c.length, 0);
			// 48000 Hz * 2 canales * 2 bytes = 192,000 bytes/segundo.
			// Ignorar si el audio es menor a ~0.25 segundos (48,000 bytes) para evitar ruidos de fondo
			if (totalBytes < 48000) return;

			if (connData.player.state.status === AudioPlayerStatus.Playing) return;

			try {
				const member = await voiceChannel.guild.members.fetch(userId).catch(() => null);
				const speakerName = member?.displayName || member?.user?.username || 'un pana';
				db.getOrCreateUser(userId, member?.user?.username || speakerName, speakerName);

				const pcmBuffer = Buffer.concat(pcmChunks);
				const wavBuffer = pcmToWav(pcmBuffer, 48000, 2, 16);
				const base64Audio = wavBuffer.toString('base64');

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
										mimeType: 'audio/wav',
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
			connData.activeUsers.clear();
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
	pcmToWav,
};
