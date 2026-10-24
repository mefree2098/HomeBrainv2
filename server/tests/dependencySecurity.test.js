'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const express = require('express');
const forge = require('node-forge');

test('RSA verification rejects extra nested DigestAlgorithm elements (CVE-2026-85393)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const verifier = forge.pki.publicKeyFromPem(publicPem);
  const message = Buffer.from('HomeBrain certificate verification regression');
  const digest = crypto.createHash('sha256').update(message).digest();
  const validSignature = crypto.sign('sha256', message, privateKey);
  assert.equal(verifier.verify(digest.toString('binary'), validSignature.toString('binary')), true);

  const a = forge.asn1;
  const node = (type, constructed, value) => a.create(a.Class.UNIVERSAL, type, constructed, value);
  const digestInfo = node(a.Type.SEQUENCE, true, [
    node(a.Type.SEQUENCE, true, [
      node(a.Type.OID, false, a.oidToDer(forge.pki.oids.sha256).getBytes()),
      node(a.Type.NULL, false, ''),
      node(a.Type.OCTETSTRING, false, 'unconsumed attacker-controlled padding')
    ]),
    node(a.Type.OCTETSTRING, false, digest.toString('binary'))
  ]);
  const encoded = Buffer.from(a.toDer(digestInfo).getBytes(), 'binary');
  const padded = Buffer.concat([
    Buffer.from([0, 1]), Buffer.alloc(256 - encoded.length - 3, 0xff), Buffer.from([0]), encoded
  ]);
  const malformed = crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, padded);
  assert.throws(() => verifier.verify(digest.toString('binary'), malformed.toString('binary')), /DigestInfo/);
});

test('compressed request trailing bytes cannot crash the HTTP parser (CVE-2026-111181)', async (t) => {
  const app = express();
  app.use(express.json());
  app.post('/', (_req, res) => res.json({ ok: true }));
  app.use((_error, _req, res, _next) => res.status(400).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const send = (body, encoding) => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length,
        ...(encoding ? { 'Content-Encoding': encoding } : {}) }
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(await send(gzipSync('{}'), 'gzip'), 200);
  const status = await send(Buffer.concat([gzipSync('{}'), Buffer.from('invalid trailing bytes')]), 'gzip');
  assert.ok([200, 400].includes(status));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await send(Buffer.from('{}')), 200);
});
