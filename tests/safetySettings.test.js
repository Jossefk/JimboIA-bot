const assert = require('assert');
const { zeroSafetySettings } = require('../services/geminiService.js');
const { HarmBlockThreshold } = require('@google/genai');

describe('Safety Settings Tests (0 Filtros)', () => {
	it('should have all safety categories configured to OFF or BLOCK_NONE', () => {
		assert.ok(zeroSafetySettings.length >= 4, 'Should configure at least 4 safety categories');
		for (const setting of zeroSafetySettings) {
			assert.ok(
				setting.threshold === HarmBlockThreshold.OFF || setting.threshold === HarmBlockThreshold.BLOCK_NONE,
				`Threshold for ${setting.category} should be OFF or BLOCK_NONE, got ${setting.threshold}`,
			);
		}
	});
});
