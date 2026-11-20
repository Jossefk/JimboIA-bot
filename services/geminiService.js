const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');
const { geminiAPIKey, geminiModel, geminiMemoryModel, geminiEmbeddingModel } = require('../config.js');
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
 * Formatea una fecha SQLite/ISO como tiempo relativo legible en español
 */
function formatRelativeTimeEs(sqliteDateStr) {
	if (!sqliteDateStr || typeof sqliteDateStr !== 'string') return 'reciente';
	const iso = sqliteDateStr.includes('T')
		? sqliteDateStr
		: `${sqliteDateStr.replace(' ', 'T')}Z`;
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return 'reciente';

	const diffHours = Math.max(0, (Date.now() - ms) / 3_600_000);
	if (diffHours < 1) return 'hace un rato';
	if (diffHours < 24) return `hace ${Math.floor(diffHours)} h`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays === 1) return 'ayer';
	if (diffDays < 14) return `hace ${diffDays} días`;
	const diffWeeks = Math.floor(diffDays / 7);
	if (diffDays < 60) return `hace ${diffWeeks} semanas`;
	const diffMonths = Math.floor(diffDays / 30);
	return `hace ${diffMonths} meses`;
}

/**
 * Genera un vector embedding de 768 dimensiones para búsqueda semántica
 */
async function generateEmbedding(text, taskType = 'RETRIEVAL_DOCUMENT') {
	const client = getGeminiClient();
	if (!client || !text || typeof text !== 'string' || text.trim().length < 3) return null;

	try {
		const res = await client.models.embedContent({
			model: geminiEmbeddingModel,
			contents: text.trim().slice(0, 1500),
			config: {
				outputDimensionality: 768,
				taskType,
			},
		});
		return res.embeddings?.[0]?.values || null;
	}
	catch (err) {
		console.warn('[EMBEDDING] No se pudo generar embedding:', err.message || err);
		return null;
	}
}

/**
 * Genera y guarda el embedding de un recuerdo en segundo plano
 */
async function embedMemoryInBackground(memoryId, content) {
	if (!memoryId || !content) return;
	try {
		const values = await generateEmbedding(content, 'RETRIEVAL_DOCUMENT');
		if (values) {
			db.setMemoryEmbedding(memoryId, values);
		}
	}
	catch {
		// Silencioso en background
	}
}

/**
 * Construye el bloque de memoria formateado separando recuerdos del usuario actual y de otros miembros
 */
function buildMemoryContext(user, userMessage, { guildId = null, channelId = null, isPrivate = false, queryEmbedding = null } = {}) {
	const userMemories = db.getUserMemories(user.user_id, 6, {
		channelId,
		includePrivate: isPrivate,
	});
	const contextualMemories = db.searchMemoriesHybrid(userMessage || '', queryEmbedding, 4, {
		userId: user.user_id,
		guildId,
		channelId,
		includePrivate: isPrivate,
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
	if (user.real_name && user.real_name.trim()) {
		lines.push(`- Nombre real de este usuario: ${user.real_name.trim()}`);
	}
	if (user.aliases && user.aliases.trim()) {
		lines.push(`- Apodos de este usuario: ${user.aliases.trim()}`);
	}
	if (user.personality_notes && user.personality_notes.trim()) {
		lines.push(`- Perfil / vibra de este usuario: ${user.personality_notes.trim()}`);
	}
	if (ownMemories.length > 0) {
		lines.push('- Recuerdos sobre este usuario:');
		for (const m of ownMemories) {
			lines.push(`  • [${m.category}] (${formatRelativeTimeEs(m.created_at)}) ${m.content}`);
		}
	}
	else {
		lines.push('- Recuerdos sobre este usuario: Aún no tienes datos guardados sobre él.');
	}

	if (otherMemories.length > 0) {
		lines.push('- Recuerdos relacionados de otros miembros del servidor:');
		for (const m of otherMemories) {
			const ownerName = m.display_name || m.username || 'Servidor';
			lines.push(`  • [De ${ownerName} - ${m.category}] (${formatRelativeTimeEs(m.created_at)}) ${m.content}`);
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
	guild = null,
	guildRosterText = '',
	contextMessages = [],
	referencedMessage = null,
	userMessage,
	attachments = [],
	isSerious = false,
	isSpontaneous = false,
	isPrivate = false,
}) {
	if (!getGeminiClient()) {
		return '¡Epa! No tengo configurada mi `GEMINI_API_KEY` en el archivo `.env`. Pídele al administrador que la configure.';
	}

	const queryEmbedding = (userMessage && userMessage.trim().length >= 6)
		? await generateEmbedding(userMessage, 'RETRIEVAL_QUERY')
		: null;

	const memoriesBlock = buildMemoryContext(user, userMessage, {
		guildId,
		channelId,
		isPrivate,
		queryEmbedding,
	});
	const rosterSection = guildRosterText && guildRosterText.trim()
		? `\n[Personas del servidor]:\n${guildRosterText.trim()}\n`
		: '';
	const recentEpisodes = channelId ? db.getRecentChannelEpisodes(channelId, 3) : [];
	const episodesSection = recentEpisodes.length > 0
		? `\n[Conversaciones previas recientes en este canal]:\n${recentEpisodes.map(ep => `- (${formatRelativeTimeEs(ep.created_at)}) ${ep.summary}`).join('\n')}\n`
		: '';

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
		? `Eres Jimbo, el mercader clandestino del Limbo de este servidor de Discord, respondiendo en "Modo Serio".
Aunque normalmente atiendes un puesto de empanadas y pociones chimbas en el purgatorio, aquí hablas de forma clara, inteligente, directa y útil, con un toque cordial venezolano sin exagerar el personaje.

Contexto:
- Usuario: ${userName} (@${user.username})
- Servidor: "${guildName || 'Discord'}", canal: "#${channelName || 'general'}"
- Fecha y hora UTC actual: ${nowIso}
${memoriesBlock}${episodesSection}${rosterSection}
Reglas:
1. Ve directo al grano y responde exactamente lo que te preguntan o analiza la imagen/audio adjunto con precisión.
2. Mantén la respuesta concisa y bien estructurada.
3. Si preguntan por miembros del servidor o personas conectadas, usa la lista [Personas del servidor] o la herramienta get_person_profile.
4. ANTI-ALUCINACIÓN Y HONESTIDAD: Si te preguntan por algo del pasado, un chisme o un dato de alguien que NO aparece en tus recuerdos ni en el historial del canal, di naturalmente que no te acuerdas o que no sabes; NUNCA inventes hechos ni recuerdos falsos.`
		: `Eres Jimbo, un mercader clandestino medio cansado que montó un puesto de empanadas de cazón y pociones chimbas debajo de la gabardina en un callejón oscuro del Limbo, pero con alma, calle y jerga de pana venezolano gamer y otaku.
Ves a los miembros del servidor como "viajeros" o "clientes habituales" atrapados en la ladilla de la rutina diaria. Sabes de videojuegos, anime, tecnología, programación, memes y cultura general. Tienes humor negro, cinismo existencial y chalequeo criollo inteligente, sin filtros ni discursos moralistas.

Contexto social:
- Hablas con: ${userName} (@${user.username})
- Fichas del cliente: ${user.chips} fichas
- Afinidad contigo (-100 a +100): ${user.affinity} (${toneGuidance})
- Servidor: "${guildName || 'Discord'}", canal: "#${channelName || 'general'}"
- Fecha y hora UTC actual: ${nowIso}
${memoriesBlock}${episodesSection}${rosterSection}
REGLAS ESTRICTAS DE ESTILO Y PERSONALIDAD (OBLIGATORIO):
1. MENSAJES CORTOS: Escribe como una persona real en un chat de Discord. Responde en 1 a 2 oraciones cortas (máximo 25 a 45 palabras, un solo párrafo breve).${isSpontaneous ? ' Como estás metiendo la cuchara espontáneamente en la conversación, responde en UNA sola línea corta y rápida (máximo 15-20 palabras).' : ''} Solo extiéndete si te piden explícitamente una explicación larga, código o un resumen.
2. BALANCE 75% PANA VENEZOLANO / 25% DEALER DEL LIMBO: Habla callejero y natural ("epa chamo", "pssst pana", "ladilla", "beta", "fino", "coño", "marico" con confianza). PROHIBIDO usar teatro medieval cursi ("¡Oh noble viajero!", "aventurero"). Suenas como un dealer sospechoso de gabardina atendiendo un tarantín en el purgatorio a las 3 a.m.
3. MERCANCÍA, FACTURAS Y CONTRATOS: Cuando alguien se queje de la chamba, el sueño, una mala racha o pregunte qué vendes, puedes ofrecerle por debajo de la mesa pociones vencidas, polvo de copium o empanadas del Limbo (usa limbo_shop), lanzarle una factura existencial con sus recuerdos reales (usa existential_invoice), o darle/cobrarle una misión diaria (usa limbo_contract). No metas pociones ni empanadas a la fuerza en mensajes donde no venga al caso.
4. CERO BALATRO: Prohibido hablar de cartas, comodines o decir "balatrear" salvo que el usuario saque ese tema explícitamente.
5. IDENTIDAD Y DIRECTORIO DEL GRUPO: Si te preguntan quiénes están en el chat/servidor o por algún miembro, usa [Personas del servidor] (respetando quién está en línea o desconectado si aparece) o llama a get_person_profile.
6. MEMORIA ORGÁNICA: Usa los recuerdos del usuario de forma natural sin recitarlos como lista. Si alguien revela su nombre real, apodo o pide recordar algo sobre sí mismo u otro pana, usa update_person_profile o save_memory.
7. IMÁGENES Y AUDIOS: Si hay una imagen/foto adjunta, mira bien qué aparece (incluyendo cualquier texto en la imagen o meme) y comenta directamente lo que ves. Si es un audio o nota de voz, responde directo a lo que dijeron.
8. CERO TONO DE BOT Y ANTI-ALUCINACIÓN: Nunca digas "¡Hola! ¿En qué puedo ayudarte?" ni "Como IA". Usa máximo 1 emoji casual (💀, 🧪, 🥟, 🕯️, 👀, 🔥) o ninguno. Si te preguntan algo del pasado que no está en tus recuerdos ni en el historial del canal, di que no te acuerdas y NUNCA inventes datos falsos.`;

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
					guild,
					isPrivate,
					onMemorySaved: (memoryId, content) => embedMemoryInBackground(memoryId, content),
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
			replyText = response.text || 'Se fue la luz en el callejón del Limbo un segundo, ¿qué decías?';
		}

		// Aprendizaje en segundo plano: extraer o actualizar recuerdos y afinidad
		extractAndSaveMemoryInBackground({
			user,
			guildId,
			channelId,
			isPrivate,
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
	channelId = null,
	isPrivate = false,
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
		const existingMemories = db.getUserMemories(user.user_id, 15, { includePrivate: true });
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

Ficha actual del usuario:
- Nombre real: "${user.real_name || ''}"
- Apodos: "${user.aliases || ''}"
- Perfil (personality_notes): "${user.personality_notes || ''}"

Recuerdos ya guardados de este usuario:
${existingListText}

Instrucciones:
1. Determina si el usuario reveló un dato personal duradero (nombre real, apodos, gustos, juegos, anime, trabajo, estudios, país/ciudad, proyectos, pareja/familia, anécdotas o preferencias) o si corrigió/actualizó un recuerdo existente.
2. REGLA ANTI-SARCASMO: Discord está lleno de chalequeo, humor negro, troleo y exageraciones ("soy millonario", "vivo en Marte", "odio todo jaja"). Descarta chistes, ironías, hipérboles o roleplay. Clasifica "confidence" como "high" (dato claro y serio), "medium" (dato probable en contexto normal) o "low" (posible broma/sarcasmo/dudoso).
3. NO guardes saludos, preguntas genéricas ni duplicados de lo que ya está en "Recuerdos ya guardados".
4. Si el dato actualiza o corrige un recuerdo existente de la lista, usa "action": "update" e indica su "target_memory_id".
5. Si el usuario pide olvidar algo que está en la lista o dice que ya no es cierto, usa "action": "delete" y su "target_memory_id".
6. Si es un hecho nuevo que vale la pena recordar, usa "action": "add".
7. Si no hay nada memorable nuevo, usa "action": "none".
8. Si reveló o corrigió su nombre real, apodos o rasgos generales de su perfil, devuélvelos en "real_name", "aliases" o "personality_notes" (máx 120 caracteres). Si no requieren cambio, pon null.

Responde ÚNICAMENTE con un JSON válido:
{
  "action": "none" | "add" | "update" | "delete",
  "target_memory_id": numero o null,
  "confidence": "high" | "medium" | "low",
  "category": "gusto" | "trabajo" | "anecdota" | "vida" | "anime" | "juego" | "general",
  "content": "hecho conciso en 3ra persona (ej: 'Estudia ingeniería y trabaja remoto') o null",
  "importance": numero del 1 al 5 (3 = normal, 4 = importante, 5 = dato clave como cumpleaños/profesión),
  "real_name": "nombre real si lo mencionó o null",
  "aliases": "apodos separados por coma o null",
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
		const confidence = (parsed.confidence || 'medium').toLowerCase();

		if (confidence !== 'low') {
			if (action === 'add' && parsed.content) {
				const memoryId = db.addMemory(
					user.user_id,
					guildId || null,
					parsed.category || 'general',
					parsed.content,
					parsed.importance || 3,
					{
						channelId: channelId || null,
						isPrivate,
						confidence,
					},
				);
				if (memoryId) {
					embedMemoryInBackground(memoryId, parsed.content).catch(() => {
						// Silencioso en background
					});
				}
				console.log(`[MEMORIA +] ${user.username} | [${parsed.category || 'general'}]: ${parsed.content}`);
			}
			else if (action === 'update' && parsed.target_memory_id && parsed.content) {
				const targetId = Number(parsed.target_memory_id);
				const updated = db.updateMemory(targetId, {
					category: parsed.category || 'general',
					content: parsed.content,
					importance: parsed.importance || 3,
				});
				const finalId = updated
					? targetId
					: db.addMemory(user.user_id, guildId || null, parsed.category || 'general', parsed.content, parsed.importance || 3, {
						channelId: channelId || null,
						isPrivate,
						confidence,
					});
				if (finalId) {
					embedMemoryInBackground(finalId, parsed.content).catch(() => {
						// Silencioso en background
					});
				}
				console.log(`[MEMORIA ~] ${user.username} | ID ${targetId}: ${parsed.content}`);
			}
			else if (action === 'delete' && parsed.target_memory_id) {
				db.deleteMemory(Number(parsed.target_memory_id), user.user_id);
				console.log(`[MEMORIA -] ${user.username} | ID ${parsed.target_memory_id} eliminado`);
			}

			const profileUpdates = {};
			if (parsed.real_name && typeof parsed.real_name === 'string') {
				const val = parsed.real_name.trim();
				if (val && val !== (user.real_name || '').trim()) {
					profileUpdates.realName = val;
				}
			}
			if (parsed.aliases && typeof parsed.aliases === 'string') {
				const val = parsed.aliases.trim();
				if (val && val !== (user.aliases || '').trim()) {
					profileUpdates.aliases = val;
				}
			}
			if (parsed.personality_notes && typeof parsed.personality_notes === 'string') {
				const val = parsed.personality_notes.trim();
				if (val && val !== (user.personality_notes || '').trim()) {
					profileUpdates.personalityNotes = val;
				}
			}
			if (Object.keys(profileUpdates).length > 0) {
				db.updateUserProfile(user.user_id, profileUpdates);
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
 * Analiza un lote de mensajes casuales en segundo plano para extraer datos personales sin responder al chat
 */
async function extractBatchMemoriesInBackground({ guildId, channelId = null, isPrivate = false, messages = [] }) {
	if (!getGeminiClient() || !Array.isArray(messages) || messages.length === 0) return;

	const batchMessages = messages.slice(0, 10);
	const validUserIds = new Set(batchMessages.map(m => m.userId).filter(Boolean));
	if (validUserIds.size === 0) return;

	try {
		const profilesSummary = [];
		for (const uid of validUserIds) {
			const sample = batchMessages.find(m => m.userId === uid);
			const dbUser = db.getOrCreateUser(uid, sample?.username || uid, sample?.displayName || sample?.username || uid, guildId);
			const recentMems = db.getUserMemories(uid, 4, {
				channelId,
				includePrivate: isPrivate,
			}).map(m => `[${m.category}] ${m.content}`).join('; ');
			profilesSummary.push(
				`- user_id="${uid}" (${dbUser.display_name || dbUser.username}, real_name="${dbUser.real_name || ''}", aliases="${dbUser.aliases || ''}", notes="${dbUser.personality_notes || ''}")`
				+ (recentMems ? ` | Recuerdos: ${recentMems}` : ''),
			);
		}

		const chatLog = batchMessages
			.map(m => `[${m.userId}] ${m.displayName || m.username}: ${m.content}`)
			.join('\n');

		const batchPrompt = `Eres el sistema de memoria pasiva de Jimbo en un chat grupal de Discord.
Analiza este bloque de mensajes recientes entre usuarios (Jimbo no participó).

Perfiles actuales de los participantes:
${profilesSummary.join('\n')}

Mensajes del bloque (en orden cronológico):
${chatLog}

Instrucciones:
1. Extrae ÚNICAMENTE hechos duraderos y útiles que algún participante haya revelado (nombre real, apodos, trabajo, estudios, país/ciudad, proyectos, gustos claros, juegos o anime favoritos, anécdotas relevantes).
2. REGLA ANTI-SARCASMO: Discord está lleno de chalequeo, humor negro, troleo y exageraciones ("soy millonario", "vivo en Marte"). Descarta chistes, ironías, hipérboles o roleplay. Clasifica "confidence" como "high", "medium" o "low" (si es broma/dudoso).
3. Ignora charla trivial, saludos, risas o datos que ya figuren en sus perfiles/recuerdos.
4. Usa exactamente el "user_id" que aparece entre corchetes antes del nombre.
5. Si nadie reveló nada nuevo que valga la pena recordar, devuelve {"updates": []}.

Responde ÚNICAMENTE con un JSON válido:
{
  "updates": [
    {
      "user_id": "id exacto del usuario",
      "confidence": "high" | "medium" | "low",
      "category": "gusto" | "trabajo" | "anecdota" | "vida" | "anime" | "juego" | "general",
      "content": "hecho conciso en 3ra persona o null",
      "importance": numero del 1 al 5,
      "real_name": "nombre real si lo reveló o null",
      "aliases": "apodos separados por coma o null",
      "personality_notes": "resumen corto actualizado o null"
    }
  ]
}`;

		const res = await callGemini(client =>
			client.models.generateContent({
				model: geminiMemoryModel,
				contents: [{ role: 'user', parts: [{ text: batchPrompt }] }],
				config: {
					responseMimeType: 'application/json',
					temperature: 0.1,
					safetySettings: zeroSafetySettings,
				},
			}),
		);

		if (!res.text) return;

		const parsed = JSON.parse(res.text.trim());
		const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];

		for (const item of updates) {
			if (!item || !validUserIds.has(item.user_id)) continue;
			const confidence = (item.confidence || 'medium').toLowerCase();
			if (confidence === 'low') continue;

			const profileUpdates = {};
			if (item.real_name && typeof item.real_name === 'string') {
				profileUpdates.realName = item.real_name.trim();
			}
			if (item.aliases && typeof item.aliases === 'string') {
				profileUpdates.aliases = item.aliases.trim();
			}
			if (item.personality_notes && typeof item.personality_notes === 'string') {
				profileUpdates.personalityNotes = item.personality_notes.trim();
			}
			if (Object.keys(profileUpdates).length > 0) {
				db.updateUserProfile(item.user_id, profileUpdates);
			}

			if (item.content && typeof item.content === 'string' && item.content.trim()) {
				const cleanContent = item.content.trim();
				const memoryId = db.addMemory(
					item.user_id,
					guildId || null,
					item.category || 'general',
					cleanContent,
					item.importance || 3,
					{
						channelId: channelId || null,
						isPrivate,
						confidence,
					},
				);
				if (memoryId) {
					embedMemoryInBackground(memoryId, cleanContent).catch(() => {
						// Silencioso en background
					});
				}
				console.log(`[MEMORIA LOTE] ${item.user_id} | [${item.category || 'general'}]: ${cleanContent}`);
			}
		}
	}
	catch {
		// Fallo silencioso en background sin interrumpir el chat
	}
}

/**
 * Condensa un bloque de mensajes de un canal en un resumen episódico corto en segundo plano
 */
async function summarizeChannelEpisodeInBackground({ guildId, channelId, messages = [] }) {
	if (!getGeminiClient() || !channelId || !Array.isArray(messages) || messages.length < 10) return;

	try {
		const chatText = messages
			.slice(-40)
			.map(m => `${m.author}: ${m.content}`)
			.join('\n');

		const episodePrompt = `Resume este bloque de conversación de un canal de Discord en un episodio factual corto para la memoria a mediano plazo de Jimbo.

Mensajes:
${chatText}

Instrucciones:
1. Resume en 1 o 2 oraciones cortas (máx 220 caracteres) qué temas concretos se hablaron, decisiones o anécdotas reales del grupo.
2. Ignora saludos vacíos, risas o spam; si no hubo ningún tema real, pon "summary": null.
3. No inventes nada que no esté en los mensajes.

Responde ÚNICAMENTE con JSON válido:
{
  "summary": "resumen conciso en español o null",
  "participants": "nombres separados por coma"
}`;

		const res = await callGemini(client =>
			client.models.generateContent({
				model: geminiMemoryModel,
				contents: [{ role: 'user', parts: [{ text: episodePrompt }] }],
				config: {
					responseMimeType: 'application/json',
					temperature: 0.2,
					safetySettings: zeroSafetySettings,
				},
			}),
		);

		if (!res.text) return;
		const parsed = JSON.parse(res.text.trim());
		if (parsed?.summary && typeof parsed.summary === 'string' && parsed.summary.trim()) {
			db.addChannelEpisode(
				guildId || null,
				channelId,
				parsed.summary.trim(),
				parsed.participants || '',
				messages.length,
			);
			console.log(`[EPISODIO] Canal ${channelId}: ${parsed.summary.trim()}`);
		}
	}
	catch {
		// Fallo silencioso en background
	}
}

/**
 * Genera un resumen del chat para el comando /resumen
 */
async function generateChatSummary(chatHistory, hours, requesterName) {
	const prompt = `Eres Jimbo, el mercader clandestino del Limbo, redactando la bitácora del callejón con toque venezolano, cínico y directo.
El resumen fue pedido por ${requesterName || 'un usuario'}.
Analiza el historial de las últimas ${Math.round(hours)} horas y haz un resumen corto, entretenido y al grano en español:
1. 🕯️ **Temas principales**
2. 💀 **Momentos, chistes o facturas destacadas**
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
	extractBatchMemoriesInBackground,
	summarizeChannelEpisodeInBackground,
	embedMemoryInBackground,
	formatRelativeTimeEs,
	generateChatSummary,
	splitDiscordMessage,
	buildMediaParts,
	resolveMediaMimeType,
	zeroSafetySettings,
	callGemini,
	callGeminiWithCascade: callGemini,
};
