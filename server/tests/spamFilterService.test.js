const assert = require('node:assert/strict');
const test = require('node:test');

const spamFilterService = require('../services/spamFilterService');
const { normalizeEmailPayload, stripHtml } = spamFilterService.__private__;

test('HTML stripping removes active content and decodes entities once', () => {
  assert.equal(
    stripHtml('<style>body{display:none}</style><p>Hello &amp; welcome&nbsp;home.</p><script>alert(1)</script>'),
    'Hello & welcome home.'
  );
  assert.equal(stripHtml('<p>&amp;lt;script&amp;gt;</p>'), '&lt;script&gt;');
});

test('HTML stripping remains bounded for malformed or oversized markup', () => {
  const malformed = `<script>${'x'.repeat(100_000)}`;
  assert.equal(stripHtml(malformed), '');
  const payload = normalizeEmailPayload({ html: `<p>${'a'.repeat(100_000)}</p>` });
  assert.equal(payload.bodyLength, 12_000);
});
