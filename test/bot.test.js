const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTranscriptPayload, sanitizeParticipantName, normalizeMeetingUrl, setMutedState, isBotInactiveError } = require('../src/bot.js');

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

test('sanitizeParticipantName keeps a Zoom-friendly interpreter label', () => {
  assert.equal(sanitizeParticipantName('AI Interpreter'), 'AI Interpreter');
  assert.equal(sanitizeParticipantName('Interpreter 2'), 'Interpreter 2');
  assert.equal(sanitizeParticipantName(''), 'AI Interpreter');
});

test('normalizeMeetingUrl preserves Zoom meeting links', () => {
  assert.equal(normalizeMeetingUrl('https://zoom.us/j/123456789?pwd=abc'), 'https://zoom.us/j/123456789?pwd=abc');
  assert.equal(normalizeMeetingUrl(' https://zoom.us/j/123456789 '), 'https://zoom.us/j/123456789');
});

test('setMutedState toggles the interpreter audio state', () => {
  assert.equal(setMutedState(true), true);
  assert.equal(setMutedState(false), false);
});

test('isBotInactiveError identifies Recall.ai completed-bot responses', () => {
  assert.equal(isBotInactiveError('Cannot send a command to a bot which has completed(is shutting/has shut down/has errored).'), true);
  assert.equal(isBotInactiveError('some other recall error'), false);
});
