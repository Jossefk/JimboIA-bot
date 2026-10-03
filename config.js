require('dotenv').config();

// Extraer todas las claves de Gemini configuradas (separadas por coma o variables numeradas)
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const keysList = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

let keyIdx = 2;
while (process.env[`GEMINI_API_KEY_${keyIdx}`]) {
	const extraKey = process.env[`GEMINI_API_KEY_${keyIdx}`].trim();
	if (extraKey && !keysList.includes(extraKey)) {
		keysList.push(extraKey);
	}
	keyIdx++;
}

module.exports = {
	token: process.env.DISCORD_TOKEN,
	clientId: process.env.CLIENT_ID,
	guildId: process.env.GUILD_ID,
	geminiAPIKey: keysList[0] || null,
	geminiAPIKeys: keysList,
	geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
	chimeInRate: parseFloat(process.env.CHIME_IN_RATE || '0.03'),
	ownerId: process.env.OWNER_ID || null,
};
