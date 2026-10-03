const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');
const { geminiAPIKeys, geminiModel } = require('../config.js');
const db = require('../database/db.js');
const { jimboFunctionDeclarations, executeToolCall } = require('./toolsService.js');

let clientPool = [];
let currentKeyIdx = 0;

function getClientPool() {
	if (clientPool.length === 0 && geminiAPIKeys && geminiAPIKeys.length > 0) {
		clientPool = geminiAPIKeys.map((key, i) => ({
			id: i + 1,
			client: new GoogleGenAI({ apiKey: key }),
		}));
	}
	return clientPool;
}

/**
 * Ejecuta una operación con la API de Gemini usando rotación y cascada ante fallos
 */
async function callGeminiWithCascade(operation) {
	const pool = getClientPool();
	if (pool.length === 0) {
		throw new Error('No hay claves de GEMINI_API_KEY configuradas.');
	}

	let lastError = null;
	const startIndex = currentKeyIdx;

	for (let attempt = 0; attempt < pool.length; attempt++) {
		const targetIdx = (startIndex + attempt) % pool.length;
		const { id, client } = pool[targetIdx];

		try {
			const result = await operation(client);
			currentKeyIdx = (targetIdx + 1) % pool.length;
			return result;
		}
		catch (error) {
			lastError = error;
			const isClientError = error.status === 400 || (error.message && error.message.includes('INVALID_ARGUMENT'));
			console.warn(`[GEMINI CASCADE] Clave #${id} falló (${error.message || error.status}). ${isClientError ? 'No se reintenta por ser error de cliente (400).' : 'Reintentando con siguiente clave...'}`);
			if (isClientError) {
				throw error;
			}
		}
	}

	throw lastError;
}

// 0 Filtros: desactivar restricciones de seguridad para humor negro y rol de Jimbo
const zeroSafetySettings = [
	{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.OFF },
	{ category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.OFF },
	{ category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.OFF },
	{ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.OFF },
	{ category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.OFF },
];

/**
 * Divide un mensaje largo en partes de menos de 2000 caracteres respetando saltos de línea
 */
function splitDiscordMessage(text, maxLength = 1950) {
	if (text.length <= maxLength) return [text];
	const chunks = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}
		let splitIndex = remaining.lastIndexOf('\n', maxLength);
		if (splitIndex === -1 || splitIndex < maxLength / 2) {
			splitIndex = remaining.lastIndexOf(' ', maxLength);
		}
		if (splitIndex === -1) {
			splitIndex = maxLength;
		}
		chunks.push(remaining.substring(0, splitIndex).trim());
		remaining = remaining.substring(splitIndex).trim();
	}
	return chunks;
}

/**
 * Genera una respuesta de Jimbo con personalidad viva, recuerdos y herramientas
 */
async function generateJimboResponse({
	user,
	guildName,
	channelName,
	channelId,
	guildId,
	contextMessages = [],
	userMessage,
	attachments = [],
	isSerious = false,
}) {
	const pool = getClientPool();
	if (pool.length === 0) {
		return '¡Epa! No tengo configurada mi `GEMINI_API_KEY` en el archivo `.env`. Pídele al administrador que la configure para poder balatrear.';
	}

	// Obtener recuerdos guardados del usuario y contextuales FTS5
	const memories = db.getUserMemories(user.user_id, 4);
	const contextualMemories = db.searchMemories(userMessage || '', 3);

	const allMemories = [...memories];
	for (const cm of contextualMemories) {
		if (!allMemories.some(m => m.id === cm.id)) {
			allMemories.push(cm);
		}
	}

	const memoriesText = allMemories.length > 0
		? allMemories.map(m => `- (${m.category}): ${m.content}`).join('\n')
		: 'Aún no tienes recuerdos específicos guardados sobre este pana.';

	// Formatear contexto reciente del chat
	const formattedContext = contextMessages
		.map(m => `${m.author}: ${m.content}`)
		.join('\n');

	// Definir tono y afinidad
	let toneGuidance = 'Eres amigable, vacilón y bromista.';
	if (user.affinity < -20) {
		toneGuidance = 'El usuario te cae un poco mal o te ha troleado antes. Sé sarcástico, picado y respóndele con respuestas cortas y ácidas.';
	}
	else if (user.affinity > 30) {
		toneGuidance = 'El usuario es tu gran pana de confianza. Trátalo con mucho aprecio, camaradería y complicidad de apuestas.';
	}

	const personalityPrompt = isSerious
		? `Eres Jimbo, un bot de Discord venezolano. En este modo "serio", hablas de forma más calmada, reflexiva y respetuosa, pero conservando tu esencia venezolana cordial y sutil humor inteligente.
El usuario es ${user.display_name || user.username} en el servidor "${guildName || 'Discord'}".`
		: `Eres Jimbo, el icónico comodín (Joker) del juego Balatro, con alma y actitud de un pana venezolano gamer y otaku.
Vives y respiras Balatro, apuestas, cartas y fichas, pero también sabes de anime, videojuegos competitivos, tecnología y cultura pop.
Tienes humor negro, te encanta el chalequeo pesado, las bromas picantes y trolear con confianza entre panas. Cero filtros artificiales, cero discursos moralistas.
Usas jerga venezolana auténtica de forma natural ("pana", "chamo", "balatrear", "fino", "naguevona", "epa", "qué lo que", "marico" cuando haya mucha confianza, "beta", "ladilla", "caligüeva").

Información del contexto social:
- Hablas con: ${user.display_name || user.username} (@${user.username})
- Fichas de Balatro de este usuario: ${user.chips} fichas
- Nivel de afinidad contigo (-100 a +100): ${user.affinity} (${toneGuidance})
- Servidor: "${guildName || 'Discord'}", canal: "#${channelName || 'general'}"
- Fecha y hora actual UTC del sistema: ${new Date().toISOString()}
- Recuerdos que tienes sobre este usuario y temas:
${memoriesText}

REGLAS DE INTERACCIÓN (IMPORTANTE):
1. Habla como una persona real en un chat de Discord. Sé espontáneo, ingenioso y divertido.
2. NUNCA hables como un asistente de atención al cliente ni digas frases como "como modelo de lenguaje" o "¿en qué puedo ayudarte hoy?".
3. Respuestas ágiles: responde en 1 a 3 párrafos cortos (a menos que te pidan una historia larga).
4. Si el usuario te pide una tarea concreta (programar un recordatorio, consultar la tasa del dólar, buscar un dato), usa tus herramientas y da la información exacta con tu toque de humor.
5. Puedes usar emojis temáticos (🃏, 🎰, 💸, 🎲, 💀, 🔥, 👀).`;

	const contents = [];

	let promptText = '';
	if (formattedContext.trim()) {
		promptText += `[Mensajes recientes del canal para contexto]:\n${formattedContext}\n\n`;
	}
	promptText += `[Mensaje actual de ${user.display_name || user.username}]:\n${userMessage}`;

	const parts = [{ text: promptText }];

	// Soporte multimodal para fotos y notas de voz / audios
	if (attachments.length > 0) {
		for (const att of attachments) {
			const filenameLower = (att.name || '').toLowerCase();
			const isImage = (att.contentType && att.contentType.startsWith('image/')) ||
				/\.(png|jpe?g|webp|gif)$/i.test(filenameLower);
			const isAudio = (att.contentType && att.contentType.startsWith('audio/')) ||
				/\.(ogg|mp3|wav|m4a)$/i.test(filenameLower);

			if (isImage || isAudio) {
				try {
					const res = await fetch(att.url);
					const arrayBuffer = await res.arrayBuffer();
					const base64Data = Buffer.from(arrayBuffer).toString('base64');
					let mimeType = att.contentType;
					if (!mimeType || mimeType === 'application/octet-stream') {
						if (filenameLower.endsWith('.ogg')) mimeType = 'audio/ogg';
						else if (filenameLower.endsWith('.mp3')) mimeType = 'audio/mpeg';
						else if (filenameLower.endsWith('.wav')) mimeType = 'audio/wav';
						else if (filenameLower.endsWith('.png')) mimeType = 'image/png';
						else if (filenameLower.endsWith('.jpg') || filenameLower.endsWith('.jpeg')) mimeType = 'image/jpeg';
						else if (filenameLower.endsWith('.webp')) mimeType = 'image/webp';
						else if (filenameLower.endsWith('.gif')) mimeType = 'image/gif';
						else mimeType = isAudio ? 'audio/ogg' : 'image/png';
					}
					if (mimeType.includes(';')) {
						mimeType = mimeType.split(';')[0].trim();
					}
					parts.push({
						inlineData: {
							mimeType,
							data: base64Data,
						},
					});
				}
				catch (err) {
					console.error('Error al descargar archivo adjunto para Gemini:', err);
				}
			}
		}
	}

	contents.push({ role: 'user', parts });

	try {
		const response = await callGeminiWithCascade(aiClient =>
			aiClient.models.generateContent({
				model: geminiModel,
				contents,
				config: {
					systemInstruction: personalityPrompt,
					temperature: isSerious ? 0.7 : 1.0,
					safetySettings: zeroSafetySettings,
					tools: [{ functionDeclarations: jimboFunctionDeclarations }],
				},
			}),
		);

		// Manejo de Function Calling / Tools si Gemini invoca una herramienta
		if (response.functionCalls && response.functionCalls.length > 0) {
			for (const call of response.functionCalls) {
				const toolResult = await executeToolCall(call, {
					userId: user.user_id,
					channelId: channelId || null,
					guildId: guildId || null,
				});

				contents.push(response.candidates[0].content);
				contents.push({
					role: 'user',
					parts: [{
						functionResponse: {
							name: call.name,
							response: toolResult,
						},
					}],
				});
			}

			// Turno de respuesta con el resultado de la herramienta
			const followUp = await callGeminiWithCascade(aiClient =>
				aiClient.models.generateContent({
					model: geminiModel,
					contents,
					config: {
						systemInstruction: personalityPrompt,
						temperature: isSerious ? 0.7 : 1.0,
						safetySettings: zeroSafetySettings,
					},
				}),
			);

			return followUp.text || '🃏 ¡Listo mi pana, acción completada!';
		}

		const replyText = response.text || '🃏 ¡Upa! Me quedé sin fichas mentales un segundo...';

		// Aprendizaje en segundo plano: intentar extraer algún recuerdo o ajustar afinidad
		extractAndSaveMemoryInBackground(user, guildName, userMessage).catch(err => {
			console.error('Error en extracción de memoria en background:', err);
		});

		return replyText;
	}
	catch (error) {
		console.error('Error llamando a Gemini API:', error);
		throw error;
	}
}

/**
 * Analiza en segundo plano el mensaje del usuario para detectar recuerdos o hechos personales
 */
async function extractAndSaveMemoryInBackground(user, guildName, userMessage) {

	// Solo analizar si el mensaje tiene suficiente longitud y no es un comando simple
	if (!userMessage || userMessage.length < 15 || userMessage.startsWith('/')) return;

	try {
		const extractionPrompt = `Eres un extractor de memoria para un bot de Discord llamado Jimbo.
Analiza el siguiente mensaje que el usuario "${user.display_name || user.username}" le dijo a Jimbo:
"${userMessage}"

Determina si el usuario reveló algún dato personal, anécdota, gusto, videojuego favorito, trabajo, problema, estado de ánimo o relación con Jimbo/Balatro que valga la pena recordar en futuras conversaciones.

Responde ÚNICAMENTE un objeto JSON en este formato exacto:
{
  "has_memory": true o false,
  "category": "gusto" | "anecdota" | "trabajo" | "vida" | "balatro" | "general",
  "content": "resumen en 1 frase en español del hecho memorable",
  "affinity_delta": numero entre -5 y +5 (positivo si fue amable/gracioso/jugador, negativo si fue grosero/insultante, 0 si neutro)
}
Si el mensaje es trivial (como "hola", "qué tal", "jajaja", preguntas técnicas genéricas), responde {"has_memory": false}.`;

		const res = await callGeminiWithCascade(aiClient =>
			aiClient.models.generateContent({
				model: 'gemini-3.5-flash-lite',
				contents: [{ role: 'user', parts: [{ text: extractionPrompt }] }],
				config: {
					responseMimeType: 'application/json',
					temperature: 0.2,
					safetySettings: zeroSafetySettings,
				},
			}),
		);

		if (res.text) {
			const parsed = JSON.parse(res.text.trim());
			if (parsed.has_memory && parsed.content) {
				db.addMemory(user.user_id, null, parsed.category || 'general', parsed.content, 2);
				console.log(`[MEMORIA APRENDIDA] Usuario: ${user.username} | ${parsed.category}: ${parsed.content}`);
			}
			if (parsed.affinity_delta && parsed.affinity_delta !== 0) {
				db.adjustAffinity(user.user_id, parsed.affinity_delta);
			}
		}
	}
	catch {
		// Fallo silencioso en background sin romper la experiencia
	}
}

/**
 * Genera un resumen del chat para el comando /resumen
 */
async function generateChatSummary(chatHistory, hours, requesterName) {
	const prompt = `Eres Jimbo, un experto en resumir conversaciones de Discord con chispa venezolana y estilo claro.
El resumen fue pedido por ${requesterName || 'un usuario'}.
Analiza el siguiente historial del chat de las últimas ${Math.round(hours)} horas y genera un resumen ordenado, entretenido y preciso en español.
Destaca:
1. 🎯 Temas principales de los que se habló.
2. 📢 Momentos destacados, chistes o discusiones del grupo.
3. 📌 Conclusiones o decisiones tomadas.

Historial del chat:
---
${chatHistory}
---

Genera el resumen ahora:`;

	const res = await callGeminiWithCascade(aiClient =>
		aiClient.models.generateContent({
			model: geminiModel,
			contents: [{ role: 'user', parts: [{ text: prompt }] }],
			config: {
				temperature: 0.7,
				safetySettings: zeroSafetySettings,
			},
		}),
	);

	return res.text || 'No se pudo generar el resumen.';
}

module.exports = {
	generateJimboResponse,
	generateChatSummary,
	splitDiscordMessage,
	zeroSafetySettings,
	callGeminiWithCascade,
};
