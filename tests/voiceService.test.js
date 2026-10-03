const assert = require('assert');
const { cleanTextForTTS, getVoiceConnection } = require('../services/voiceService.js');

describe('Voice Service Tests', () => {
	it('should clean markdown and discord tags for TTS cleanly', () => {
		const dirty = '¡Epa <@123456789>! Mira este **juego** en <#987654321> 🃏🎰 está _brutal_ 🔥';
		const clean = cleanTextForTTS(dirty);

		assert.ok(!clean.includes('<@123456789>'), 'Should remove user mentions');
		assert.ok(!clean.includes('<#987654321>'), 'Should remove channel tags');
		assert.ok(!clean.includes('**'), 'Should remove bold markers');
		assert.ok(!clean.includes('_'), 'Should remove italics markers');
		assert.ok(!clean.includes('🃏'), 'Should remove emojis');
		assert.strictEqual(clean, '¡Epa! Mira este juego en está brutal');
	});

	it('should report null when no active connection exists', () => {
		const conn = getVoiceConnection('non_existent_guild');
		assert.strictEqual(conn, null);
	});
});
