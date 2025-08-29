require('dotenv').config();

module.exports = {
	token: process.env.DISCORD_TOKEN,
	clientId: process.env.CLIENT_ID,
	guildId: process.env.GUILD_ID,
	geminiAPIKey: process.env.GEMINI_API_KEY,
};
