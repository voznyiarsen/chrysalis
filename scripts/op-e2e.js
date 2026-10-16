/**
 * OP the E2E test bots for a session suffix.
 *
 * Server ops are unstable (observed revoked between runs), so run this
 * immediately before `npm run test:e2e`:
 *
 *   E2E_SUFFIX=e2e1 npm run e2e:op
 *
 * Uses RCON when RCON_PASS is set (never commit the password — pass it via
 * environment only), otherwise logs in as the OPed Pupa bot and relays
 * `/op <user>` for the four suite usernames (inv|jmp|prl|pvp_<suffix>).
 */

/* eslint-disable no-console */
const mineflayer = require('mineflayer');

const suffix = (process.env.E2E_SUFFIX || 'e2e1').replace(
  /[^A-Za-z0-9_]/g,
  '',
);
const users = [`inv_${suffix}`, `jmp_${suffix}`, `prl_${suffix}`, `pvp_${suffix}`];
const host = process.env.RCON_HOST || process.env.PUPA_HOST || 'nibble.internal';

async function viaRcon() {
  const { rconCommands } = require('./rcon');
  const port = parseInt(process.env.RCON_PORT || '25575', 10);
  const responses = await rconCommands(
    host,
    port,
    process.env.RCON_PASS,
    users.map((u) => `op ${u}`),
  );
  responses.forEach((r, i) => console.log(`MSG: ${r} (${users[i]})`));
  console.log(`OP requested for: ${users.join(', ')}`);
}

function viaRelay() {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({
      host: process.env.PUPA_HOST || process.env.E2E_HOST || 'nibble.internal',
      port: parseInt(process.env.PUPA_PORT || process.env.E2E_PORT || '25565', 10),
      username: process.env.PUPA_NAME || 'Pupa',
      version: process.env.PUPA_VERSION || '1.12.2',
    });
    bot.on('message', (m) => console.log('MSG:', m.toString().slice(0, 120)));
    bot.once('spawn', async () => {
      for (const u of users) {
        bot.chat(`/op ${u}`);
        await bot.waitForTicks(20);
      }
      console.log(`OP requested for: ${users.join(', ')}`);
      bot.end();
      resolve();
    });
    bot.on('error', (e) => reject(new Error(`BOT ERROR: ${e.message}`)));
    setTimeout(() => reject(new Error('TIMEOUT waiting for spawn')), 60000);
  });
}

(async () => {
  if (process.env.RCON_PASS) {
    console.log('Using RCON for OP grants');
    await viaRcon();
  } else {
    console.log('RCON_PASS unset; relaying /op through the Pupa bot');
    await viaRelay();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
