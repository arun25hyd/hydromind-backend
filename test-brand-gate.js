'use strict';

const assert = require('assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const {
  filterRelevantKbChunks,
  isGenericQuestion,
  sanitizeGenericKbText,
} = require('./server');

const question = 'How to perform stall test of the winch in the workshop after servicing of the winch?';

assert.equal(isGenericQuestion(question), true, 'question should be treated as generic');

const bradenChunk = {
  category: 'Winch Manual',
  doc_name: 'Braden Winch Manual 175A, 165A - CH Series',
  brand: 'Braden',
  component_type: 'winch',
  searchable_text: [
    'Braden CH series winch stall test procedure.',
    'For CH150A line pull should match first layer rating e.g. 15,000 lbs.',
    'Secure winch to test bench and install load cell.',
    'Monitor system pressure, motor RPM, temperature, and brake function.',
  ].join(' '),
};

const relevance = filterRelevantKbChunks(question, [bradenChunk]);
assert.equal(relevance.generic, true, 'filter should mark question generic');
assert.equal(relevance.found, true, 'useful winch/stall KB can still be used as background');

const sanitized = sanitizeGenericKbText(bradenChunk.searchable_text);
assert.equal(/braden/i.test(sanitized), false, 'brand name should be removed');
assert.equal(/ch150a/i.test(sanitized), false, 'model name should be removed');
assert.equal(/15,000\s?lbs/i.test(sanitized), false, 'brand-specific capacity should be removed');
assert.match(sanitized, /test bench/i, 'useful generic procedure detail should remain');

console.log('Brand gate test passed');
process.exit(0);
