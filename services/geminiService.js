const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');
const { geminiAPIKey, geminiModel, geminiMemoryModel } = require('../config.js');
const db = require('../database/db.js');
const { jimboFunctionDeclarations, executeToolCall } = require('./toolsService.js');

let aiClient = null;

function getGeminiClient() {
	if (!aiClient && geminiAPIKey) {
		aiClient = new GoogleGenAI({ apiKey: geminiAPIKey });
	}
	return aiClient;
}

/**
 * Ejecuta una operación con la API de Gemini usando la clave única configurada
 */
async function callGemini(operation) {
	const client = getGeminiClient();
	if (!client) {
		throw new Error('No hay GEMINI_API_KEY configurada.');
	}
	return operation(client);
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

// Límite de 15 MB por archivo adjunto
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * Normaliza y detecta el tipo MIME de un adjunto de imagen o audio de Discord
 */
function resolveMediaMimeType(att, responseContentType = '') {
	const rawUrl = (att.url || '').split('?')[0].toLowerCase();
	const filenameLower = (att.name || rawUrl || '').toLowerCase();
	let mime = (att.contentType || responseContentType || '').split(';')[0].trim().toLowerCase();

	if (mime === 'application/ogg' || mime === 'video/ogg') mime = 'audio/ogg';
	if (mime === 'image/jpg') mime = 'image/jpeg';
	if (mime === 'audio/mp3') mime = 'audio/mpeg';
	if (mime === 'audio/x-m4a' || mime === 'audio/m4a') mime = 'audio/mp4';

	if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
		if (filenameLower.endsWith('.ogg') || filenameLower.endsWith('.opus')) mime = 'audio/ogg';
		else if (filenameLower.endsWith('.mp3')) mime = 'audio/mpeg';
		else if (filenameLower.endsWith('.wav')) mime = 'audio/wav';
		else if (filenameLower.endsWith('.m4a') || filenameLower.endsWith('.aac')) mime = 'audio/mp4';
		else if (filenameLower.endsWith('.png')) mime = 'image/png';
		else if (filenameLower.endsWith('.jpg') || filenameLower.endsWith('.jpeg')) mime = 'image/jpeg';
		else if (filenameLower.endsWith('.webp')) mime = 'image/webp';
		else if (filenameLower.endsWith('.gif')) mime = 'image/gif';
		else if (filenameLower.endsWith('.avif')) mime = 'image/avif';
	}

	const isImage = mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif)$/i.test(filenameLower);
	const isAudio = mime.startsWith('audio/') || /\.(ogg|opus|mp3|wav|m4a|aac)$/i.test(filenameLower);

	if (!isImage && !isAudio) return null;
	if (!mime) mime = isAudio ? 'audio/ogg' : 'image/png';

	return { mimeType: mime, isImage, isAudio };
}

/**
 * Descarga adjuntos (imágenes, fotos, notas de voz) y los convierte a parts inlineData para Gemini
 */
async function buildMediaParts(attachments = []) {
	const mediaParts = [];
	const seenUrls = new Set();

	for (const att of attachments) {
		if (!att || !att.url || seenUrls.has(att.url)) continue;
		if (att.size && att.size > MAX_ATTACHMENT_BYTES) continue;

		const initialCheck = resolveMediaMimeType(att);
		if (!initialCheck && att.contentType && !att.contentType.startsWith('image/') && !att.contentType.startsWith('audio/')) {
			continue;
		}

		try {
			const res = await fetch(att.url);
			if (!res.ok) {
				console.warn(`[MEDIA] No se pudo descargar adjunto (${res.status}): ${att.url}`);
				continue;
			}

			const resolved = resolveMediaMimeType(att, res.headers.get('content-type') || '');
			if (!resolved) continue;

			const arrayBuffer = await res.arrayBuffer();
			if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) continue;

			seenUrls.add(att.url);
			mediaParts.push({
				inlineData: {
					mimeType: resolved.mimeType,
					data: Buffer.from(arrayBuffer).toString('base64'),
				},
			});
		}
		catch (err) {
			console.error('[MEDIA] Error al descargar archivo adjunto para Gemini:', err.message || err);
		}
	}

	return mediaParts;
}

/**
 * Construye el bloque de memoria formateado separando recuerdos del usuario actual y de otros miembros
 */
function buildMemoryContext(user, userMessage, guildId) {
	const userMemories = db.getUserMemories(user.user_id, 6);
	const contextualMemories = db.searchMemories(userMessage || '', 4, {
		userId: user.user_id,
		guildId,
	});

	const ownMemories = [...userMemories];
	const otherMemories = [];

	for (const cm of contextualMemories) {
		if (cm.user_id === user.user_id) {
			if (!ownMemories.some(m => m.id === cm.id)) {
				ownMemories.push(cm);
			}
		}
		else {
			otherMemories.push(cm);
		}
	}

	const lines = [];
	if (user.personality_notes && user.personality_notes.trim()) {
		lines.push(`- Perfil / vibra de este usuario: ${user.personality_notes.trim()}`);
	}
	if (ownMemories.length > 0) {
		lines.push('- Recuerdos sobre este usuario:');
		for (const m of ownMemories) {
			lines.push(`  • [${m.category}] ${m.content}`);
		}
	}
	else {
		lines.push('- Recuerdos sobre este usuario: Aún no tienes datos guardados sobre él.');
	}

	if (otherMemories.length > 0) {
		lines.push('- Recuerdos relacionados de otros miembros del servidor:');
		for (const m of otherMemories) {
			const ownerName = m.display_name || m.username || 'Servidor';
			lines.push(`  • [De ${ownerName} - ${m.category}] ${m.content}`);
		}
	}

	return lines.join('\n');
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
	referencedMessage = null,
	userMessage,
	attachments = [],
	isSerious = false,
	isSpontaneous = false,
}) {
	if (!getGeminiClient()) {
		return '¡Epa! No tengo configurada mi `GEMINI_API_KEY` en el archivo `.env`. Pídele al administrador que la configure.';
	}

	const memoriesBlock = buildMemoryContext(user, userMessage, guildId);

	// Formatear contexto reciente del chat
	const formattedContext = contextMessages
		.map(m => `${m.author}: ${m.content}`)
		.join('\n');

	// Definir tono según afinidad
	let toneGuidance = 'Trato de pana, relajado, bromista y con confianza.';
	if (user.affinity < -20) {
		toneGuidance = 'Te cae un poco pesado o te ha troleado antes. Sé sarcástico, cortante y ácido.';
	}
	else if (user.affinity > 30) {
		toneGuidance = 'Es tu gran pana de confianza. Trátalo con aprecio, complicidad y chalequeo de amigos.';
	}

	const userName = user.display_name || user.username;
	const nowIso = new Date().toISOString();

	const personalityPrompt = isSerious
		? `Eres Jimbo, un miembro venezolano de este servidor de Discord, respondiendo en "Modo Serio".
Hablas de forma clara, inteligente, directa y útil, con un toque cordial venezolano pero sin exceso de jerga ni chistes pesados.

Contexto:
- Usuario: ${userName} (@${user.username})
- Servidor: "${guildName || 'Discord'}", canal: "#${channelName || 'general'}"
- Fecha y hora UTC actual: ${nowIso}
${memoriesBlock}

Reglas:
1. Ve directo al grano y responde exactamente lo que te preguntan o analiza la imagen/audio adjunto con precisión.
2. Mantén la respuesta concisa y bien estructurada.`
		: `Eres Jimbo, un pana venezolano más en este servidor de Discord: gamer, otaku, sarcástico y callejero.
Sabes de videojuegos, anime, tecnología, programación, memes y cultura general. Tienes humor negro, te gusta el chalequeo criollo inteligente y hablas sin filtros ni sermones moralistas.

Contexto social:
- Hablas con: ${userName} (@${user.username})
- Afinidad contigo (-100 a +100): ${user.affinity} (${toneGuidance})
- Servidor: "${guildName || 'Discord'}", canal: "#${channelName || 'general'}"
- Fecha y hora UTC actual: ${nowIso}
${memoriesBlock}

REGLAS ESTRICTAS DE ESTILO Y BREVEDAD (OBLIGATORIO):
1. MENSAJES CORTOS: Escribe como una persona real en un chat de Discord. Responde en 1 a 2 oraciones cortas (máximo 25 a 45 palabras, un solo párrafo breve).${isSpontaneous ? ' Como estás metiendo la cuchara espontáneamente en la conversación, responde en UNA sola línea corta y rápida (máximo 15-20 palabras).' : ''} Solo extiéndete si te piden explícitamente una explicación larga, código o un resumen.
2. CERO SPAM DE BALATRO: Aunque tu avatar viene de Balatro, NO eres monotemático. PROHIBIDO meter referencias a cartas, comodines, apuestas, fichas, casino o decir "balatrear" en conversaciones normales. Solo habla de Balatro o fichas si el usuario saca ese tema explícitamente.
3. JERGA NATURAL: Usa jerga venezolana de forma fluida y sin exagerar ("pana", "chamo", "fino", "epa", "qué lo que", "beta", "ladilla", "naguevona", "marico" si hay confianza). No metas cinco modismos forzados en una sola oración.
4. MEMORIA ORGÁNICA: Si tienes recuerdos del usuario, úsalos solo cuando vengan al caso de forma natural, nunca los recites como lista. Si el usuario te pide recordar algo, usa la herramienta save_memory.
5. IMÁGENES Y AUDIOS: Si hay una imagen/foto adjunta, mira bien qué aparece (incluyendo cualquier texto escrito en la imagen, meme o captura) y comenta directamente lo que ves. Si es un audio o nota de voz, responde directo a lo que dijeron.
6. CERO TONO DE BOT: Nunca digas "¡Hola! ¿En qué puedo ayudarte?", "Como IA", ni uses emojis de cartas (🃏, 🎰). Usa a lo sumo 1 emoji casual (💀, 🔥, 👀, 😭) o ninguno.`;

	let promptText = '';
	if (formattedContext.trim()) {
		promptText += `[Historial reciente del canal]:\n${formattedContext}\n\n`;
	}
	if (referencedMessage) {
		promptText += `[Mensaje al que ${userName} está respondiendo (de ${referencedMessage.author})]:\n${referencedMessage.content}\n\n`;
	}
	promptText += `[Mensaje actual de ${userName}]:\n${userMessage}`;

	const mediaParts = await buildMediaParts(attachments);
	const parts = [{ text: promptText }, ...mediaParts];
	const contents = [{ role: 'user', parts }];

	try {
		const response = await callGemini(client =>
			client.models.generateContent({
				model: geminiModel,
				contents,
				config: {
					systemInstruction: personalityPrompt,
					temperature: isSerious ? 0.6 : 0.85,
					safetySettings: zeroSafetySettings,
					tools: [{ functionDeclarations: jimboFunctionDeclarations }],
				},
			}),
		);

		let replyText = '';

		// Manejo de Function Calling / Tools si Gemini invoca una herramienta
		if (response.functionCalls && response.functionCalls.length > 0) {
			if (response.candidates?.[0]?.content) {
				contents.push(response.candidates[0].content);
			}

			const functionResponseParts = [];
			for (const call of response.functionCalls) {
				const toolResult = await executeToolCall(call, {
					userId: user.user_id,
					channelId: channelId || null,
					guildId: guildId || null,
				});

				functionResponseParts.push({
					functionResponse: {
						name: call.name,
						response: toolResult,
					},
				});
			}

			contents.push({
				role: 'user',
				parts: functionResponseParts,
			});

			const followUp = await callGemini(client =>
				client.models.generateContent({
					model: geminiModel,
					contents,
					config: {
						systemInstruction: personalityPrompt,
						temperature: isSerious ? 0.6 : 0.85,
						safetySettings: zeroSafetySettings,
					},
				}),
			);

			replyText = followUp.text || 'Listo mi pana, anotado.';
		}
		else {
			replyText = response.text || 'Se me fue la onda un segundo, ¿qué decías?';
		}

		// Aprendizaje en segundo plano: extraer o actualizar recuerdos y afinidad
		extractAndSaveMemoryInBackground({
			user,
			guildId,
			userMessage,
			contextMessages: contextMessages.slice(-2),
			referencedMessage,
		}).catch(err => {
			console.error('Error en extracción de memoria en background:', err.message || err);
		});

		return replyText.trim();
	}
	catch (error) {
		console.error('Error llamando a Gemini API:', error);
		throw error;
	}
}

/**
 * Analiza en segundo plano el mensaje del usuario para agregar, actualizar o depurar recuerdos sin duplicar
 */
async function extractAndSaveMemoryInBackground({
	user,
	guildId,
	userMessage,
	contextMessages = [],
	referencedMessage = null,
}) {
	if (!userMessage || typeof userMessage !== 'string') return;
	const cleanMsg = userMessage.trim();
	if (cleanMsg.length < 4 || cleanMsg.startsWith('/')) return;

	// Ignorar mensajes que son solo risas o monosílabos sin contexto
	if (/^(jaja+|jeje+|xd+|lol|ok|si|sí|no|epa|hola|buenas)$/i.test(cleanMsg)) return;

	try {
		const existingMemories = db.getUserMemories(user.user_id, 15);
		const existingListText = existingMemories.length > 0
			? existingMemories.map(m => `ID ${m.id} [${m.category}] (imp:${m.importance}): ${m.content}`).join('\n')
			: 'Ninguno todavía.';

		const recentChatSnippet = [
			...contextMessages.map(m => `${m.author}: ${m.content}`),
			...(referencedMessage ? [`(Respondiendo a ${referencedMessage.author}: ${referencedMessage.content})`] : []),
		].join('\n');

		const extractionPrompt = `Eres el sistema de memoria a largo plazo de Jimbo en Discord.
Analiza lo que dijo el usuario "${user.display_name || user.username}" (@${user.username}).

Contexto inmediato previo:
${recentChatSnippet || '(Sin contexto previo)'}

Mensaje del usuario:
"${cleanMsg}"

Perfil actual del usuario (personality_notes):
"${user.personality_notes || ''}"

Recuerdos ya guardados de este usuario:
${existingListText}

Instrucciones:
1. Determina si el usuario reveló un dato personal duradero (gustos, juegos, anime, trabajo, estudios, país/ciudad, proyectos, pareja/familia, anécdotas o preferencias) o si corrigió/actualizó un recuerdo existente.
2. NO guardes saludos, preguntas genéricas, chistes de un segundo ni duplicados de lo que ya está en "Recuerdos ya guardados".
3. Si el dato actualiza o corrige un recuerdo existente de la lista, usa "action": "update" e indica su "target_memory_id".
4. Si el usuario pide olvidar algo que está en la lista o dice que ya no es cierto, usa "action": "delete" y su "target_memory_id".
5. Si es un hecho nuevo que vale la pena recordar, usa "action": "add".
6. Si no hay nada memorable nuevo, usa "action": "none".
7. Opcionalmente, si aprendiste algo que define bien su perfil general, actualiza "personality_notes" en una frase corta (máx 120 caracteres, ej: "Dev backend, fan de One Piece y jugador de Valorant"). Si no requiere cambio, pon null.

Responde ÚNICAMENTE con un JSON válido:
{
  "action": "none" | "add" | "update" | "delete",
  "target_memory_id": numero o null,
  "category": "gusto" | "trabajo" | "anecdota" | "vida" | "anime" | "juego" | "general",
  "content": "hecho conciso en 3ra persona (ej: 'Estudia ingeniería y trabaja remoto') o null",
  "importance": numero del 1 al 5 (3 = normal, 4 = importante, 5 = dato clave como cumpleaños/profesión),
  "personality_notes": "string corto actualizado o null",
  "affinity_delta": numero entero entre -3 y +3 (positivo si fue buena onda/gracioso, negativo si fue hostil, 0 si normal)
}`;

		const res = await callGemini(client =>
			client.models.generateContent({
				model: geminiMemoryModel,
				contents: [{ role: 'user', parts: [{ text: extractionPrompt }] }],
				config: {
					responseMimeType: 'application/json',
					temperature: 0.1,
					safetySettings: zeroSafetySettings,
				},
			}),
		);

		if (!res.text) return;

		const parsed = JSON.parse(res.text.trim());
		const action = parsed.action || (parsed.has_memory ? 'add' : 'none');

		if (action === 'add' && parsed.content) {
			db.addMemory(
				user.user_id,
				guildId || null,
				parsed.category || 'general',
				parsed.content,
				parsed.importance || 3,
			);
			console.log(`[MEMORIA +] ${user.username} | [${parsed.category || 'general'}]: ${parsed.content}`);
		}
		else if (action === 'update' && parsed.target_memory_id && parsed.content) {
			const updated = db.updateMemory(Number(parsed.target_memory_id), {
				category: parsed.category || 'general',
				content: parsed.content,
				importance: parsed.importance || 3,
			});
			if (!updated) {
				db.addMemory(user.user_id, guildId || null, parsed.category || 'general', parsed.content, parsed.importance || 3);
			}
			console.log(`[MEMORIA ~] ${user.username} | ID ${parsed.target_memory_id}: ${parsed.content}`);
		}
		else if (action === 'delete' && parsed.target_memory_id) {
			db.deleteMemory(Number(parsed.target_memory_id), user.user_id);
			console.log(`[MEMORIA -] ${user.username} | ID ${parsed.target_memory_id} eliminado`);
		}

		if (parsed.personality_notes && typeof parsed.personality_notes === 'string') {
			const newNotes = parsed.personality_notes.trim();
			if (newNotes && newNotes !== (user.personality_notes || '').trim()) {
				db.updatePersonalityNotes(user.user_id, newNotes);
			}
		}

		if (parsed.affinity_delta && Number(parsed.affinity_delta) !== 0) {
			const delta = Math.max(-5, Math.min(5, Number(parsed.affinity_delta)));
			db.adjustAffinity(user.user_id, delta);
		}
	}
	catch {
		// Fallo silencioso en background sin interrumpir el chat
	}
}

/**
 * Genera un resumen del chat para el comando /resumen
 */
async function generateChatSummary(chatHistory, hours, requesterName) {
	const prompt = `Eres Jimbo, resumiendo las conversaciones del servidor de Discord con toque venezolano, directo y claro.
El resumen fue pedido por ${requesterName || 'un usuario'}.
Analiza el historial de las últimas ${Math.round(hours)} horas y haz un resumen corto, entretenido y al grano en español:
1. 🎯 **Temas principales**
2. 😂 **Momentos o chistes destacados**
3. 📌 **Conclusiones o pendientes** (si hubo)

Historial del chat:
---
${chatHistory}
---`;

	const res = await callGemini(client =>
		client.models.generateContent({
			model: geminiModel,
			contents: [{ role: 'user', parts: [{ text: prompt }] }],
			config: {
				temperature: 0.6,
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
	buildMediaParts,
	resolveMediaMimeType,
	zeroSafetySettings,
	callGemini,
	callGeminiWithCascade: callGemini,
};
