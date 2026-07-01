const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTranscriptPayload } = require('../src/bot.js');

test('extractTranscriptPayload supports nested transcript payloads', () => {
  const payload = {
    data: {
      payload: {
        data: {
          speaker: 'Speaker 1',
          words: [{ text: 'Bonjour' }, { text: 'tout' }, { text: 'le' }, { text: 'monde' }],
        },
      },
    },
  };

  const result = extractTranscriptPayload(payload);

  assert.deepEqual(result, {
    speaker: 'Speaker 1',
    text: 'Bonjour tout le monde',
  });
});
