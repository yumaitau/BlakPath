'use strict';

// CloudWatch Synthetics canary. Checks /api/ready and the sign-in page.
// No credentials and no applicant data. Keep this file identical to the
// Script block in infra/aws/observability.example.yaml.

function compact(body) {
  return String(body).replace(/\s+/g, '');
}

function evaluateReady(status, body) {
  if (status !== 200) return 'ready status ' + status;
  if (!compact(body).includes('"status":"ready"')) return 'ready body';
  return null;
}

function evaluateSignIn(status, body) {
  if (status !== 200) return 'sign-in status ' + status;
  if (!String(body).includes('Sign in')) return 'sign-in marker';
  return null;
}

function get(url) {
  const lib = url.startsWith('https:') ? require('https') : require('http');
  return new Promise(function (resolve, reject) {
    const req = lib.get(url, function (res) {
      const chunks = [];
      res.on('data', function (chunk) {
        chunks.push(chunk);
      });
      res.on('end', function () {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.setTimeout(10000, function () {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function handler() {
  const synthetics = require('Synthetics');
  const base = String(process.env.BLAKPATH_BASE_URL || '').replace(/\/$/, '');
  if (!base.startsWith('https://')) {
    throw new Error('BLAKPATH_BASE_URL must be https');
  }

  await synthetics.executeStep('ready', async function () {
    const ready = await get(base + '/api/ready');
    const failure = evaluateReady(ready.status, ready.body);
    if (failure) throw new Error(failure);
  });

  await synthetics.executeStep('sign-in', async function () {
    const page = await get(base + '/sign-in');
    const failure = evaluateSignIn(page.status, page.body);
    if (failure) throw new Error(failure);
  });
}

exports.evaluateReady = evaluateReady;
exports.evaluateSignIn = evaluateSignIn;
exports.handler = handler;
