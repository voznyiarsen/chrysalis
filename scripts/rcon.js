/**
 * Minimal Minecraft RCON client (no dependencies).
 *
 * Library use:
 *   const { rconCommands } = require('./rcon');
 *   const out = await rconCommands(host, port, password, ['list', 'op Bob']);
 *
 * CLI use:
 *   RCON_PASS=secret node rcon.js <host> <port> "<cmd1>" ["<cmd2>" ...]
 */

/* eslint-disable no-console */

const net = require('node:net');

function packet(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  buf.writeInt16LE(0, 12 + b.length);
  return buf;
}

/**
 * Run RCON commands sequentially. Resolves with response strings.
 * Rejects on auth failure, socket error, or timeout.
 */
function rconCommands(host, port, password, commands, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, host, () => {
      sock.write(packet(1, 3, password));
    });
    let recv = Buffer.alloc(0);
    let authDone = false;
    const queue = [...commands];
    const responses = [];
    let current = null;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('RCON timed out'));
    }, timeoutMs);

    const done = (err, out) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(out);
    };

    function next() {
      current = queue.shift();
      if (current === undefined) {
        done(null, responses);
        return;
      }
      sock.write(packet(10, 2, current));
    }

    sock.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      while (recv.length >= 4) {
        const size = recv.readInt32LE(0);
        if (recv.length < 4 + size) break;
        const id = recv.readInt32LE(4);
        const type = recv.readInt32LE(8);
        const body = recv.slice(12, 4 + size - 2).toString('utf8');
        recv = recv.slice(4 + size);
        if (!authDone) {
          // Servers may send an empty mirror packet before the verdict;
          // only a type-2 packet settles auth.
          if (type !== 2) continue;
          authDone = true;
          if (id === -1) {
            done(new Error('RCON auth failed'));
            return;
          }
          next();
        } else {
          responses.push(body.trim());
          next();
        }
      }
    });

    sock.on('error', (e) => done(new Error(`RCON socket: ${e.message}`)));
  });
}

if (require.main === module) {
  const [host, port, ...commands] = process.argv.slice(2);
  const password = process.env.RCON_PASS;
  if (!password || !host || !port || commands.length === 0) {
    console.error(
      'Usage: RCON_PASS=... node rcon.js <host> <port> "<cmd>" [...]',
    );
    process.exit(2);
  }
  rconCommands(host, parseInt(port, 10), password, commands)
    .then((responses) => {
      console.log('RCON AUTH OK');
      commands.forEach((c, i) => {
        console.log(`--- response to [${c}] ---`);
        console.log(responses[i] || '(empty)');
      });
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

module.exports = { rconCommands };
