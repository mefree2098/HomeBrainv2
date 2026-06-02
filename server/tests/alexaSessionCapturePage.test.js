const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const capturePagePath = path.resolve(__dirname, '../../client/public/alexa-session-capture.html');
const captureScriptPath = path.resolve(__dirname, '../../client/public/alexa-session-capture.js');

test('Alexa session capture page uses an external script allowed by production CSP', () => {
  const html = fs.readFileSync(capturePagePath, 'utf8');
  const inlineScriptPattern = /<script\b(?![^>]*\bsrc=)[^>]*>/i;

  assert.equal(inlineScriptPattern.test(html), false);
  assert.match(html, /<script\b[^>]*\bsrc="\/alexa-session-capture\.js"[^>]*\bdefer\b[^>]*><\/script>/i);
  assert.equal(fs.existsSync(captureScriptPath), true);
});
