process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
process.on('uncaughtException',  e => console.error('Uncaught exception:', e));

const {
  Client, GatewayIntentBits,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags
} = require('discord.js');
const fetch = require('node-fetch');
require('dotenv').config();

// ══════════════════════════════════════════
//  SAFE FETCH (retry on 429 / network errors)
// ══════════════════════════════════════════
async function safeFetch(url, options = {}, retries = 3) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429 && retries > 0) {
      await new Promise(r => setTimeout(r, 2000));
      return safeFetch(url, options, retries - 1);
    }
    return res;
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 2000));
      return safeFetch(url, options, retries - 1);
    }
    throw err;
  }
}

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const STOCK_CHANNEL_ID = '1481026325178220565';
const VOUCH_CHANNEL_ID = '1481321672970735807';
const ALERT_CHANNEL_ID = '1480833457604268154';
const GUILD_ID         = (process.env.GUILD_ID   || '').trim();
const JSONBIN_KEY      =  process.env.JSONBIN_KEY;
const BOT_TOKEN        =  process.env.BOT_TOKEN;
const COIN_EMOJI       = '<:CoinEmoji:1481246827448766526>';
const PREFIX           = 'u!';

// ══════════════════════════════════════════
//  CODES
// ══════════════════════════════════════════
const CODES = {
  'RELEASE': { coins: 25, description: '🎉 Launch reward' },
};

const pendingVouches = new Map();

// ══════════════════════════════════════════
//  SHOP
// ══════════════════════════════════════════
const SHOP = [
  { id: 'robux_25',   name: '25 Robux',   cost: 100,  category: 'Robux', robuxAmt: 25  },
  { id: 'robux_50',   name: '50 Robux',   cost: 200,  category: 'Robux', robuxAmt: 50  },
  { id: 'robux_75',   name: '75 Robux',   cost: 300,  category: 'Robux', robuxAmt: 75  },
  { id: 'robux_100',  name: '100 Robux',  cost: 400,  category: 'Robux', robuxAmt: 100 },
  { id: 'robux_125',  name: '125 Robux',  cost: 500,  category: 'Robux', robuxAmt: 125 },
  { id: 'robux_150',  name: '150 Robux',  cost: 600,  category: 'Robux', robuxAmt: 150 },
  { id: 'robux_175',  name: '175 Robux',  cost: 700,  category: 'Robux', robuxAmt: 175 },
  { id: 'robux_200',  name: '200 Robux',  cost: 800,  category: 'Robux', robuxAmt: 200 },
  { id: 'robux_225',  name: '225 Robux',  cost: 900,  category: 'Robux', robuxAmt: 225 },
  { id: 'robux_250',  name: '250 Robux',  cost: 1000, category: 'Robux', robuxAmt: 250 },
  { id: 'etfb_cel',   name: 'Celestial',  cost: 100,  category: 'ETFB',  robuxAmt: 0   },
  { id: 'etfb_div',   name: 'Divine',     cost: 250,  category: 'ETFB',  robuxAmt: 0   },
];

// ══════════════════════════════════════════
//  JSONBIN
// ══════════════════════════════════════════
const BIN_IDS = {
  users:  '69b13ea5c3097a1dd516fe70',
  store:  '69b13e7dc3097a1dd516fdc5',
  meta:   '69b13e8fb7ec241ddc5c5aa3',
  claims: '69b13ebbb7ec241ddc5c5b4b',
};
const DEFAULTS = {
  users:  {},
  store:  { robux: 0, divines: 0, celestials: 0 },
  meta:   { stockMsgId: null, claimCounter: 0 },
  claims: [],
};
const cache     = { users: null, store: null, meta: null, claims: null };
const cacheTime = { users: 0,    store: 0,    meta: 0,    claims: 0    };
const CACHE_TTL = { users: Infinity, store: 30_000, meta: 30_000, claims: 30_000 };

async function binRead(name) {
  const res = await safeFetch(`https://api.jsonbin.io/v3/b/${BIN_IDS[name]}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Versioning': 'false' },
  });
  if (!res.ok) throw new Error(`READ ${name} -> ${res.status}: ${await res.text()}`);
  const d = (await res.json()).record;
  if (!d || d.a === 'b') return JSON.parse(JSON.stringify(DEFAULTS[name]));
  if (d._empty) return d._data;
  return d;
}
async function binWrite(name, data) {
  let payload = data;
  if (Array.isArray(data) && data.length === 0)
    payload = { _empty: true, _data: [] };
  else if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)
    payload = { _empty: true, _data: {} };
  const res = await safeFetch(`https://api.jsonbin.io/v3/b/${BIN_IDS[name]}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Versioning': 'false' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`WRITE ${name} -> ${res.status}: ${await res.text()}`);
}
async function dbRead(name) {
  const now = Date.now();
  if (cache[name] !== null && now - cacheTime[name] < CACHE_TTL[name]) return cache[name];
  cache[name] = await binRead(name);
  cacheTime[name] = now;
  return cache[name];
}
async function dbWrite(name, data) {
  cache[name] = data;
  cacheTime[name] = Date.now();
  await binWrite(name, data);
}

// ══════════════════════════════════════════
//  DB HELPERS
// ══════════════════════════════════════════
async function getUser(userId, username) {
  const users = await dbRead('users');
  if (!users[userId]) {
    users[userId] = { id: userId, username: username || 'Unknown', coins: 0, totalEarned: 0, lastDaily: null, inventory: [], redeemedCodes: [] };
    await dbWrite('users', users);
  }
  if (!users[userId].redeemedCodes) users[userId].redeemedCodes = [];
  if (!users[userId].inventory)     users[userId].inventory     = [];
  return users[userId];
}
async function saveUser(u) {
  const users = await dbRead('users');
  users[u.id] = u;
  await dbWrite('users', users);
}
async function getLeaderboard(n) {
  const users = await dbRead('users');
  return Object.values(users).sort((a, b) => b.coins - a.coins).slice(0, n);
}
async function getStore()    { return dbRead('store'); }
async function saveStore(s)  { await dbWrite('store', s); }
async function getMeta()     { return dbRead('meta'); }
async function saveMeta(m)   { await dbWrite('meta', m); }
async function getClaims()   { return dbRead('claims'); }
async function saveClaims(c) { await dbWrite('claims', c); }
async function nextClaimId() {
  const meta = await getMeta();
  meta.claimCounter = (meta.claimCounter || 0) + 1;
  await saveMeta(meta);
  return `C${meta.claimCounter}`;
}

// ══════════════════════════════════════════
//  UTIL
// ══════════════════════════════════════════
function fmt(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
  return h > 0 ? `${h}h ${m%60}m` : m > 0 ? `${m}m ${s%60}s` : `${s}s`;
}
function ts(unixMs, style = 'R') { return `<t:${Math.floor(unixMs/1000)}:${style}>`; }
function errEmbed(text) { return new EmbedBuilder().setColor(0xED4245).setDescription(`❌ ${text}`); }
function okEmbed(text)  { return new EmbedBuilder().setColor(0x57F287).setDescription(`✅ ${text}`); }

function stockEmbed(store) {
  return new EmbedBuilder()
    .setTitle('🏪 Current Stock')
    .setColor(0x5865F2)
    .setDescription('Use `/shop` to see prices and `/redeem` to purchase!')
    .addFields(
      { name: '💎 Robux',      value: store.robux      > 0 ? `**${store.robux}** available`       : '❌ Out of stock', inline: true },
      { name: '✨ Celestials', value: store.celestials > 0 ? `**${store.celestials}x** available`  : '❌ Out of stock', inline: true },
      { name: '🌟 Divines',   value: store.divines    > 0 ? `**${store.divines}x** available`     : '❌ Out of stock', inline: true }
    )
    .setFooter({ text: 'Stock updated by admins' });
}

async function updateStockEmbed(clientRef) {
  try {
    const ch = await clientRef.channels.fetch(STOCK_CHANNEL_ID);
    if (!ch) return;
    const store = await getStore();
    const embed = stockEmbed(store);
    const meta  = await getMeta();
    if (meta.stockMsgId) {
      try { const m = await ch.messages.fetch(meta.stockMsgId); await m.edit({ embeds: [embed] }); return; } catch {}
    }
    const sent = await ch.send({ embeds: [embed] });
    meta.stockMsgId = sent.id;
    await saveMeta(meta);
  } catch (e) { console.error('Stock embed error:', e.message); }
}

// ══════════════════════════════════════════
//  SLASH COMMAND DEFINITIONS
// ══════════════════════════════════════════
const { SlashCommandBuilder: SCB, PermissionFlagsBits: PFB } = require('discord.js');
const slashDefs = [
  new SCB().setName('balance').setDescription('Check your coin balance').addUserOption(o=>o.setName('user').setDescription('Check someone else').setRequired(false)),
  new SCB().setName('daily').setDescription('Claim coins (24h cooldown)'),
  new SCB().setName('rain').setDescription('[ADMIN] Rain coins — react to enter, 2 min timer').setDefaultMemberPermissions(PFB.Administrator).addIntegerOption(o=>o.setName('amount').setDescription('Total coins to rain').setRequired(true).setMinValue(10)),
  new SCB().setName('shop').setDescription('View all items and prices'),
  new SCB().setName('redeem').setDescription('Buy an item from the shop').addStringOption(o=>o.setName('item').setDescription('Item to buy').setRequired(true).addChoices(
    {name:'25 Robux — 100 coins',value:'robux_25'},{name:'50 Robux — 200 coins',value:'robux_50'},
    {name:'75 Robux — 300 coins',value:'robux_75'},{name:'100 Robux — 400 coins',value:'robux_100'},
    {name:'125 Robux — 500 coins',value:'robux_125'},{name:'150 Robux — 600 coins',value:'robux_150'},
    {name:'175 Robux — 700 coins',value:'robux_175'},{name:'200 Robux — 800 coins',value:'robux_200'},
    {name:'225 Robux — 900 coins',value:'robux_225'},{name:'250 Robux — 1000 coins',value:'robux_250'},
    {name:'Celestial ETFB — 100 coins',value:'etfb_cel'},{name:'Divine ETFB — 250 coins',value:'etfb_div'}
  )),
  new SCB().setName('inventory').setDescription('View your unclaimed items'),
  new SCB().setName('claim').setDescription('Submit a delivery claim for an item').addStringOption(o=>o.setName('id').setDescription('Claim ID, e.g. C1').setRequired(true)),
  new SCB().setName('use-code').setDescription('Redeem a code for coins').addStringOption(o=>o.setName('code').setDescription('The code to redeem').setRequired(true)),
  new SCB().setName('leaderboard').setDescription('Top 10 richest members'),
  new SCB().setName('help').setDescription('View all commands'),
  new SCB().setName('adminhelp').setDescription('View admin commands').setDefaultMemberPermissions(PFB.Administrator),
  new SCB().setName('claims').setDescription('[ADMIN] View all pending claims').setDefaultMemberPermissions(PFB.Administrator),
  new SCB().setName('claimed').setDescription('[ADMIN] Mark a claim as fulfilled').setDefaultMemberPermissions(PFB.Administrator).addStringOption(o=>o.setName('id').setDescription('Claim ID').setRequired(true)),
  new SCB().setName('deny-claim').setDescription('[ADMIN] Deny a claim and refund to inventory').setDefaultMemberPermissions(PFB.Administrator).addStringOption(o=>o.setName('id').setDescription('Claim ID').setRequired(true)),
  new SCB().setName('update-robux').setDescription('[ADMIN] Update Robux stock').setDefaultMemberPermissions(PFB.Administrator).addIntegerOption(o=>o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SCB().setName('update-etfb').setDescription('[ADMIN] Update ETFB stock').setDefaultMemberPermissions(PFB.Administrator).addStringOption(o=>o.setName('type').setDescription('Which item').setRequired(true).addChoices({name:'Divines',value:'divines'},{name:'Celestials',value:'celestials'})).addIntegerOption(o=>o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SCB().setName('give').setDescription('[ADMIN] Give coins to a user').setDefaultMemberPermissions(PFB.Administrator).addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SCB().setName('take').setDescription('[ADMIN] Take coins from a user').setDefaultMemberPermissions(PFB.Administrator).addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SCB().setName('remove-inv').setDescription('[ADMIN] Remove an item from a user inventory').setDefaultMemberPermissions(PFB.Administrator).addUserOption(o=>o.setName('user').setDescription('Target user').setRequired(true)).addStringOption(o=>o.setName('claim_id').setDescription('Claim ID to remove').setRequired(true)),
  new SCB().setName('check-inventory').setDescription('[ADMIN] View any user inventory').setDefaultMemberPermissions(PFB.Administrator).addUserOption(o=>o.setName('user').setDescription('Target user').setRequired(true)),
].map(c => c.toJSON());

// ══════════════════════════════════════════
//  COIN FLUSH (batched write)
// ══════════════════════════════════════════
let coinWriteTimer = null;
function scheduleCoinFlush() {
  if (coinWriteTimer) return;
  coinWriteTimer = setTimeout(async () => {
    coinWriteTimer = null;
    if (!cache.users) return;
    try { await binWrite('users', cache.users); cacheTime.users = Date.now(); }
    catch (e) { console.error('Coin flush error:', e.message); setTimeout(scheduleCoinFlush, 5000); }
  }, 5000);
}

// ══════════════════════════════════════════
//  CLIENT
// ══════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

// ══════════════════════════════════════════
//  SPAM DETECTION
//  5 consecutive messages in a channel = penalty
// ══════════════════════════════════════════
const channelLastMsg = new Map();
const spamCooldown   = new Set();

async function handleSpamCheck(msg) {
  const { id: uid, username } = msg.author;
  const cid   = msg.channel.id;
  const state = channelLastMsg.get(cid) || { lastUserId: null, count: 0 };
  if (state.lastUserId === uid) state.count += 1;
  else { state.lastUserId = uid; state.count = 1; }
  channelLastMsg.set(cid, state);

  if (state.count === 5 && !spamCooldown.has(uid)) {
    spamCooldown.add(uid);
    setTimeout(() => spamCooldown.delete(uid), 60_000);

    if (cache.users && cache.users[uid]) {
      cache.users[uid].coins = Math.max(0, (cache.users[uid].coins || 0) - 100);
      scheduleCoinFlush();
    } else {
      try { const u = await getUser(uid, username); u.coins = Math.max(0, u.coins - 100); await saveUser(u); } catch {}
    }
    try {
      await msg.author.send({ embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('⚠️ Spam Warning!')
        .setDescription(`You were caught spamming in <#${cid}>.\n\n**100** ${COIN_EMOJI} deducted.\n\nPlease stop spamming or you will be penalised again!`)] });
    } catch {}
    try {
      const w = await msg.channel.send({ embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`⚠️ <@${uid}> stop spamming! **100** ${COIN_EMOJI} deducted.`)] });
      setTimeout(() => w.delete().catch(() => {}), 8000);
    } catch {}
  }
}

// ══════════════════════════════════════════
//  READY
// ══════════════════════════════════════════
client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  if (!GUILD_ID || !JSONBIN_KEY) { console.error('FATAL: missing env vars'); process.exit(1); }

  // Register slash commands (requires CLIENT_ID env var = your bot Application ID)
  const CLIENT_ID = (process.env.CLIENT_ID || '').trim();
  if (!CLIENT_ID) {
    console.warn('⚠️  CLIENT_ID not set — skipping slash command registration');
  } else {
    try {
      const { REST, Routes } = require('discord.js');
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      const data = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: slashDefs });
      console.log(`✅ Registered ${data.length} slash commands`);
    } catch (e) {
      console.error('Slash command registration failed:', e.message);
    }
  }

  try { await dbRead('users'); console.log('✅ Cache warmed'); } catch (e) { console.error('Cache warmup error:', e.message); }
  await updateStockEmbed(client);
  console.log('✅ Ready');
});

// ══════════════════════════════════════════
//  MESSAGE — 1 coin per message + prefix cmds
// ══════════════════════════════════════════
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  // Vouch listener
  if (msg.channel.id === VOUCH_CHANNEL_ID && pendingVouches.has(msg.author.id)) {
    if (/^vouch\s+@\S+\s+.+/i.test(msg.content)) {
      const data = pendingVouches.get(msg.author.id);
      clearTimeout(data.timeout);
      pendingVouches.delete(msg.author.id);
      try { await msg.react('✅'); } catch {}
    }
  }

  // Spam check
  await handleSpamCheck(msg);

  // Coin tracking
  const uid = msg.author.id;
  if (!cache.users) { try { await dbRead('users'); } catch {} }
  if (cache.users) {
    if (!cache.users[uid]) {
      cache.users[uid] = { id: uid, username: msg.author.username, coins: 0, totalEarned: 0, lastDaily: null, inventory: [], redeemedCodes: [] };
    }
    cache.users[uid].coins       = (cache.users[uid].coins       || 0) + 1;
    cache.users[uid].totalEarned = (cache.users[uid].totalEarned || 0) + 1;
    cache.users[uid].username    = msg.author.username;
    scheduleCoinFlush();
  } else {
    getUser(uid, msg.author.username).then(u => {
      u.coins++;
      u.totalEarned = (u.totalEarned || 0) + 1;
      saveUser(u).catch(() => {});
    }).catch(() => {});
  }

  // Prefix commands
  if (!msg.content.startsWith(PREFIX)) return;
  const args    = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd     = args.shift().toLowerCase();
  const reply   = p => msg.reply(p);
  const isAdmin = msg.member?.permissions.has(PermissionFlagsBits.Administrator);

  try {
    if (cmd === 'balance' || cmd === 'bal') return await cmdBalance(reply, msg.mentions.users.first() || msg.author);
    if (cmd === 'daily')                    return await cmdDaily(reply, uid, msg.author.username);
    if (cmd === 'shop')                     return await cmdShop(reply);
    if (cmd === 'inventory')                return await cmdInventory(reply, uid, msg.author.username);
    if (cmd === 'lb' || cmd === 'leaderboard') return await cmdLeaderboard(reply, msg.guild);
    if (cmd === 'help')                     return await cmdHelp(reply);
    if (cmd === 'adminhelp' && isAdmin)     return await cmdAdminHelp(reply);
    if (cmd === 'use-code') {
      if (!args[0]) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}use-code <code>\``)] });
      return await cmdUseCode(reply, uid, msg.author.username, args[0]);
    }
    if (cmd === 'rain') {
      if (!isAdmin) return reply({ embeds: [errEmbed('Only admins can use rain!')] });
      const amt = parseInt(args[0]);
      if (isNaN(amt) || amt < 10) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}rain <amount>\` (min 10)`)] });
      return await cmdRain(msg, msg.guild, uid, msg.author.username, amt);
    }
    if (cmd === 'redeem') {
      if (!args[0]) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}redeem <itemId>\``)] });
      return await cmdRedeem(reply, uid, msg.author.username, args[0].toLowerCase());
    }
    if (cmd === 'give' && isAdmin) {
      const t = msg.mentions.users.first(), amt = parseInt(args[1]);
      if (!t || isNaN(amt) || amt < 1) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}give @user <amount>\``)] });
      const u = await getUser(t.id, t.username); u.coins += amt; u.totalEarned = (u.totalEarned||0)+amt; await saveUser(u);
      return reply({ embeds: [okEmbed(`Gave **${amt}** ${COIN_EMOJI} to <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
    if (cmd === 'take' && isAdmin) {
      const t = msg.mentions.users.first(), amt = parseInt(args[1]);
      if (!t || isNaN(amt) || amt < 1) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}take @user <amount>\``)] });
      const u = await getUser(t.id, t.username); u.coins = Math.max(0, u.coins - amt); await saveUser(u);
      return reply({ embeds: [okEmbed(`Took **${amt}** ${COIN_EMOJI} from <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
  } catch (e) {
    console.error(`Prefix ${cmd}:`, e);
    reply({ embeds: [errEmbed('Something went wrong!')] }).catch(() => {});
  }
});

// ══════════════════════════════════════════
//  COMMAND FUNCTIONS
// ══════════════════════════════════════════
async function cmdBalance(reply, target) {
  const u = await getUser(target.id, target.username);
  return reply({ embeds: [new EmbedBuilder()
    .setColor(0xF1C40F)
    .setAuthor({ name: `${target.username}'s Balance`, iconURL: target.displayAvatarURL() })
    .setDescription(`## ${COIN_EMOJI} ${u.coins.toLocaleString()} coins`)
    .setFooter({ text: `Total earned: ${(u.totalEarned||0).toLocaleString()} coins` })] });
}

async function cmdDaily(reply, userId, username) {
  const u = await getUser(userId, username);
  const cd = 24*60*60*1000, now = Date.now();
  if (u.lastDaily && now - u.lastDaily < cd)
    return reply({ embeds: [errEmbed(`Next daily ready ${ts(u.lastDaily+cd)} (${ts(u.lastDaily+cd,'T')})`)] });
  const earned = Math.floor(Math.random()*6) + 10; // 10–15
  u.coins += earned; u.totalEarned = (u.totalEarned||0)+earned; u.lastDaily = now;
  await saveUser(u);
  const next = now + cd;
  return reply({ embeds: [new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎁 Daily Claimed!')
    .setDescription(`You received **${earned}** ${COIN_EMOJI}!\nBalance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)
    .setFooter({ text: 'Next daily available' })
    .setTimestamp(next)] });
}

async function cmdUseCode(reply, userId, username, codeInput) {
  const key = codeInput.toUpperCase().trim(), code = CODES[key];
  if (!code) return reply({ embeds: [errEmbed(`Code \`${key}\` doesn't exist!`)] });
  const u = await getUser(userId, username);
  if (u.redeemedCodes.includes(key)) return reply({ embeds: [errEmbed(`You've already redeemed \`${key}\`!`)] });
  u.coins += code.coins; u.totalEarned = (u.totalEarned||0)+code.coins; u.redeemedCodes.push(key);
  await saveUser(u);
  return reply({ embeds: [new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎟️ Code Redeemed!')
    .setDescription(`${code.description}\nYou received **${code.coins}** ${COIN_EMOJI}!\nBalance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
}

async function cmdShop(reply) {
  const robuxLines = SHOP.filter(i => i.category === 'Robux')
    .map(i => `💎 **${i.name}** — \`${i.cost}\` ${COIN_EMOJI}  ·  \`${i.id}\``).join('\n');
  const etfbLines = SHOP.filter(i => i.category === 'ETFB')
    .map(i => `${i.id==='etfb_cel'?'✨':'🌟'} **${i.name}** — \`${i.cost}\` ${COIN_EMOJI}  ·  \`${i.id}\``).join('\n');
  return reply({ embeds: [new EmbedBuilder()
    .setTitle('🏪 Rewards Shop')
    .setColor(0x9B59B6)
    .addFields(
      { name: '💎 Robux', value: robuxLines, inline: false },
      { name: '🎮 ETFB',  value: etfbLines,  inline: false }
    )
    .setFooter({ text: 'Buy: /redeem  |  Then: /claim <id>' })] });
}

async function cmdInventory(reply, userId, username) {
  const u = await getUser(userId, username), inv = u.inventory || [];
  if (!inv.length) return reply({ embeds: [errEmbed('Your inventory is empty! Use `/redeem` to buy items.')] });
  const list = inv.map(item => {
    const e = item.category==='Robux' ? '💎' : item.name==='Divine' ? '🌟' : '✨';
    return `${e} **${item.name}** — \`${item.claimId}\`\n> \`/claim ${item.claimId}\` to submit`;
  }).join('\n\n');
  return reply({ embeds: [new EmbedBuilder()
    .setTitle(`🎒 ${username}'s Inventory`)
    .setColor(0x9B59B6)
    .setDescription(list)
    .setFooter({ text: `${inv.length} item(s) · /claim <id> to submit` })] });
}

async function cmdLeaderboard(reply, guild) {
  const top = await getLeaderboard(50);
  const medals = ['🥇','🥈','🥉'];
  const filtered = [];
  for (const u of top) {
    if (filtered.length >= 10) break;
    try {
      const m = await guild.members.fetch(u.id);
      if (!m.permissions.has(PermissionFlagsBits.Administrator)) filtered.push(u);
    } catch {}
  }
  const list = filtered.map((u,i) => `${medals[i]||`**${i+1}.**`} <@${u.id}> — **${u.coins.toLocaleString()}** ${COIN_EMOJI}`).join('\n');
  return reply({ embeds: [new EmbedBuilder().setTitle('🏆 Coin Leaderboard').setColor(0xF1C40F).setDescription(list||'No data yet!')] });
}

async function cmdHelp(reply) {
  return reply({ embeds: [new EmbedBuilder()
    .setTitle(`📖 Help — Prefix: \`${PREFIX}\``)
    .setColor(0x5865F2)
    .addFields(
      { name: '💰 Economy', value: `\`${PREFIX}balance\` — check your ${COIN_EMOJI}\n\`${PREFIX}daily\` — 10–15 ${COIN_EMOJI} every 24h\n\`${PREFIX}leaderboard\` — top 10\n💬 Every message = 1 ${COIN_EMOJI}`, inline: false },
      { name: '🛒 Shop',    value: `\`${PREFIX}shop\` — view items & prices\n\`${PREFIX}redeem <id>\` — buy an item\n\`${PREFIX}inventory\` — view your items\n\`/claim <id>\` — submit a delivery claim`, inline: false },
      { name: '🎟️ Codes',  value: `\`/use-code <code>\` or \`${PREFIX}use-code <code>\``, inline: false }
    )] });
}

async function cmdAdminHelp(reply) {
  return reply({ embeds: [new EmbedBuilder()
    .setTitle('🔒 Admin Commands')
    .setColor(0xFF6B35)
    .addFields(
      { name: '📦 Stock',      value: `/update-robux <amount>\n/update-etfb <type> <amount>`, inline: false },
      { name: '👥 Coins',      value: `/give @user <amount>\n/take @user <amount>`, inline: false },
      { name: '🌧️ Rain',     value: `/rain <amount> — 2 min reaction rain`, inline: false },
      { name: '📋 Claims',    value: `/claims\n/claimed <id>\n/deny-claim <id>`, inline: false },
      { name: '🎒 Inventory', value: `/check-inventory @user\n/remove-inv @user <id>`, inline: false }
    )] });
}

async function cmdRedeem(reply, userId, username, itemId) {
  const item = SHOP.find(i => i.id === itemId);
  if (!item) return reply({ embeds: [errEmbed('Unknown item ID. Use `/shop` to see valid IDs.')] });
  const u = await getUser(userId, username);
  if (u.coins < item.cost) return reply({ embeds: [errEmbed(`Need **${item.cost}** ${COIN_EMOJI}, you only have **${u.coins}**!`)] });
  const store = await getStore();
  if (item.id==='etfb_cel' && store.celestials<=0) return reply({ embeds: [errEmbed('Celestials are out of stock!')] });
  if (item.id==='etfb_div' && store.divines<=0)    return reply({ embeds: [errEmbed('Divines are out of stock!')] });
  if (item.category==='Robux' && store.robux<item.robuxAmt) return reply({ embeds: [errEmbed(`Only **${store.robux}** Robux in stock!`)] });
  if (item.id==='etfb_cel')         store.celestials = Math.max(0, store.celestials-1);
  else if (item.id==='etfb_div')    store.divines    = Math.max(0, store.divines-1);
  else                              store.robux      = Math.max(0, store.robux-item.robuxAmt);
  await saveStore(store);
  await updateStockEmbed(client);
  const claimId = await nextClaimId();
  u.coins -= item.cost;
  u.inventory.push({ claimId, itemId: item.id, name: item.name, category: item.category, robuxAmt: item.robuxAmt, cost: item.cost });
  await saveUser(u);
  return reply({ embeds: [new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎒 Added to Inventory!')
    .setDescription(`**${item.name}** is now in your inventory!\nBalance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}\n\n📬 Claim ID: \`${claimId}\`\nUse \`/claim ${claimId}\` to submit!`)] });
}

async function cmdRain(msgOrInteraction, guild, senderId, senderName, amount) {
  const isInt = !!msgOrInteraction.deferReply;
  const sender = await getUser(senderId, senderName);
  const errR = t => {
    const e = errEmbed(t);
    return isInt ? msgOrInteraction.editReply({ embeds: [e] }) : msgOrInteraction.reply({ embeds: [e] });
  };
  if (sender.coins < amount) return errR(`You only have **${sender.coins}** ${COIN_EMOJI}!`);
  const endsAt = Date.now() + 2*60*1000;
  const rainEmbed = new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle('🌧️ Coin Rain — React to Enter!')
    .setDescription(`<@${senderId}> is raining **${amount}** ${COIN_EMOJI}!\n\nReact with 🌧️ to enter!\nCoins split equally.\n\n⏰ Ends ${ts(endsAt)} (${ts(endsAt,'T')} your time)`);
  let rainMsg;
  if (isInt) { await msgOrInteraction.editReply({ embeds: [rainEmbed] }); rainMsg = await msgOrInteraction.fetchReply(); }
  else rainMsg = await msgOrInteraction.reply({ embeds: [rainEmbed] });
  await rainMsg.react('🌧️');
  setTimeout(async () => {
    try {
      const fresh = await rainMsg.fetch();
      const reaction = fresh.reactions.cache.get('🌧️');
      let reactors = [];
      if (reaction) {
        const users = await reaction.users.fetch();
        reactors = [...users.values()].filter(u => !u.bot && u.id !== senderId);
      }
      if (!reactors.length) {
        return rainMsg.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🌧️ Rain Ended').setDescription(`Nobody reacted! **${amount}** ${COIN_EMOJI} refunded to <@${senderId}>.`)] });
      }
      const per = Math.floor(amount / reactors.length);
      if (per < 1) {
        return rainMsg.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🌧️ Rain Ended').setDescription(`Too many reactors! **${amount}** ${COIN_EMOJI} refunded to <@${senderId}>.`)] });
      }
      const totalGiven = per * reactors.length;
      const su = await getUser(senderId, senderName);
      su.coins = Math.max(0, su.coins - totalGiven);
      await saveUser(su);
      const names = [];
      for (const r of reactors) {
        const u = await getUser(r.id, r.username);
        u.coins += per; u.totalEarned = (u.totalEarned||0)+per;
        await saveUser(u);
        names.push(`<@${r.id}>`);
      }
      await rainMsg.reply({ embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🌧️ Rain Finished!')
        .setDescription(`<@${senderId}> rained **${totalGiven}** ${COIN_EMOJI} across **${reactors.length}** members!\nEach got **${per}** ${COIN_EMOJI}\n\n**Winners:** ${names.join(' ')}`)] });
    } catch (e) { console.error('Rain end error:', e.message); }
  }, 2*60*1000);
}

// ══════════════════════════════════════════
//  INTERACTION HANDLER
// ══════════════════════════════════════════
client.on('interactionCreate', async interaction => {

  // ── MODAL SUBMIT ──
  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith('claim_modal_')) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const claimId = interaction.customId.replace('claim_modal_', '');
    const u       = await getUser(interaction.user.id, interaction.user.username);
    const idx     = (u.inventory||[]).findIndex(i => i.claimId === claimId);
    if (idx === -1) return interaction.editReply({ embeds: [errEmbed('Item not found in your inventory.')] });
    const item         = u.inventory[idx];
    const robloxUser   = interaction.fields.getTextInputValue('roblox_username').trim();
    const gamepassLink = item.category === 'Robux' ? interaction.fields.getTextInputValue('gamepass_link').trim() : null;
    const claims = await getClaims(), claimsArr = Array.isArray(claims) ? claims : [];
    claimsArr.push({
      claimId,
      userId:         interaction.user.id,
      username:       interaction.user.username,
      itemId:         item.itemId || item.id,
      itemName:       item.name,
      category:       item.category,
      robuxAmt:       item.robuxAmt || 0,
      robloxUsername: robloxUser,
      gamepassLink:   gamepassLink || null,
      claimedAt:      Date.now(),
      status:         'pending',
    });
    await saveClaims(claimsArr);
    u.inventory.splice(idx, 1);
    await saveUser(u);
    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('📬 Claim Submitted!')
      .setDescription(
        `Your claim for **${item.name}** has been submitted!\n\n` +
        `**Claim ID:** \`${claimId}\`\n` +
        `**Roblox:** \`${robloxUser}\`\n` +
        (gamepassLink ? `**Gamepass:** ${gamepassLink}\n` : '') +
        `\nAn admin will process this shortly!`
      )] });
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd   = interaction.commandName;
  const me    = interaction.user;
  const reply = p => interaction.reply(p);

  try {
    if (cmd === 'balance')     return await cmdBalance(reply, interaction.options.getUser('user') || me);
    if (cmd === 'daily')       return await cmdDaily(reply, me.id, me.username);
    if (cmd === 'shop')        return await cmdShop(reply);
    if (cmd === 'inventory')   return await cmdInventory(reply, me.id, me.username);
    if (cmd === 'leaderboard') return await cmdLeaderboard(reply, interaction.guild);
    if (cmd === 'help')        return await cmdHelp(reply);
    if (cmd === 'adminhelp')   return await cmdAdminHelp(reply);
    if (cmd === 'use-code')    return await cmdUseCode(reply, me.id, me.username, interaction.options.getString('code'));

    if (cmd === 'rain') {
      await interaction.deferReply();
      return await cmdRain(interaction, interaction.guild, me.id, me.username, interaction.options.getInteger('amount'));
    }
    if (cmd === 'redeem') {
      await interaction.deferReply();
      return await cmdRedeem(p => interaction.editReply(p), me.id, me.username, interaction.options.getString('item'));
    }

    // /claim — show modal
    if (cmd === 'claim') {
      const idArg = interaction.options.getString('id').toUpperCase();
      const u     = await getUser(me.id, me.username);
      const item  = (u.inventory||[]).find(i => i.claimId === idArg);
      if (!item) return reply({ embeds: [errEmbed(`No item \`${idArg}\` in your inventory.`)], flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId(`claim_modal_${item.claimId}`).setTitle(`Claim: ${item.name}`);
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('roblox_username').setLabel('Your Roblox Username')
          .setStyle(TextInputStyle.Short).setPlaceholder('e.g. Builderman').setRequired(true)
      ));
      if (item.category === 'Robux') {
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('gamepass_link')
            .setLabel(`Gamepass Link (set price to ${item.robuxAmt||0} Robux)`)
            .setStyle(TextInputStyle.Short).setPlaceholder('https://www.roblox.com/game-pass/...').setRequired(true)
        ));
      }
      return interaction.showModal(modal);
    }

    // /claims
    if (cmd === 'claims') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const allClaims = await getClaims();
      const pending   = (Array.isArray(allClaims) ? allClaims : []).filter(c => c.status === 'pending');
      if (!pending.length) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('✅ No pending claims!')] });
      const fields = pending.map(c => ({
        name:  `${c.claimId} — ${c.itemName}`,
        value: `👤 **${c.username}** · Roblox: \`${c.robloxUsername}\`\n${c.gamepassLink ? `🔗 ${c.gamepassLink}\n` : ''}📅 ${ts(c.claimedAt,'R')}`,
        inline: false,
      }));
      const chunks = [];
      for (let i = 0; i < fields.length; i += 10) chunks.push(fields.slice(i, i+10));
      for (let i = 0; i < chunks.length; i++) {
        const e = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setTitle(i === 0 ? `📋 Pending Claims — ${pending.length} total` : '📋 (continued)')
          .addFields(chunks[i])
          .setFooter({ text: '/claimed <id>  ·  /deny-claim <id>' });
        if (i === 0) await interaction.editReply({ embeds: [e] });
        else         await interaction.followUp({ embeds: [e], flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // /claimed
    if (cmd === 'claimed') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const claimId   = interaction.options.getString('id').toUpperCase();
      const allClaims = await getClaims();
      const arr       = Array.isArray(allClaims) ? allClaims : [];
      const idx       = arr.findIndex(c => c.claimId === claimId);
      if (idx === -1)                    return interaction.editReply({ embeds: [errEmbed(`Claim \`${claimId}\` not found.`)] });
      if (arr[idx].status==='fulfilled') return interaction.editReply({ embeds: [errEmbed('Already fulfilled.')] });
      if (arr[idx].status==='denied')    return interaction.editReply({ embeds: [errEmbed('Already denied.')] });
      const claim = arr[idx];
      arr[idx].status = 'fulfilled'; arr[idx].fulfilledAt = Date.now(); arr[idx].fulfilledBy = me.username;
      await saveClaims(arr);
      const dmText = claim.category === 'Robux'
        ? `Your **${claim.itemName}** has been sent! Check your Roblox gamepass.`
        : `Your **${claim.itemName} (ETFB)** is ready!\n\n**vru4447** has sent you a friend request. Accept it and they'll join your game to deliver!`;
      let dmSent = false;
      try {
        const t = await client.users.fetch(claim.userId);
        await t.send({ embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('🎉 Reward Delivered!')
          .setDescription(`✅ ${dmText}`)
          .addFields(
            { name: 'Claim ID', value: `\`${claimId}\``,    inline: true },
            { name: 'Item',     value: claim.itemName,       inline: true },
            { name: 'Roblox',   value: claim.robloxUsername, inline: true }
          )] });
        dmSent = true;
      } catch {}
      // Public channel notification
      try {
        await interaction.channel.send({ embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('🎉 Claim Fulfilled!')
          .setDescription(
            `<@${claim.userId}> your claim **${claimId}** for **${claim.itemName}** has been fulfilled by <@${me.id}>!\n` +
            (claim.category === 'Robux' ? 'Check your Roblox gamepass!' : 'Accept the friend request from **vru4447** on Roblox!')
          )] });
      } catch {}
      // Vouch request
      try {
        const vch = await client.channels.fetch(VOUCH_CHANNEL_ID);
        if (vch) {
          await vch.send({
            content: `<@${claim.userId}>`,
            embeds: [new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('⭐ Please Leave a Vouch!')
              .setDescription(
                `Hey <@${claim.userId}>! You got **${claim.itemName}** 🎉\n\n` +
                `Please vouch so others know we're legit!\n\n` +
                `**Format:** \`Vouch @${me.username} <reason>\``
              )
              .setFooter({ text: `Claim ${claimId}` })],
          });
          const vt = setTimeout(async () => {
            pendingVouches.delete(claim.userId);
            try {
              const u = await client.users.fetch(claim.userId);
              await u.send({ embeds: [new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle("⭐ Don't forget to vouch!")
                .setDescription(`Head to <#${VOUCH_CHANNEL_ID}> and type:\n\`Vouch @${me.username} <reason>\`\n\nIt only takes a second! 🙏`)] });
            } catch {}
            try {
              const ach = await client.channels.fetch(ALERT_CHANNEL_ID);
              if (ach) await ach.send({ embeds: [new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('⚠️ Vouch Not Received')
                .setDescription(`<@${claim.userId}> hasn't vouched after receiving **${claim.itemName}** (\`${claimId}\`).`)] });
            } catch {}
          }, 10*60*1000);
          pendingVouches.set(claim.userId, { claimId, itemName: claim.itemName, fulfilledBy: me.username, timeout: vt });
        }
      } catch {}
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Claim Fulfilled')
        .addFields(
          { name: 'Claim', value: `\`${claimId}\``,      inline: true },
          { name: 'User',  value: `<@${claim.userId}>`,   inline: true },
          { name: 'Item',  value: claim.itemName,          inline: true },
          { name: 'DM',    value: dmSent ? '✅ Sent' : '❌ DMs off', inline: true }
        )] });
    }

    // /deny-claim
    if (cmd === 'deny-claim') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const claimId   = interaction.options.getString('id').toUpperCase();
      const allClaims = await getClaims();
      const arr       = Array.isArray(allClaims) ? allClaims : [];
      const idx       = arr.findIndex(c => c.claimId === claimId);
      if (idx === -1)                    return interaction.editReply({ embeds: [errEmbed(`Claim \`${claimId}\` not found.`)] });
      if (arr[idx].status==='fulfilled') return interaction.editReply({ embeds: [errEmbed('Already fulfilled.')] });
      if (arr[idx].status==='denied')    return interaction.editReply({ embeds: [errEmbed('Already denied.')] });
      const claim = arr[idx];
      arr[idx].status = 'denied'; arr[idx].deniedAt = Date.now(); arr[idx].deniedBy = me.username;
      await saveClaims(arr);
      const shopItem = SHOP.find(i => i.id === claim.itemId);
      const u = await getUser(claim.userId, claim.username);
      u.inventory.push({ claimId: claim.claimId, itemId: claim.itemId, name: claim.itemName, category: claim.category, robuxAmt: claim.robuxAmt||0, cost: shopItem ? shopItem.cost : 0 });
      await saveUser(u);
      const store = await getStore();
      if      (claim.category==='Robux')      store.robux      += (claim.robuxAmt||0);
      else if (claim.itemId==='etfb_cel')     store.celestials += 1;
      else if (claim.itemId==='etfb_div')     store.divines    += 1;
      await saveStore(store);
      await updateStockEmbed(client);
      let dmSent = false;
      try {
        const t = await client.users.fetch(claim.userId);
        await t.send({ embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('❌ Claim Denied')
          .setDescription(`Your claim \`${claimId}\` for **${claim.itemName}** was denied.\n\nThe item has been returned to your inventory.\nUse \`/claim ${claimId}\` to re-submit.`)] });
        dmSent = true;
      } catch {}
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('❌ Claim Denied')
        .addFields(
          { name: 'Claim',    value: `\`${claimId}\``,       inline: true },
          { name: 'User',     value: `<@${claim.userId}>`,    inline: true },
          { name: 'Item',     value: claim.itemName,           inline: true },
          { name: 'Refunded', value: '✅ Inventory',           inline: true },
          { name: 'Stock',    value: '✅ Restored',            inline: true },
          { name: 'DM',       value: dmSent ? '✅ Sent' : '❌ DMs off', inline: true }
        )] });
    }

    if (cmd === 'give') {
      const t = interaction.options.getUser('user'), amt = interaction.options.getInteger('amount');
      const u = await getUser(t.id, t.username); u.coins += amt; u.totalEarned = (u.totalEarned||0)+amt; await saveUser(u);
      return reply({ embeds: [okEmbed(`Gave **${amt}** ${COIN_EMOJI} to <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
    if (cmd === 'take') {
      const t = interaction.options.getUser('user'), amt = interaction.options.getInteger('amount');
      const u = await getUser(t.id, t.username); u.coins = Math.max(0, u.coins-amt); await saveUser(u);
      return reply({ embeds: [okEmbed(`Took **${amt}** ${COIN_EMOJI} from <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
    if (cmd === 'remove-inv') {
      const t       = interaction.options.getUser('user');
      const claimId = interaction.options.getString('claim_id').toUpperCase();
      const u       = await getUser(t.id, t.username);
      const idx     = (u.inventory||[]).findIndex(i => i.claimId === claimId);
      if (idx === -1) return reply({ embeds: [errEmbed(`No item \`${claimId}\` in <@${t.id}>'s inventory.`)], flags: MessageFlags.Ephemeral });
      const removed = u.inventory.splice(idx, 1)[0];
      await saveUser(u);
      return reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🗑️ Removed').setDescription(`Removed **${removed.name}** (\`${claimId}\`) from <@${t.id}>'s inventory.`)] });
    }
    if (cmd === 'check-inventory') {
      const t   = interaction.options.getUser('user');
      const u   = await getUser(t.id, t.username), inv = u.inventory || [];
      if (!inv.length) return reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription(`🎒 <@${t.id}>'s inventory is empty.`)], flags: MessageFlags.Ephemeral });
      const list = inv.map(i => `${i.category==='Robux'?'💎':i.name==='Divine'?'🌟':'✨'} **${i.name}** — \`${i.claimId}\``).join('\n');
      return reply({ embeds: [new EmbedBuilder().setTitle(`🎒 ${t.username}'s Inventory`).setColor(0x9B59B6).setDescription(list).setFooter({ text: `${inv.length} item(s)` })], flags: MessageFlags.Ephemeral });
    }
    if (cmd === 'update-robux') {
      await interaction.deferReply();
      const store = await getStore(); store.robux = interaction.options.getInteger('amount');
      await saveStore(store); await updateStockEmbed(client);
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`💎 Robux set to **${store.robux}**.`)] });
    }
    if (cmd === 'update-etfb') {
      await interaction.deferReply();
      const type = interaction.options.getString('type'), amt = interaction.options.getInteger('amount');
      const store = await getStore(); store[type] = amt;
      await saveStore(store); await updateStockEmbed(client);
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`${type==='divines'?'🌟 Divines':'✨ Celestials'} set to **${amt}x**.`)] });
    }

  } catch (e) {
    console.error(`/${cmd} error:`, e);
    const err = { embeds: [errEmbed('Something went wrong!')], flags: MessageFlags.Ephemeral };
    try { interaction.replied || interaction.deferred ? await interaction.followUp(err) : await interaction.reply(err); } catch {}
  }
});

// Heartbeat log every 5 min so host doesn't think it's dead
setInterval(() => console.log('Heartbeat:', new Date().toISOString()), 300_000);

client.login(BOT_TOKEN);
