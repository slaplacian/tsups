import { SerialPort } from 'serialport';
import { BAUD_RATE, CMD, isInfoReply } from './protocol.js';

export async function listPorts() {
  return SerialPort.list();
}

// The TS Shara USB interface (STM32 CDC, 0483:5740) holds each reply until the
// host writes again. A bare CR is ignored by the UPS but releases the reply.
const KICK = '\r';
const KICK_EVERY_MS = 300;
// A command written right after a reply is silently dropped by the UPS;
// measured on hardware: 0 ms gap fails, 500 ms works.
const MIN_GAP_AFTER_RX_MS = 500;

// Line-oriented connection: replies are CR-terminated, one reply per query.
export class UpsConnection {
  constructor(path, { baudRate = BAUD_RATE, trace = () => {} } = {}) {
    this.path = path;
    this.trace = trace;
    this.port = new SerialPort({ path, baudRate, autoOpen: false });
    this.buffer = '';
    this.waiter = null;
    this.chain = Promise.resolve();
    this.lastRxAt = 0;
    this.port.on('data', (chunk) => this.#onData(chunk));
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
    // Release and discard any reply left pending by a previous session.
    await this.#write(KICK);
    await new Promise((r) => setTimeout(r, KICK_EVERY_MS));
    this.buffer = '';
  }

  close() {
    return new Promise((resolve) => {
      if (!this.port.isOpen) return resolve();
      this.port.close(() => resolve());
    });
  }

  get isOpen() {
    return this.port.isOpen;
  }

  onClose(fn) {
    this.port.on('close', fn);
    this.port.on('error', fn);
  }

  #onData(chunk) {
    this.buffer += chunk.toString('latin1');
    let idx;
    while ((idx = this.buffer.indexOf('\r')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.lastRxAt = Date.now();
      this.trace(`RX ${JSON.stringify(line)}`);
      if (this.waiter?.accept(line)) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(line);
      } else if (this.waiter) {
        this.trace('   (ignored: not the expected reply)');
      }
    }
  }

  #write(cmd) {
    if (cmd !== KICK) this.trace(`TX ${JSON.stringify(cmd)}`);
    return new Promise((resolve, reject) => {
      this.port.write(cmd, (err) => {
        if (err) return reject(err);
        this.port.drain((e) => (e ? reject(e) : resolve()));
      });
    });
  }

  // Serialised so concurrent callers never interleave on the wire.
  #enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async #settle() {
    const wait = this.lastRxAt + MIN_GAP_AFTER_RX_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  send(cmd) {
    return this.#enqueue(async () => {
      await this.#settle();
      await this.#write(cmd);
    });
  }

  // Resolves with the first reply line that passes `accept`.
  query(cmd, { timeout = 3000, accept = () => true } = {}) {
    return this.#enqueue(async () => {
      await this.#settle();
      this.buffer = '';
      let kicker;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new Error(`no reply to ${JSON.stringify(cmd)} within ${timeout} ms`));
        }, timeout);
        this.waiter = {
          accept,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        };
      }).finally(() => clearInterval(kicker));
      await this.#write(cmd);
      kicker = setInterval(() => this.#write(KICK).catch(() => {}), KICK_EVERY_MS);
      return reply;
    });
  }
}

// Probe: send "I", accept the port if the reply contains "TS".
export async function detectPort({ match = 'TS', timeout = 3000, log = () => {} } = {}) {
  const ports = await listPorts();
  for (const info of ports) {
    const lower = info.path.toLowerCase();
    if (lower.includes('bluetooth') || lower.includes('blth')) continue;
    const conn = new UpsConnection(info.path, { trace: (m) => log(`${info.path}: ${m}`) });
    try {
      await conn.open();
      const reply = await conn.query(CMD.identify, { timeout, accept: isInfoReply });
      if (reply.includes(match)) return { path: info.path, info: reply };
    } catch (err) {
      log(`${info.path}: ${err.message}`);
    } finally {
      await conn.close();
    }
  }
  return null;
}
