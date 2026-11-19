const assert = require('assert');
const { splitDiscordMessage, resolveMediaMimeType } = require('../services/geminiService.js');
const { extractMediaFromMessage } = require('../events/messageCreate.js');

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

	it('should resolve image and audio MIME types accurately even with query strings or generic content-type', () => {
		const imgAtt = {
			url: 'https://cdn.discordapp.com/attachments/123/456/captura.PNG?ex=678&is=999',
			name: 'captura.PNG',
			contentType: 'application/octet-stream',
		};
		const resolvedImg = resolveMediaMimeType(imgAtt);
		assert.ok(resolvedImg && resolvedImg.isImage);
		assert.strictEqual(resolvedImg.mimeType, 'image/png');

		const audioAtt = {
			url: 'https://cdn.discordapp.com/attachments/123/456/voice-message.ogg',
			name: 'voice-message.ogg',
			contentType: 'audio/ogg; codecs=opus',
		};
		const resolvedAudio = resolveMediaMimeType(audioAtt);
		assert.ok(resolvedAudio && resolvedAudio.isAudio);
		assert.strictEqual(resolvedAudio.mimeType, 'audio/ogg');
	});

	it('should extract media from both message attachments and image embeds', () => {
		const fakeMsg = {
			attachments: new Map([
				['1', { url: 'https://cdn.discordapp.com/foto1.jpg', name: 'foto1.jpg', contentType: 'image/jpeg', size: 1024 }],
			]),
			embeds: [
				{ image: { url: 'https://cdn.discordapp.com/embed_img.webp' } },
			],
		};
		const media = extractMediaFromMessage(fakeMsg);
		assert.strictEqual(media.length, 2);
		assert.strictEqual(media[0].url, 'https://cdn.discordapp.com/foto1.jpg');
		assert.strictEqual(media[1].url, 'https://cdn.discordapp.com/embed_img.webp');
	});
});
