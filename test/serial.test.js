import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDevPorts, isPermissionError } from '../src/serial.js';

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
