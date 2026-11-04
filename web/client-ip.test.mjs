import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from './client-ip.mjs';

test('local proxy trusts only Cloudflare, otherwise the socket', () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const req = { socket: { remoteAddress }, headers: {
      'cf-connecting-ip': ' 203.0.113.1 ',
      'x-forwarded-for': ' 203.0.113.2 , 192.0.2.1',
    } };
    assert.equal(clientIp(req), '203.0.113.1');
    req.headers['cf-connecting-ip'] = ' ';
    assert.equal(clientIp(req), remoteAddress);
    delete req.headers['x-forwarded-for'];
    assert.equal(clientIp(req), remoteAddress);
  }
});

test('non-loopback sockets ignore client-supplied proxy headers', () => {
  for (const remoteAddress of ['192.0.2.1', '2001:db8::1', '::ffff:192.0.2.1']) {
    assert.equal(clientIp({ socket: { remoteAddress }, headers: {
      'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '203.0.113.2, 127.0.0.1',
    } }), remoteAddress);
  }
});
