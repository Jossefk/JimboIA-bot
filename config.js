require('dotenv').config();

// Usar una única clave de Gemini (con fallback al primer elemento si se definió GEMINI_API_KEYS)
const rawKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
const geminiAPIKey = rawKey.split(',')[0].trim() || null;

module.exports = {
	token: process.env.DISCORD_TOKEN,
	clientId: process.env.CLIENT_ID,
	guildId: process.env.GUILD_ID,
	geminiAPIKey,
	geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
	geminiMemoryModel: process.env.GEMINI_MEMORY_MODEL || 'gemini-3.5-flash-lite',
	chimeInRate: parseFloat(process.env.CHIME_IN_RATE || '0.03'),
	ownerId: process.env.OWNER_ID || null,
};
