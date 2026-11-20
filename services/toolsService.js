const { Type } = require('@google/genai');
const db = require('../database/db.js');
const { LIMBO_ITEMS, findLimboItem } = require('../utils/limboCatalog.js');

// 1. Declaraciones de herramientas para Gemini
const setReminderDeclaration = {
	name: 'set_reminder',
	description: 'Programa un recordatorio o alarma para el usuario en Discord. Puede especificarse en minutos relativos o en una fecha/hora ISO en UTC.',
	parameters: {
		type: Type.OBJECT,
		properties: {
			reminder_text: {
				type: Type.STRING,
				description: 'El texto exacto de lo que se debe recordar (ej: "Comprar pan", "Revisar la tarea", "Apagar la cocina").',
			},
			minutes_from_now: {
				type: Type.NUMBER,
				description: 'Minutos desde este momento en que se debe disparar el recordatorio (ej: 10, 60, 1440 para mañana).',
			},
			target_iso_time: {
				type: Type.STRING,
				description: 'Fecha y hora en formato ISO 8601 UTC si se especificó una hora fija (ej: "2026-10-03T15:30:00Z").',
			},
			send_dm: {
				type: Type.BOOLEAN,
				description: 'True si el usuario pidió que se lo recuerde por mensaje privado (DM), False si es en el canal actual.',
			},
		},
		required: ['reminder_text'],
	},
};

const getDolarRateDeclaration = {
	name: 'get_dolar_rate',
	description: 'Obtiene las tasas de cambio de divisas en Venezuela: dólar oficial BCV y dólar paralelo / Binance P2P USDT, calculando montos en Bolívares o Dólares si se solicita.',
	parameters: {
		type: Type.OBJECT,
		properties: {
			currency: {
				type: Type.STRING,
				description: 'Tipo de tasa: "BCV", "PARALELO", "BINANCE" o "TODAS". Por defecto "TODAS".',
			},
			amount_usd: {
				type: Type.NUMBER,
				description: 'Monto en USD a convertir a Bolívares (VES).',
			},
			amount_ves: {
				type: Type.NUMBER,
				description: 'Monto en Bolívares (VES) a convertir a Dólares (USD).',
			},
		},
	},
};

const searchMemoryDeclaration = {
	name: 'search_memory',
	description: 'Busca anécdotas, gustos, o hechos memorables guardados en la memoria a largo plazo sobre los usuarios o el servidor.',
	parameters: {
		type: Type.OBJECT,
		properties: {
			query: {
				type: Type.STRING,
				description: 'Palabras clave a buscar en la memoria (ej: "anime", "trabajo", "juego", "comida").',
			},
		},
		required: ['query'],
	},
};

const saveMemoryDeclaration = {
	name: 'save_memory',
	description: 'Guarda o actualiza un hecho importante, gusto, trabajo o dato personal en la memoria a largo plazo cuando el usuario pida que recuerdes algo sobre sí mismo o sobre otra persona del servidor.',
	parameters: {
		type: Type.OBJECT,
		properties: {
			target_name: {
				type: Type.STRING,
				description: 'Opcional: nombre, nick o mención de la persona del servidor sobre quien guardar el recuerdo. Si se omite, se guarda para el usuario actual.',
			},
			category: {
				type: Type.STRING,
				description: 'Categoría del recuerdo: "gusto", "trabajo", "anecdota", "vida", "anime", "juego" o "general".',
			},
			content: {
				type: Type.STRING,
				description: 'El dato o hecho conciso a recordar sobre la persona (en tercera persona, ej: "Su cumpleaños es el 14 de mayo").',
			},
			importance: {
				type: Type.NUMBER,
				description: 'Nivel de importancia del 1 al 5 (3 = normal, 5 = dato crítico).',
			},
		},
		required: ['content'],
	},
};

const getPersonProfileDeclaration = {
	name: 'get_person_profile',
	description: 'Consulta la ficha completa y los recuerdos guardados de una persona específica del servidor por su nick, nombre real, apodo o mención.',
	parameters: {
		type: Type.OBJECT,
		properties: {
			query: {
				type: Type.STRING,
				description: 'Nombre, apodo, username o mención de la persona a consultar.',
			},
		},
		required: ['query'],
	},
};

const updatePersonProfileDeclaration = {
	name: 'update_person_profile',
	description: 'Actualiza los datos de identidad de la ficha de una persona (nombre real, apodos o resumen de perfil).',
	parameters: {
		type: Type.OBJECT,
		properties: {
			target_name: {
				type: Type.STRING,
				description: 'Opcional: nick, nombre o mención de la persona a actualizar. Si se omite, actualiza al usuario que está hablando.',
			},
			real_name: {
				type: Type.STRING,
				description: 'Nombre real de la persona (ej: "Jossef", "Carlos").',
			},
			aliases: {
				type: Type.STRING,
				description: 'Apodos separados por coma (ej: "Koonts, Josse").',
			},
			personality_notes: {
				type: Type.STRING,
				description: 'Resumen breve del perfil/vibra de la persona (ej: "Creador del bot, dev backend, fan de One Piece").',
			},
		},
	},
};

const limboShopDeclaration = {
	name: 'limbo_shop',
	description: 'Gestiona el puesto clandestino de pociones chimbas, empanadas y reliquias del Limbo de Jimbo: ver catálogo, vender un ítem al usuario usando sus fichas, ver su mochila o consumir un ítem.',
	parameters: {
		type: Type.OBJECT,
		properties: {
			action: {
				type: Type.STRING,
				description: 'Acción a realizar: "catalog", "buy", "inventory" o "use".',
			},
			item_key: {
				type: Type.STRING,
				description: 'Clave o nombre del ítem para comprar o consumir (ej: "pocion_chamba", "empanada_limbo", "polvo_copium").',
			},
		},
		required: ['action'],
	},
};

const existentialInvoiceDeclaration = {
	name: 'existential_invoice',
	description: 'Recopila la ficha, recuerdos reales, inventario y contexto reciente de una persona del servidor para lanzarle una factura existencial o profecía oscura personalizada.',
	parameters: {
		type: Type.OBJECT,
		properties: {
			target_name: {
				type: Type.STRING,
				description: 'Nombre, apodo o mención de la persona. Si se omite, aplica al usuario que está hablando.',
			},
		},
	},
};

const limboContractDeclaration = {
	name: 'limbo_contract',
	description: 'Gestiona los contratos o misiones diarias clandestinas del Limbo (consultar contrato activo, asignar una misión cómica/útil con recompensa en fichas, o cobrarla al completarla).',
	parameters: {
		type: Type.OBJECT,
		properties: {
			action: {
				type: Type.STRING,
				description: 'Acción a realizar: "get", "create" o "complete".',
			},
			contract_text: {
				type: Type.STRING,
				description: 'Descripción corta del contrato/misión si action es "create".',
			},
			reward_chips: {
				type: Type.NUMBER,
				description: 'Recompensa en fichas entre 40 y 200 (por defecto 100).',
			},
		},
		required: ['action'],
	},
};

const jimboFunctionDeclarations = [
	setReminderDeclaration,
	getDolarRateDeclaration,
	searchMemoryDeclaration,
	saveMemoryDeclaration,
	getPersonProfileDeclaration,
	updatePersonProfileDeclaration,
	limboShopDeclaration,
	existentialInvoiceDeclaration,
	limboContractDeclaration,
];

// 2. Ejecutores de herramientas
async function fetchDolarRates() {
	try {
		const res = await fetch('https://ve.dolarapi.com/v1/dolares');
		if (!res.ok) throw new Error(`HTTP error ${res.status}`);
		const data = await res.json();
		// Formatear datos
		const bcv = data.find(d => d.fuente === 'oficial' || d.nombre.toLowerCase().includes('dólar') || d.nombre.toLowerCase().includes('oficial'));
		const paralelo = data.find(d => d.fuente === 'paralelo' || d.nombre.toLowerCase().includes('paralelo'));

		return {
			bcv: bcv ? bcv.promedio : null,
			paralelo: paralelo ? paralelo.promedio : null,
			fecha: new Date().toISOString(),
		};
	}
	catch {
		// En caso de caída de la API externa, devolver último estimado conocido
		return {
			bcv: 865.50,
			paralelo: 965.00,
			nota: 'Estimado temporal (API de tasas en mantenimiento)',
		};
	}
}

/**
 * Busca una persona en SQLite o en la caché de miembros del servidor
 */
function resolvePersonByQuery(query, guildId, guild = null) {
	if (!query || typeof query !== 'string') return null;
	const found = db.findUserByName(query, guildId);
	if (found) return found;

	if (guild && guild.members?.cache) {
		const norm = query.trim().replace(/^@+/, '').toLowerCase();
		for (const member of guild.members.cache.values()) {
			if (member.user?.bot) continue;
			const disp = (member.displayName || '').toLowerCase();
			const uname = (member.user?.username || '').toLowerCase();
			if (disp === norm || uname === norm || disp.includes(norm) || uname.includes(norm)) {
				return db.getOrCreateUser(member.id, member.user.username, member.displayName, guildId);
			}
		}
	}

	return null;
}

/**
 * Ejecuta una llamada a herramienta retornada por Gemini
 */
async function executeToolCall({ name, args }, {
	userId,
	channelId,
	guildId,
	guild = null,
	isPrivate = false,
	onMemorySaved = null,
}) {
	if (name === 'set_reminder') {
		const text = args.reminder_text;
		let triggerIso;

		if (args.target_iso_time) {
			triggerIso = new Date(args.target_iso_time).toISOString();
		}
		else if (args.minutes_from_now) {
			triggerIso = new Date(Date.now() + Math.max(1, args.minutes_from_now) * 60_000).toISOString();
		}
		else {
			// Por defecto 30 minutos si no se especificó tiempo
			triggerIso = new Date(Date.now() + 30 * 60_000).toISOString();
		}

		const sendDm = Boolean(args.send_dm);
		const reminderId = db.addReminder(userId, channelId, guildId, text, triggerIso, sendDm ? 1 : 0);

		return {
			status: 'success',
			reminder_id: reminderId,
			reminder_text: text,
			trigger_at_utc: triggerIso,
			send_dm: sendDm,
			message: `Recordatorio guardado con éxito. Se disparará a las ${triggerIso}.`,
		};
	}

	if (name === 'get_dolar_rate') {
		const rates = await fetchDolarRates();
		const response = {
			tasa_bcv: rates.bcv,
			tasa_paralelo: rates.paralelo,
		};

		if (args.amount_usd) {
			response.conversion_usd_a_ves = {
				monto_usd: args.amount_usd,
				en_bcv_ves: rates.bcv ? (args.amount_usd * rates.bcv).toFixed(2) : null,
				en_paralelo_ves: rates.paralelo ? (args.amount_usd * rates.paralelo).toFixed(2) : null,
			};
		}

		if (args.amount_ves) {
			response.conversion_ves_a_usd = {
				monto_ves: args.amount_ves,
				en_bcv_usd: rates.bcv ? (args.amount_ves / rates.bcv).toFixed(2) : null,
				en_paralelo_usd: rates.paralelo ? (args.amount_ves / rates.paralelo).toFixed(2) : null,
			};
		}

		return response;
	}

	if (name === 'search_memory') {
		const results = db.searchMemories(args.query, 5, {
			userId,
			guildId,
			channelId,
			includePrivate: isPrivate,
		});
		return {
			query: args.query,
			results: results.map(r => ({
				usuario: r.display_name || r.username || 'general',
				categoria: r.category,
				recuerdo: r.content,
				importancia: r.importance,
			})),
		};
	}

	if (name === 'save_memory') {
		let targetUserId = userId;
		let targetLabel = null;
		if (args.target_name) {
			const matched = resolvePersonByQuery(args.target_name, guildId, guild);
			if (matched) {
				targetUserId = matched.user_id;
				targetLabel = matched.display_name || matched.username;
			}
		}

		const memoryId = db.addMemory(
			targetUserId,
			guildId,
			args.category || 'general',
			args.content,
			args.importance || 3,
			{
				channelId,
				isPrivate,
				confidence: 'high',
			},
		);
		if (memoryId && typeof onMemorySaved === 'function') {
			Promise.resolve(onMemorySaved(memoryId, args.content)).catch(() => {
				// Silencioso en background
			});
		}
		return {
			status: 'success',
			memory_id: memoryId,
			target_user: targetLabel || 'usuario actual',
			category: args.category || 'general',
			content: args.content,
		};
	}

	if (name === 'get_person_profile') {
		const person = resolvePersonByQuery(args.query, guildId, guild);
		if (!person) {
			return {
				found: false,
				message: `No encontré ninguna ficha guardada para "${args.query}".`,
			};
		}

		const memories = db.getUserMemories(person.user_id, 10, {
			channelId,
			includePrivate: isPrivate,
		});
		return {
			found: true,
			user_id: person.user_id,
			username: person.username,
			display_name: person.display_name,
			real_name: person.real_name || '',
			aliases: person.aliases || '',
			personality_notes: person.personality_notes || '',
			affinity: person.affinity,
			memories: memories.map(m => ({
				id: m.id,
				categoria: m.category,
				recuerdo: m.content,
				importancia: m.importance,
			})),
		};
	}

	if (name === 'update_person_profile') {
		let targetUserId = userId;
		if (args.target_name) {
			const matched = resolvePersonByQuery(args.target_name, guildId, guild);
			if (!matched) {
				return {
					status: 'error',
					message: `No encontré a "${args.target_name}" en el servidor para actualizar su ficha.`,
				};
			}
			targetUserId = matched.user_id;
		}

		const updated = db.updateUserProfile(targetUserId, {
			realName: args.real_name,
			aliases: args.aliases,
			personalityNotes: args.personality_notes,
		});

		if (!updated) {
			return {
				status: 'error',
				message: 'No se pudo actualizar la ficha porque el usuario no está registrado.',
			};
		}

		return {
			status: 'success',
			profile: {
				user_id: updated.user_id,
				display_name: updated.display_name,
				real_name: updated.real_name || '',
				aliases: updated.aliases || '',
				personality_notes: updated.personality_notes || '',
			},
		};
	}

	if (name === 'limbo_shop') {
		const action = String(args.action || 'catalog').toLowerCase();
		const userRow = db.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
		const currentChips = userRow ? userRow.chips : 0;

		if (action === 'catalog') {
			return {
				saldo_fichas: currentChips,
				mercancia: LIMBO_ITEMS.map(i => ({
					key: i.key,
					nombre: i.name,
					precio: i.price,
					efecto: i.effect,
				})),
			};
		}

		if (action === 'inventory') {
			return {
				saldo_fichas: currentChips,
				mochila: db.getUserInventory(userId, 15),
			};
		}

		if (action === 'buy') {
			const item = findLimboItem(args.item_key);
			if (!item) {
				return {
					status: 'not_found',
					disponibles: LIMBO_ITEMS.map(i => i.key),
				};
			}

			if (currentChips < item.price) {
				return {
					status: 'insufficient_funds',
					precio: item.price,
					saldo_actual: currentChips,
					item: item.name,
				};
			}

			const nuevoSaldo = db.addChips(userId, -item.price);
			db.addInventoryItem(userId, item.key, item.name, item.effect, 1);

			return {
				status: 'success',
				comprado: item.name,
				item_key: item.key,
				efecto: item.effect,
				gastado: item.price,
				nuevo_saldo: nuevoSaldo,
			};
		}

		if (action === 'use') {
			const catalogItem = findLimboItem(args.item_key);
			const inventory = db.getUserInventory(userId, 20);
			const owned = catalogItem
				? inventory.find(i => i.item_key === catalogItem.key)
				: inventory.find(i => i.item_key === args.item_key || i.item_name.toLowerCase().includes(String(args.item_key || '').toLowerCase()));

			if (!owned) {
				return {
					status: 'not_owned',
					message: 'No tienes ese producto en tu mochila del Limbo.',
				};
			}

			const consumed = db.consumeInventoryItem(userId, owned.item_key);
			return {
				status: 'consumed',
				item: consumed.item_name,
				efecto: consumed.item_effect,
				restantes: consumed.remaining,
			};
		}

		return { error: `Acción de tienda desconocida: ${action}` };
	}

	if (name === 'existential_invoice') {
		const person = args.target_name
			? resolvePersonByQuery(args.target_name, guildId, guild)
			: db.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);

		if (!person) {
			return {
				found: false,
				message: 'No tengo expediente guardado de esa persona todavía.',
			};
		}

		const memories = db.getUserMemories(person.user_id, 8, {
			channelId,
			includePrivate: isPrivate,
		});
		const inventory = db.getUserInventory(person.user_id, 5);
		const recentEpisodes = channelId ? db.getRecentChannelEpisodes(channelId, 2) : [];

		return {
			found: true,
			persona: person.display_name || person.username,
			ficha: {
				nombre_real: person.real_name || '',
				apodos: person.aliases || '',
				perfil: person.personality_notes || '',
				fichas: person.chips,
				afinidad: person.affinity,
			},
			recuerdos: memories.map(m => ({
				categoria: m.category,
				contenido: m.content,
			})),
			mochila: inventory.map(i => `${i.item_name} (x${i.quantity})`),
			episodios_recientes: recentEpisodes.map(e => e.summary),
		};
	}

	if (name === 'limbo_contract') {
		const action = String(args.action || 'get').toLowerCase();
		if (action === 'get') {
			const active = db.getActiveContract(userId);
			return active
				? { status: 'active', contract: active }
				: { status: 'none', message: 'No tienes ningún contrato activo en el Limbo ahora mismo.' };
		}

		if (action === 'create') {
			return db.createDailyContract(
				userId,
				guildId,
				args.contract_text || 'Sobrevivir la jornada sin perder la cordura y tomar agua',
				args.reward_chips || 100,
			);
		}

		if (action === 'complete') {
			return db.completeDailyContract(userId);
		}

		return { error: `Acción de contrato desconocida: ${action}` };
	}

	return { error: `Herramienta desconocida: ${name}` };
}

module.exports = {
	jimboFunctionDeclarations,
	executeToolCall,
	fetchDolarRates,
};
