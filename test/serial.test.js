import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDevPorts, isPermissionError, describeDenied } from '../src/serial.js';

test('scanDevPorts keeps USB serial devices only, sorted', () => {
  const names = ['ttyS0', 'ttyUSB1', 'tty', 'ttyACM0', 'ttyACM10', 'ttyUSB0', 'null', 'ttyACM'];
  assert.deepEqual(scanDevPorts('/dev', names).map((p) => p.path), [
    '/dev/ttyACM0',
    '/dev/ttyACM10',
    '/dev/ttyUSB0',
    '/dev/ttyUSB1',
  ]);
});

test('isPermissionError recognises serialport open errors', () => {
  assert.ok(isPermissionError(new Error('Error: Permission denied, cannot open /dev/ttyACM0')));
  assert.ok(isPermissionError(Object.assign(new Error('x'), { code: 'EACCES' })));
  assert.ok(!isPermissionError(new Error('Error: No such file or directory, cannot open /dev/ttyACM9')));
});

test('describeDenied names USB ports, or the first few otherwise', () => {
  const ttyS = Array.from({ length: 32 }, (_, i) => ({ path: `/dev/ttyS${i}` }));
  assert.equal(describeDenied([{ path: '/dev/ttyACM0', vendorId: '0483' }, ...ttyS]), '/dev/ttyACM0');
  assert.equal(describeDenied(ttyS), '/dev/ttyS0, /dev/ttyS1, /dev/ttyS2 and 29 more');
  assert.equal(describeDenied([{ path: '/dev/cu.usbmodem1' }]), '/dev/cu.usbmodem1');
});
