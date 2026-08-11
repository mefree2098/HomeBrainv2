const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeObjectKey(value, maxLength = 256) {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    return false;
  }
  return !UNSAFE_OBJECT_KEYS.has(value.toLowerCase());
}

function toAsciiSlug(value, { fallback = '', allowUnderscore = false, maxLength = 100 } = {}) {
  const input = String(value || '').trim().toLowerCase();
  const boundedLength = Number.isFinite(Number(maxLength))
    ? Math.max(1, Math.min(256, Math.trunc(Number(maxLength))))
    : 100;
  let output = '';
  let pendingSeparator = false;
  for (const character of input) {
    const isLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    const isAllowedExtra = allowUnderscore && character === '_';
    if (isLetter || isDigit || isAllowedExtra) {
      if (pendingSeparator && output && output.length < boundedLength) output += '-';
      if (output.length >= boundedLength) break;
      output += character;
      pendingSeparator = false;
    } else if (output) {
      pendingSeparator = true;
    }
  }
  return output || String(fallback || '').slice(0, boundedLength);
}

function trimTrailingCharacter(value, character) {
  const text = String(value || '');
  let end = text.length;
  while (end > 0 && text[end - 1] === character) end -= 1;
  return text.slice(0, end);
}

function collapseWhitespace(value, maxLength = 16_384) {
  const text = String(value || '').slice(0, maxLength);
  let output = '';
  let pendingSpace = false;
  for (const character of text) {
    const isWhitespace = character === ' '
      || character === '\t'
      || character === '\n'
      || character === '\r'
      || character === '\f'
      || character === '\v';
    if (isWhitespace) {
      pendingSpace = output.length > 0;
    } else {
      if (pendingSpace) output += ' ';
      output += character;
      pendingSpace = false;
    }
  }
  return output;
}

module.exports = {
  collapseWhitespace,
  isSafeObjectKey,
  toAsciiSlug,
  trimTrailingCharacter
};
