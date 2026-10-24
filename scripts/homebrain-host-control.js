#!/usr/bin/env node
'use strict';

const net = require('node:net');

const ACTIONS = new Set(['probe', 'start', 'stop', 'restart', 'restore', 'ollama-start', 'ollama-stop', 'otbr-start', 'otbr-stop']);

function requestHostControl(action, options = {}) {
  if (!ACTIONS.has(action)) {
    return Promise.reject(new Error('Host operation is not permitted'));
  }
  const socketPath = options.socketPath || process.env.HOMEBRAIN_HOST_CONTROL_SOCKET || '/run/homebrain-control/host.sock';
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let output = '';
    let completed = false;
    const finish = (error, value) => {
      if (completed) return;
      completed = true;
      client.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    client.setTimeout(20_000, () => finish(new Error('Host service control timed out')));
    client.once('connect', () => client.end(`${JSON.stringify({ action })}\n`));
    client.on('error', (error) => finish(error));
    client.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 16_384) {
        finish(new Error('Host service control response too large'));
        return;
      }
      if (!output.includes('\n')) return;
      try {
        const response = JSON.parse(output.trim());
        if (response.ok !== true || response.code !== 0) {
          finish(new Error(response.stderr || 'Host operation denied'));
        } else {
          finish(null, response);
        }
      } catch (error) { finish(error); }
    });
    client.once('end', () => finish(new Error('Host service control closed without a response')));
  });
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('Expected one fixed host operation');
    process.exitCode = 64;
  } else {
    requestHostControl(process.argv[2]).then((response) => {
      if (response.stdout) process.stdout.write(`${response.stdout.trim()}\n`);
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { requestHostControl };
