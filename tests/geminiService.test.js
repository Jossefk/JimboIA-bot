const assert = require('assert');
const { splitDiscordMessage } = require('../services/geminiService.js');

describe('Gemini Service Tests', () => {
	it('should not split messages shorter than max length', () => {
		const shortText = 'Hola Jimbo, ¿cómo estás?';
		const chunks = splitDiscordMessage(shortText, 100);
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0], shortText);
	});

	it('should cleanly split long messages preserving words', () => {
		// ~400 characters text
		const longText = 'Palabra '.repeat(50);
		const chunks = splitDiscordMessage(longText, 100);

		assert.ok(chunks.length > 1);
		chunks.forEach(chunk => {
			assert.ok(chunk.length <= 100);
		});
		assert.strictEqual(chunks.join(' '), longText.trim());
	});
});
