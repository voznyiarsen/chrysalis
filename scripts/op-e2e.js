/**
 * OP the E2E test bots for a session suffix.
 *
 * Server ops are unstable (observed revoked between runs), so run this
 * immediately before `npm run test:e2e`:
 *
 *   E2E_SUFFIX=e2e1 npm run e2e:op
 *
 * Logs in as the OPed Pupa bot and runs `/op <user>` for the four suite
 * usernames (inv|jmp|prl|pvp_<suffix>).
 */
const mineflayer = require('mineflayer');

const suffix = (process.env.E2E_SUFFIX || 'e2e1').replace(
  /[^A-Za-z0-9_]/g,
  '',
);
const users = [`inv_${suffix}`, `jmp_${suffix}`, `prl_${suffix}`, `pvp_${suffix}`];

const bot = mineflayer.createBot({
  host: process.env.PUPA_HOST || process.env.E2E_HOST || 'nibble.internal',
  port: parseInt(
    process.env.PUPA_PORT || process.env.E2E_PORT || '25565',
    10,
  ),
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
  process.exit(0);
});
bot.on('error', (e) => {
  console.error('BOT ERROR:', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.error('TIMEOUT waiting for spawn');
  process.exit(1);
}, 60000);
