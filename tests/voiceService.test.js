const assert = require('assert');
const { cleanTextForTTS, getVoiceConnection, pcmToWav } = require('../services/voiceService.js');

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

	it('should convert raw PCM buffer to valid 44-byte WAV audio buffer', () => {
		const pcmDummy = Buffer.alloc(1920);
		const wav = pcmToWav(pcmDummy, 48000, 2, 16);

		assert.strictEqual(wav.length, 44 + 1920);
		assert.strictEqual(wav.subarray(0, 4).toString(), 'RIFF');
		assert.strictEqual(wav.subarray(8, 12).toString(), 'WAVE');
		assert.strictEqual(wav.subarray(12, 16).toString(), 'fmt ');
		assert.strictEqual(wav.readUInt32LE(16), 16);
		assert.strictEqual(wav.readUInt16LE(20), 1);
		assert.strictEqual(wav.readUInt16LE(22), 2);
		assert.strictEqual(wav.readUInt32LE(24), 48000);
		assert.strictEqual(wav.subarray(36, 40).toString(), 'data');
		assert.strictEqual(wav.readUInt32LE(40), 1920);
	});
});

