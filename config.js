require('dotenv').config();

module.exports = {
	token: process.env.DISCORD_TOKEN,
	clientId: process.env.CLIENT_ID,
	guildId: process.env.GUILD_ID,
	geminiAPIKey: process.env.GEMINI_API_KEY,
	geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
	chimeInRate: parseFloat(process.env.CHIME_IN_RATE || '0.03'),
	ownerId: process.env.OWNER_ID || null,
};

