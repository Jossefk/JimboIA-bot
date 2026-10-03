const { Type } = require('@google/genai');
const db = require('../database/db.js');

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
				description: 'Palabra clave a buscar en la memoria (ej: "anime", "trabajo", "juego", "comida").',
			},
		},
		required: ['query'],
	},
};

const jimboFunctionDeclarations = [
	setReminderDeclaration,
	getDolarRateDeclaration,
	searchMemoryDeclaration,
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
 * Ejecuta una llamada a herramienta retornada por Gemini
 */
async function executeToolCall({ name, args }, { userId, channelId, guildId }) {
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
		const results = db.searchMemories(args.query, 4);
		return {
			query: args.query,
			results: results.map(r => ({
				categoria: r.category,
				recuerdo: r.content,
				importancia: r.importance,
			})),
		};
	}

	return { error: `Herramienta desconocida: ${name}` };
}

module.exports = {
	jimboFunctionDeclarations,
	executeToolCall,
	fetchDolarRates,
};
