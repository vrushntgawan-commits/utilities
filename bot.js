process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
process.on('uncaughtException',  e => console.error('Uncaught exception:', e));

const {
  Client, GatewayIntentBits,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags
} = require('discord.js');
const fetch = require('node-fetch');
require('dotenv').config();

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

const STOCK_CHANNEL_ID = '1481026325178220565';
const VOUCH_CHANNEL_ID = '1481321672970735807';
const ALERT_CHANNEL_ID = '1480833457604268154';
const GTN_CHANNEL_ID   = '1482076857321914378';
const DROP_CHANNEL_ID  = '1481582652430483579';
const LOG_CHANNEL_ID   = '1482112291750150214';
const GUILD_ID         = (process.env.GUILD_ID   || '').trim();
const JSONBIN_KEY      =  process.env.JSONBIN_KEY;
const BOT_TOKEN        =  process.env.BOT_TOKEN;
const COIN_EMOJI       = '<:CoinEmoji:1481246827448766526>';
const ROBUX_EMOJI      = '<:robux:1481247240914731109>';
const PREFIX           = 'u!';

const MOD_KEYWORDS = ['moderator', 'mod', 'admin', 'staff', 'helper', 'support'];
function isModerator(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(r => MOD_KEYWORDS.some(kw => r.name.toLowerCase().includes(kw)));
}

// ══════════════════════════════════════════
//  HARDCODED PERMANENT CODES (always exist)
// ══════════════════════════════════════════
const PERMANENT_CODES = {
  'RELEASE': { coins: 25, description: '🎉 Launch reward' },
  // LOOTDROP: special 1-claim mystery box, reset by admin each drop
};

const pendingVouches = new Map();
const activeGTN = new Map();

// ── Active Blackjack games: Map<userId, gameState> ──
const activeBlackjack = new Map();

// ── Active Loot Drop state ──
// { coins, claimedBy: null|userId }
let activeLootDrop = null;

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
//  ⚠️  Create a new bin at jsonbin.io and paste the ID for CODES below
// ══════════════════════════════════════════
const BIN_IDS = {
  users:  '69b13ea5c3097a1dd516fe70',
  store:  '69b13e7dc3097a1dd516fdc5',
  meta:   '69b13e8fb7ec241ddc5c5aa3',
  claims: '69b13ebbb7ec241ddc5c5b4b',
  warns:  '69b13ebbb7ec241ddc5c5b4c',
  codes:   '69b3f981b7ec241ddc65e003',
  roblox:  '69b663fab7ec241ddc6d458d',
};
const DEFAULTS = {
  users:  {},
  store:  { robux: 0, divines: 0, celestials: 0 },
  roblox: {},
  meta:   { stockMsgId: null, claimCounter: 0 },
  claims: [],
  warns:  {},
  codes:  {},
};
const cache     = { users: null, store: null, meta: null, claims: null, warns: null, codes: null };
const cacheTime = { users: 0,    store: 0,    meta: 0,    claims: 0,    warns: 0,    codes: 0    };
const CACHE_TTL = { users: Infinity, store: 30_000, meta: 30_000, claims: 30_000, warns: 30_000, codes: 60_000 };

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
  if (Array.isArray(data) && data.length === 0) payload = { _empty: true, _data: [] };
  else if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0) payload = { _empty: true, _data: {} };
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
  cache[name] = data; cacheTime[name] = Date.now();
  await binWrite(name, data);
}

// ══════════════════════════════════════════
//  CODES HELPERS
//  Merges permanent hardcoded codes with saved codes from JSONBin
// ══════════════════════════════════════════
async function getCodes() {
  const saved = await dbRead('codes');
  // Purge expired codes from the bin automatically
  let dirty = false;
  for (const [key, code] of Object.entries(saved)) {
    if (code.expiresAt && Date.now() > code.expiresAt) {
      delete saved[key];
      dirty = true;
    }
  }
  if (dirty) await dbWrite('codes', saved);
  // Merge: saved codes override permanent ones if they share a key (shouldn't happen normally)
  return { ...PERMANENT_CODES, ...saved };
}

async function getCode(key) {
  const all = await getCodes();
  return all[key.toUpperCase()] || null;
}

async function saveCode(key, codeObj) {
  const saved = await dbRead('codes');
  saved[key.toUpperCase()] = codeObj;
  await dbWrite('codes', saved);
}

async function deleteCode(key) {
  const saved = await dbRead('codes');
  delete saved[key.toUpperCase()];
  await dbWrite('codes', saved);
}

async function codeExists(key) {
  const all = await getCodes();
  return key.toUpperCase() in all;
}

// DB helpers
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
async function saveUser(u) { const users = await dbRead('users'); users[u.id] = u; await dbWrite('users', users); }
async function getLeaderboard(n) { const users = await dbRead('users'); return Object.values(users).sort((a,b)=>b.coins-a.coins).slice(0,n); }
async function getStore()    { return dbRead('store'); }
async function saveStore(s)  { await dbWrite('store', s); }
async function getMeta()     { return dbRead('meta'); }
async function saveMeta(m)   { await dbWrite('meta', m); }
async function getClaims()   { cacheTime.claims = 0; return dbRead('claims'); } // always read fresh
async function saveClaims(c) { await dbWrite('claims', c); cacheTime.claims = 0; } // always bust cache after write
async function getWarns(uid) { const w = await dbRead('warns'); return w[uid] || []; }
async function saveWarns(uid, arr) { const w = await dbRead('warns'); w[uid] = arr; await dbWrite('warns', w); }
async function nextClaimId() {
  const meta = await getMeta();
  meta.claimCounter = (meta.claimCounter || 0) + 1;
  await saveMeta(meta);
  return `C${meta.claimCounter}`;
}

function fmt(ms) { const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60); return h>0?`${h}h ${m%60}m`:m>0?`${m}m ${s%60}s`:`${s}s`; }
function ts(unixMs, style='R') { return `<t:${Math.floor(unixMs/1000)}:${style}>`; }
function errEmbed(text) { return new EmbedBuilder().setColor(0xED4245).setDescription(`❌ ${text}`); }
function okEmbed(text)  { return new EmbedBuilder().setColor(0x57F287).setDescription(`✅ ${text}`); }


// ══════════════════════════════════════════
//  LOG HELPER
// ══════════════════════════════════════════
async function sendLog(clientRef, fields) {
  try {
    const ch = await clientRef.channels.fetch(LOG_CHANNEL_ID);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setColor(fields.color || 0x5865F2)
      .setTitle(fields.title || '📋 Log')
      .setTimestamp();
    if (fields.description) embed.setDescription(fields.description);
    if (fields.fields) embed.addFields(...fields.fields);
    if (fields.user) embed.setFooter({ text: `User: ${fields.user}` });
    await ch.send({ embeds: [embed] });
  } catch(e) { console.error('Log send error:', e.message); }
}

function stockEmbed(store) {
  return new EmbedBuilder().setTitle('🏪 Current Stock').setColor(0x5865F2)
    .setDescription('Use `/shop` to see prices and `/redeem` to purchase!')
    .addFields(
      { name: '💎 Robux',      value: store.robux      > 0 ? `**${store.robux}** available`      : '❌ Out of stock', inline: true },
      { name: '✨ Celestials', value: store.celestials > 0 ? `**${store.celestials}x** available` : '❌ Out of stock', inline: true },
      { name: '🌟 Divines',   value: store.divines    > 0 ? `**${store.divines}x** available`    : '❌ Out of stock', inline: true }
    ).setFooter({ text: 'Stock updated by admins' });
}

async function updateStockEmbed(clientRef) {
  try {
    const ch = await clientRef.channels.fetch(STOCK_CHANNEL_ID);
    if (!ch) return;
    const store = await getStore(), embed = stockEmbed(store), meta = await getMeta();
    if (meta.stockMsgId) {
      try { const m = await ch.messages.fetch(meta.stockMsgId); await m.edit({ embeds: [embed] }); return; } catch {}
    }
    const sent = await ch.send({ embeds: [embed] });
    meta.stockMsgId = sent.id; await saveMeta(meta);
  } catch (e) { console.error('Stock embed error:', e.message); }
}

// ── Slash command defs ──
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
  new SCB().setName('deny-claim').setDescription('[ADMIN] Deny a claim and refund to inventory').setDefaultMemberPermissions(PFB.Administrator)
    .addStringOption(o=>o.setName('id').setDescription('Claim ID').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Reason for denial (optional)').setRequired(false)),
  new SCB().setName('update-robux').setDescription('[ADMIN] Update Robux stock').setDefaultMemberPermissions(PFB.Administrator).addIntegerOption(o=>o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SCB().setName('update-etfb').setDescription('[ADMIN] Update ETFB stock').setDefaultMemberPermissions(PFB.Administrator).addStringOption(o=>o.setName('type').setDescription('Which item').setRequired(true).addChoices({name:'Divines',value:'divines'},{name:'Celestials',value:'celestials'})).addIntegerOption(o=>o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SCB().setName('give').setDescription('[ADMIN] Give coins to a user').setDefaultMemberPermissions(PFB.Administrator).addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SCB().setName('take').setDescription('[ADMIN] Take coins from a user').setDefaultMemberPermissions(PFB.Administrator).addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Amount (ignored if all=true)').setRequired(false).setMinValue(1)).addBooleanOption(o=>o.setName('all').setDescription('Take ALL coins from the user').setRequired(false)),
  new SCB().setName('remove-inv').setDescription('[ADMIN] Remove an item from a user inventory').setDefaultMemberPermissions(PFB.Administrator).addUserOption(o=>o.setName('user').setDescription('Target user').setRequired(true)).addStringOption(o=>o.setName('claim_id').setDescription('Claim ID to remove').setRequired(true)),
  new SCB().setName('check-inventory').setDescription('[ADMIN] View any user inventory').setDefaultMemberPermissions(PFB.Administrator).addUserOption(o=>o.setName('user').setDescription('Target user').setRequired(true)),
  new SCB().setName('make-code').setDescription('[ADMIN] Create a permanent saved code').setDefaultMemberPermissions(PFB.Administrator)
    .addStringOption(o=>o.setName('code').setDescription('The code word').setRequired(true))
    .addIntegerOption(o=>o.setName('coins').setDescription('Coins to reward').setRequired(true).setMinValue(1))
    .addStringOption(o=>o.setName('description').setDescription('Description shown when redeemed').setRequired(false)),
  new SCB().setName('drop-code').setDescription('[ADMIN] Drop a time-limited code everyone can redeem once').setDefaultMemberPermissions(PFB.Administrator)
    .addStringOption(o=>o.setName('code').setDescription('The code word').setRequired(true))
    .addIntegerOption(o=>o.setName('coins').setDescription('Coins to reward').setRequired(true).setMinValue(1))
    .addIntegerOption(o=>o.setName('minutes').setDescription('How many minutes until the code expires').setRequired(true).setMinValue(1))
    .addStringOption(o=>o.setName('description').setDescription('Description shown when redeemed').setRequired(false)),
  new SCB().setName('remove-code').setDescription('[ADMIN] Remove/expire a code immediately').setDefaultMemberPermissions(PFB.Administrator)
    .addStringOption(o=>o.setName('code').setDescription('The code to remove').setRequired(true)),
  new SCB().setName('list-codes').setDescription('[ADMIN] View all active codes').setDefaultMemberPermissions(PFB.Administrator),
  new SCB().setName('gtn').setDescription('[ADMIN] Start a Guess the Number game').setDefaultMemberPermissions(PFB.Administrator)
    .addIntegerOption(o=>o.setName('min').setDescription('Minimum number').setRequired(true).setMinValue(1))
    .addIntegerOption(o=>o.setName('max').setDescription('Maximum number').setRequired(true).setMinValue(2))
    .addIntegerOption(o=>o.setName('number').setDescription('The winning number').setRequired(true))
    .addIntegerOption(o=>o.setName('prize').setDescription('Coins prize for the winner').setRequired(true).setMinValue(1)),
  new SCB().setName('timeout').setDescription('[MOD] Timeout a user').setDefaultMemberPermissions(PFB.ModerateMembers)
    .addUserOption(o=>o.setName('user').setDescription('User to timeout').setRequired(true))
    .addIntegerOption(o=>o.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)),
  new SCB().setName('untimeout').setDescription('[MOD] Remove timeout from a user').setDefaultMemberPermissions(PFB.ModerateMembers)
    .addUserOption(o=>o.setName('user').setDescription('User to untimeout').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)),
  new SCB().setName('warn').setDescription('[MOD] Warn a user').setDefaultMemberPermissions(PFB.ModerateMembers)
    .addUserOption(o=>o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true)),
  new SCB().setName('unwarn').setDescription('[MOD] Remove a warn from a user').setDefaultMemberPermissions(PFB.ModerateMembers)
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o=>o.setName('index').setDescription('Warn number to remove (from /warns)').setRequired(true).setMinValue(1)),
  new SCB().setName('warns').setDescription('[MOD] View warns for a user').setDefaultMemberPermissions(PFB.ModerateMembers)
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true)),
  new SCB().setName('kick').setDescription('[MOD] Kick a user').setDefaultMemberPermissions(PFB.KickMembers)
    .addUserOption(o=>o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)),
  new SCB().setName('ban').setDescription('[MOD] Ban a user').setDefaultMemberPermissions(PFB.BanMembers)
    .addUserOption(o=>o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)),
  // ── GAMBLING (open to everyone) ──
  new SCB().setName('coinflip').setDescription('Flip a coin and bet coins')
    .addIntegerOption(o=>o.setName('bet').setDescription('How many coins to bet').setRequired(true).setMinValue(1))
    .addStringOption(o=>o.setName('side').setDescription('Heads or Tails?').setRequired(true).addChoices({name:'Heads',value:'heads'},{name:'Tails',value:'tails'})),
  new SCB().setName('slots').setDescription('Spin the slot machine')
    .addIntegerOption(o=>o.setName('bet').setDescription('How many coins to bet').setRequired(true).setMinValue(1)),
  new SCB().setName('blackjack').setDescription('Play a hand of Blackjack')
    .addIntegerOption(o=>o.setName('bet').setDescription('How many coins to bet').setRequired(true).setMinValue(1)),
  new SCB().setName('doubleornothing').setDescription('Double your coins or lose them all')
    .addIntegerOption(o=>o.setName('bet').setDescription('How many coins to bet').setRequired(true).setMinValue(1)),
  new SCB().setName('lootdrop').setDescription('[ADMIN] Drop a mystery loot box (10–50 coins, first to claim wins)').setDefaultMemberPermissions(PFB.Administrator),
  new SCB().setName('add-user').setDescription('Link your Roblox username to your Discord account').addStringOption(o=>o.setName('roblox_username').setDescription('Your Roblox username').setRequired(true)),
  new SCB().setName('check-user').setDescription('See all linked Roblox users').setDefaultMemberPermissions(PFB.Administrator),
].map(c => c.toJSON());

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

const channelLastMsg = new Map();
const spamCooldown   = new Set();
async function handleSpamCheck(msg) {
  const { id: uid, username } = msg.author;
  const cid   = msg.channel.id;
  const state = channelLastMsg.get(cid) || { lastUserId: null, count: 0 };
  if (state.lastUserId === uid) state.count += 1;
  else { state.lastUserId = uid; state.count = 1; }
  channelLastMsg.set(cid, state);
  if (state.count === 15 && !spamCooldown.has(uid)) {
    spamCooldown.add(uid);
    setTimeout(() => spamCooldown.delete(uid), 60_000);
    if (cache.users && cache.users[uid]) { cache.users[uid].coins = Math.max(0,(cache.users[uid].coins||0)-100); scheduleCoinFlush(); }
    else { try { const u=await getUser(uid,username); u.coins=Math.max(0,u.coins-100); await saveUser(u); } catch {} }
    try { await msg.author.send({ embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('⚠️ Spam Warning!').setDescription(`You were caught spamming in <#${cid}>.\n\n**100** ${COIN_EMOJI} deducted.\n\nPlease stop spamming or you will be penalised again!`)] }); } catch {}
    try { const w=await msg.channel.send({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`⚠️ <@${uid}> stop spamming! **100** ${COIN_EMOJI} deducted.`)] }); setTimeout(()=>w.delete().catch(()=>{}),8000); } catch {}
  }
}

client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  if (!GUILD_ID || !JSONBIN_KEY) { console.error('FATAL: missing env vars'); process.exit(1); }
  const CLIENT_ID = (process.env.CLIENT_ID || '').trim();
  if (!CLIENT_ID) {
    console.warn('⚠️  CLIENT_ID not set — skipping slash command registration');
  } else {
    try {
      const { REST, Routes } = require('discord.js');
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      const data = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: slashDefs });
      console.log(`✅ Registered ${data.length} slash commands`);
    } catch (e) { console.error('Slash command registration failed:', e.message); }
  }
  try { await dbRead('users'); console.log('✅ Cache warmed'); } catch (e) { console.error('Cache warmup error:', e.message); }
  // Purge any old denied/fulfilled claims left over from before the fix
  try {
    const allClaims = await getClaims();
    const cleaned = (Array.isArray(allClaims) ? allClaims : []).filter(c => c.status === 'pending');
    if (cleaned.length !== allClaims.length) {
      await saveClaims(cleaned);
      console.log(`✅ Purged ${allClaims.length - cleaned.length} old non-pending claim(s) from JSONBin`);
    } else {
      console.log('✅ Claims bin is clean');
    }
  } catch (e) { console.error('Claims purge error:', e.message); }
  // Warm codes cache & log how many saved codes exist
  try {
    const codes = await dbRead('codes');
    console.log(`✅ Codes bin loaded — ${Object.keys(codes).length} saved code(s)`);
  } catch (e) { console.error('Codes bin error (did you set the bin ID?):', e.message); }
  await updateStockEmbed(client);
  console.log('✅ Ready');
});

client.on('messageCreate', async msg => {
  if (!msg.guild) return;
  if (msg.author.bot) {
    const s = channelLastMsg.get(msg.channel.id);
    if (s) { s.lastUserId = null; s.count = 0; }
    return;
  }

  // Vouch listener
  if (msg.channel.id === VOUCH_CHANNEL_ID && pendingVouches.has(msg.author.id)) {
    if (/^vouch\s+@\S+\s+.+/i.test(msg.content)) {
      const data = pendingVouches.get(msg.author.id);
      clearTimeout(data.timeout); pendingVouches.delete(msg.author.id);
      try { await msg.react('✅'); } catch {}
      if (data.alertMsg) {
        try { await data.alertMsg.edit({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Vouch Received!').setDescription(`<@${msg.author.id}> has now vouched for **${data.itemName}** (\`${data.claimId}\`).\n\n> ${msg.content}`)] }); } catch {}
      }
    }
  }

  // GTN listener
  if (msg.channel.id === GTN_CHANNEL_ID && activeGTN.has(GTN_CHANNEL_ID)) {
    const game = activeGTN.get(GTN_CHANNEL_ID);
    const guess = parseInt(msg.content.trim());
    if (!isNaN(guess) && game.active) {
      if (guess === game.answer) {
        game.active = false; activeGTN.delete(GTN_CHANNEL_ID);
        const winner = await getUser(msg.author.id, msg.author.username);
        winner.coins += game.prize; winner.totalEarned = (winner.totalEarned||0)+game.prize;
        await saveUser(winner);
        sendLog(client,{title:'🎮 GTN Winner!',color:0xF1C40F,fields:[{name:'Winner',value:`<@${msg.author.id}>`,inline:true},{name:'Answer',value:`**${game.answer}**`,inline:true},{name:'Prize',value:`**${game.prize}** ${COIN_EMOJI}`,inline:true},{name:'New Balance',value:`**${winner.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});
        try { await msg.channel.send({ embeds:[new EmbedBuilder().setColor(0xF1C40F).setTitle('🎉 We Have a Winner!').setDescription(`<@${msg.author.id}> guessed the number **${game.answer}** correctly! 🏆\n\n**Prize:** **${game.prize}** ${COIN_EMOJI}\n**New balance:** **${winner.coins.toLocaleString()}** ${COIN_EMOJI}`).setFooter({text:`Range was ${game.min}–${game.max}`}).setTimestamp()] }); } catch {}
        return;
      } else if (guess >= game.min && guess <= game.max) {
        try { await msg.react('❌'); } catch {}
      }
    }
  }

  await handleSpamCheck(msg);

  const NO_COIN_CHANNELS = ['1480831806226825308','1481371074309390346','1482076857321914378'];
  const uid = msg.author.id;
  if (!NO_COIN_CHANNELS.includes(msg.channel.id)) {
    if (!cache.users) { try { await dbRead('users'); } catch {} }
    if (cache.users) {
      if (!cache.users[uid]) cache.users[uid] = { id:uid, username:msg.author.username, coins:0, totalEarned:0, lastDaily:null, inventory:[], redeemedCodes:[] };
      cache.users[uid].coins       = (cache.users[uid].coins       || 0) + 1;
      cache.users[uid].totalEarned = (cache.users[uid].totalEarned || 0) + 1;
      cache.users[uid].username    = msg.author.username;
      scheduleCoinFlush();
    } else {
      getUser(uid, msg.author.username).then(u => { u.coins++; u.totalEarned=(u.totalEarned||0)+1; saveUser(u).catch(()=>{}); }).catch(()=>{});
    }
  }

  if (!msg.content.startsWith(PREFIX)) return;
  const args    = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd     = args.shift().toLowerCase();
  const reply   = p => msg.reply(p);
  const isAdmin = msg.member?.permissions.has(PermissionFlagsBits.Administrator);

  try {
    if (cmd==='balance'||cmd==='bal') return await cmdBalance(reply, msg.mentions.users.first()||msg.author);
    if (cmd==='daily')                return await cmdDaily(reply, uid, msg.author.username);
    if (cmd==='shop')                 return await cmdShop(reply);
    if (cmd==='inventory'||cmd==='inv') return await cmdInventory(reply, uid, msg.author.username);
    if (cmd==='lb'||cmd==='leaderboard') return await cmdLeaderboard(reply, msg.guild);
    if (cmd==='help')                 return await cmdHelp(reply);
    if (cmd==='adminhelp'&&isAdmin)   return await cmdAdminHelp(reply);
    if (cmd==='use-code') {
      if (!args[0]) return reply({ embeds:[errEmbed(`Usage: \`${PREFIX}use-code <code>\``)] });
      return await cmdUseCode(reply, uid, msg.author.username, args[0]);
    }
    if (cmd==='rain'&&isAdmin) {
      const amt=parseInt(args[0]);
      if (isNaN(amt)||amt<10) return reply({ embeds:[errEmbed(`Usage: \`${PREFIX}rain <amount>\` (min 10)`)] });
      return await cmdRain(msg, msg.guild, uid, msg.author.username, amt);
    }
    if (cmd==='redeem') {
      if (!args[0]) return reply({ embeds:[errEmbed(`Usage: \`${PREFIX}redeem <itemId>\``)] });
      return await cmdRedeem(reply, uid, msg.author.username, args[0].toLowerCase());
    }
    if (cmd==='give'&&isAdmin) {
      const t=msg.mentions.users.first(), amt=parseInt(args[1]);
      if (!t||isNaN(amt)||amt<1) return reply({ embeds:[errEmbed(`Usage: \`${PREFIX}give @user <amount>\``)] });
      const u=await getUser(t.id,t.username); u.coins+=amt; u.totalEarned=(u.totalEarned||0)+amt; await saveUser(u);
      return reply({ embeds:[okEmbed(`Gave **${amt}** ${COIN_EMOJI} to <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
    if (cmd==='take'&&isAdmin) {
      const t=msg.mentions.users.first(), amt=parseInt(args[1]);
      if (!t||isNaN(amt)||amt<1) return reply({ embeds:[errEmbed(`Usage: \`${PREFIX}take @user <amount>\``)] });
      const u=await getUser(t.id,t.username); u.coins=Math.max(0,u.coins-amt); await saveUser(u);
      return reply({ embeds:[okEmbed(`Took **${amt}** ${COIN_EMOJI} from <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
  } catch(e) {
    console.error(`Prefix ${cmd}:`, e);
    reply({ embeds:[errEmbed('Something went wrong!')] }).catch(()=>{});
  }
});

// ══════════════════════════════════════════
//  COMMAND FUNCTIONS
// ══════════════════════════════════════════
async function cmdBalance(reply, target) {
  const u = await getUser(target.id, target.username);
  return reply({ embeds:[new EmbedBuilder().setColor(0xF1C40F).setAuthor({name:`${target.username}'s Balance`,iconURL:target.displayAvatarURL()}).setDescription(`## ${COIN_EMOJI} ${u.coins.toLocaleString()} coins`).setFooter({text:`Total earned: ${(u.totalEarned||0).toLocaleString()} coins`})] });
}

async function cmdDaily(reply, userId, username) {
  const u=await getUser(userId,username), cd=24*60*60*1000, now=Date.now();
  if (u.lastDaily&&now-u.lastDaily<cd)
    return reply({ embeds:[errEmbed(`Next daily ready ${ts(u.lastDaily+cd)} (${ts(u.lastDaily+cd,'T')})`)] });
  const earned=Math.floor(Math.random()*6)+10;
  u.coins+=earned; u.totalEarned=(u.totalEarned||0)+earned; u.lastDaily=now;
  await saveUser(u);
  sendLog(client,{title:'🎁 Daily Claimed',color:0x57F287,fields:[{name:'User',value:`<@${userId}>`,inline:true},{name:'Reward',value:`+**${earned}** ${COIN_EMOJI}`,inline:true},{name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎁 Daily Claimed!').setDescription(`You received **${earned}** ${COIN_EMOJI}!\nBalance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`).setFooter({text:'Next daily available'}).setTimestamp(now+cd)] });
}

async function cmdUseCode(reply, userId, username, codeInput) {
  const key  = codeInput.toUpperCase().trim();

  // ── Special: LOOTDROP ──
  if (key === 'LOOTDROP') {
    if (!activeLootDrop || activeLootDrop.claimed)
      return reply({ embeds:[errEmbed(activeLootDrop ? 'This Loot Drop has already been claimed by someone else!' : 'There is no active Loot Drop right now!')] });
    // Mark claimed IMMEDIATELY before any await — prevents race conditions
    activeLootDrop.claimed = true;
    const won = activeLootDrop.coins;
    const dropMsg = activeLootDrop.msg;
    activeLootDrop = null; // fully gone
    // Give coins
    const u = await getUser(userId, username);
    u.coins += won; u.totalEarned = (u.totalEarned||0)+won;
    await saveUser(u);
    // Edit the original drop message to show it's been claimed
    if (dropMsg) {
      try {
        await dropMsg.edit({ embeds:[new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('📦 Loot Drop — CLAIMED!')
          .setDescription(
            `This loot drop has been claimed by **${username}**!\n\n` +
            `🎁 They found **${won}** ${COIN_EMOJI} inside!\n\n` +
            `~~Use \`u!use-code LOOTDROP\` or \`/use-code LOOTDROP\` to claim it!~~`
          )
          .setFooter({ text: 'Better luck next time!' })
          .setTimestamp()] });
      } catch(e) { console.error('Lootdrop edit error:', e.message); }
    }
    sendLog(client,{title:'📦 Loot Drop Claimed!',color:0xF1C40F,fields:[{name:'Winner',value:`<@${userId}>`,inline:true},{name:'Coins Won',value:`**${won}** ${COIN_EMOJI}`,inline:true},{name:'New Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});
    return reply({ embeds:[new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle('📦 Loot Drop Claimed!')
      .setDescription(`You opened the mystery box and found **${won}** ${COIN_EMOJI}!\n\nBalance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}\n\n🎉 You were first!`)] });
  }

  const code = await getCode(key);
  if (!code) return reply({ embeds:[errEmbed(`Code \`${key}\` doesn't exist!`)] });
  if (code.expiresAt && Date.now() > code.expiresAt)
    return reply({ embeds:[errEmbed(`Code \`${key}\` has expired!`)] });
  const u = await getUser(userId, username);
  const alreadyUsed = code.multiUse
    ? (code.redeemedBy || []).includes(userId)
    : u.redeemedCodes.includes(key);
  if (alreadyUsed) return reply({ embeds:[errEmbed(`You've already redeemed \`${key}\`!`)] });

  // Update redemption tracking
  if (code.multiUse) {
    code.redeemedBy = code.redeemedBy || [];
    code.redeemedBy.push(userId);
    // Save updated redeemedBy back (only for non-permanent codes)
    if (!(key in PERMANENT_CODES)) await saveCode(key, code);
  } else {
    u.redeemedCodes.push(key);
  }
  u.coins += code.coins; u.totalEarned = (u.totalEarned||0)+code.coins;
  await saveUser(u);
  sendLog(client,{title:'🎟️ Code Redeemed',color:0x57F287,fields:[{name:'User',value:`<@${userId}>`,inline:true},{name:'Code',value:`\`${key}\``,inline:true},{name:'Coins',value:`+**${code.coins}** ${COIN_EMOJI}`,inline:true},{name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎟️ Code Redeemed!').setDescription(`${code.description}\nYou received **${code.coins}** ${COIN_EMOJI}!\nBalance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}${code.expiresAt?`\nCode expires ${ts(code.expiresAt)}`:''}`)] });
}

async function cmdShop(reply) {
  const robuxLines=SHOP.filter(i=>i.category==='Robux').map(i=>`${ROBUX_EMOJI} **${i.name}** — \`${i.cost}\` ${COIN_EMOJI}  ·  \`${i.id}\``).join('\n');
  const etfbLines=SHOP.filter(i=>i.category==='ETFB').map(i=>`${i.id==='etfb_cel'?'✨':'🌟'} **${i.name}** — \`${i.cost}\` ${COIN_EMOJI}  ·  \`${i.id}\``).join('\n');
  return reply({ embeds:[new EmbedBuilder().setTitle('🏪 Rewards Shop').setColor(0x9B59B6).addFields({name:'💎 Robux',value:robuxLines,inline:false},{name:'🎮 ETFB',value:etfbLines,inline:false}).setFooter({text:'Buy: /redeem  |  Then: /claim <id>'})] });
}

async function cmdInventory(reply, userId, username) {
  const u=await getUser(userId,username), inv=u.inventory||[];
  if (!inv.length) return reply({ embeds:[errEmbed('Your inventory is empty! Use `/redeem` to buy items.')] });
  const list=inv.map(item=>{const e=item.category==='Robux'?'💎':item.name==='Divine'?'🌟':'✨'; return `${e} **${item.name}** — \`${item.claimId}\`\n> \`/claim ${item.claimId}\` to submit`;}).join('\n\n');
  return reply({ embeds:[new EmbedBuilder().setTitle(`🎒 ${username}'s Inventory`).setColor(0x9B59B6).setDescription(list).setFooter({text:`${inv.length} item(s) · /claim <id> to submit`})] });
}

async function cmdLeaderboard(reply, guild) {
  const top=await getLeaderboard(50), medals=['🥇','🥈','🥉'], filtered=[];
  for (const u of top) {
    if (filtered.length>=10) break;
    try { const m=await guild.members.fetch(u.id); if(!m.permissions.has(PermissionFlagsBits.Administrator)) filtered.push(u); } catch {}
  }
  const list=filtered.map((u,i)=>`${medals[i]||`**${i+1}.**`} <@${u.id}> — **${u.coins.toLocaleString()}** ${COIN_EMOJI}`).join('\n');
  return reply({ embeds:[new EmbedBuilder().setTitle('🏆 Coin Leaderboard').setColor(0xF1C40F).setDescription(list||'No data yet!')] });
}

async function cmdHelp(reply) {
  return reply({ embeds:[new EmbedBuilder().setTitle(`📖 Help — Prefix: \`${PREFIX}\``).setColor(0x5865F2).addFields(
    {name:'💰 Economy',value:`\`${PREFIX}balance\` — check your ${COIN_EMOJI}\n\`${PREFIX}daily\` — 10–15 ${COIN_EMOJI} every 24h\n\`${PREFIX}leaderboard\` — top 10\n💬 Every message = 1 ${COIN_EMOJI}`,inline:false},
    {name:'🛒 Shop',value:`\`${PREFIX}shop\` — view items & prices\n\`${PREFIX}redeem <id>\` — buy an item\n\`${PREFIX}inventory\` — view your items\n\`/claim <id>\` — submit a delivery claim`,inline:false},
    {name:'🎟️ Codes',value:`\`/use-code <code>\` or \`${PREFIX}use-code <code>\``,inline:false},
    {name:'🎲 Gambling',value:`\`/coinflip <bet> <heads|tails>\` — flip a coin\n\`/slots <bet>\` — spin the slot machine\n\`/blackjack <bet>\` — play blackjack\n\`/doubleornothing <bet>\` — double or lose it all`,inline:false}
  )] });
}

async function cmdAdminHelp(reply) {
  return reply({ embeds:[new EmbedBuilder().setTitle('🔒 Admin Commands').setColor(0xFF6B35).addFields(
    {name:'📦 Stock',value:`/update-robux <amount>\n/update-etfb <type> <amount>`,inline:false},
    {name:'👥 Coins',value:`/give @user <amount>\n/take @user <amount>`,inline:false},
    {name:'🌧️ Rain',value:`/rain <amount> — 2 min reaction rain`,inline:false},
    {name:'📋 Claims',value:`/claims\n/claimed <id>\n/deny-claim <id> [reason]`,inline:false},
    {name:'🎒 Inventory',value:`/check-inventory @user\n/remove-inv @user <id>`,inline:false},
    {name:'🎟️ Codes',value:`/make-code — permanent saved code\n/drop-code — time-limited drop\n/remove-code — delete a code\n/list-codes — see all active codes`,inline:false},
    {name:'🔢 Games',value:`/gtn <min> <max> <number> <prize>`,inline:false},
    {name:'🛡️ Moderation',value:`/timeout /untimeout /warn /unwarn /warns /kick /ban`,inline:false}
  )] });
}

async function cmdRedeem(reply, userId, username, itemId) {
  const item=SHOP.find(i=>i.id===itemId);
  if (!item) return reply({ embeds:[errEmbed('Unknown item ID. Use `/shop` to see valid IDs.')] });
  const u=await getUser(userId,username);
  if (u.coins<item.cost) return reply({ embeds:[errEmbed(`Need **${item.cost}** ${COIN_EMOJI}, you only have **${u.coins}**!`)] });
  const store=await getStore();
  if (item.id==='etfb_cel'&&store.celestials<=0) return reply({ embeds:[errEmbed('Celestials are out of stock!')] });
  if (item.id==='etfb_div'&&store.divines<=0)    return reply({ embeds:[errEmbed('Divines are out of stock!')] });
  if (item.category==='Robux'&&store.robux<item.robuxAmt) return reply({ embeds:[errEmbed(`Only **${store.robux}** Robux in stock!`)] });
  if (item.id==='etfb_cel')      store.celestials=Math.max(0,store.celestials-1);
  else if (item.id==='etfb_div') store.divines=Math.max(0,store.divines-1);
  else                           store.robux=Math.max(0,store.robux-item.robuxAmt);
  await saveStore(store); await updateStockEmbed(client);
  const claimId=await nextClaimId();
  u.coins-=item.cost;
  u.inventory.push({claimId,itemId:item.id,name:item.name,category:item.category,robuxAmt:item.robuxAmt,cost:item.cost});
  await saveUser(u);
  sendLog(client,{title:'🛒 Item Redeemed',color:0x9B59B6,fields:[{name:'User',value:`<@${userId}>`,inline:true},{name:'Item',value:item.name,inline:true},{name:'Cost',value:`**${item.cost}** ${COIN_EMOJI}`,inline:true},{name:'Claim ID',value:`\`${claimId}\``,inline:true},{name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎒 Added to Inventory!').setDescription(`**${item.name}** is now in your inventory!\nBalance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}\n\n📬 Claim ID: \`${claimId}\`\nUse \`/claim ${claimId}\` to submit!`)] });
}

async function cmdRain(msgOrInteraction, guild, senderId, senderName, amount) {
  const isInt=!!msgOrInteraction.deferReply;
  const sender=await getUser(senderId,senderName);
  const errR=t=>{const e=errEmbed(t);return isInt?msgOrInteraction.editReply({embeds:[e]}):msgOrInteraction.reply({embeds:[e]});};
  if (sender.coins<amount) return errR(`You only have **${sender.coins}** ${COIN_EMOJI}!`);
  sendLog(client,{title:'🌧️ Coin Rain Started',color:0x3498DB,fields:[{name:'Admin',value:`<@${senderId}>`,inline:true},{name:'Amount',value:`**${amount}** ${COIN_EMOJI}`,inline:true},{name:'Duration',value:'2 minutes',inline:true}]});
  const endsAt=Date.now()+2*60*1000;
  const rainEmbed=new EmbedBuilder().setColor(0x3498DB).setTitle('🌧️ Coin Rain — React to Enter!').setDescription(`<@${senderId}> is raining **${amount}** ${COIN_EMOJI}!\n\nReact with 🌧️ to enter!\nCoins split equally.\n\n⏰ Ends ${ts(endsAt)} (${ts(endsAt,'T')} your time)`);
  let rainMsg;
  if (isInt) { await msgOrInteraction.editReply({embeds:[rainEmbed]}); rainMsg=await msgOrInteraction.fetchReply(); }
  else rainMsg=await msgOrInteraction.reply({embeds:[rainEmbed]});
  await rainMsg.react('🌧️');
  setTimeout(async()=>{
    try {
      const fresh=await rainMsg.fetch(), reaction=fresh.reactions.cache.get('🌧️');
      let reactors=[];
      if (reaction) { const users=await reaction.users.fetch(); reactors=[...users.values()].filter(u=>!u.bot&&u.id!==senderId); }
      if (!reactors.length) return rainMsg.reply({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('🌧️ Rain Ended').setDescription(`Nobody reacted! **${amount}** ${COIN_EMOJI} refunded to <@${senderId}>.`)]});
      const per=Math.floor(amount/reactors.length);
      if (per<1) return rainMsg.reply({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('🌧️ Rain Ended').setDescription(`Too many reactors! **${amount}** ${COIN_EMOJI} refunded to <@${senderId}>.`)]});
      const totalGiven=per*reactors.length;
      const su=await getUser(senderId,senderName); su.coins=Math.max(0,su.coins-totalGiven); await saveUser(su);
      const names=[];
      for (const r of reactors) { const u=await getUser(r.id,r.username); u.coins+=per; u.totalEarned=(u.totalEarned||0)+per; await saveUser(u); names.push(`<@${r.id}>`); }
      sendLog(client,{title:'🌧️ Rain Finished',color:0x57F287,fields:[{name:'Sender',value:`<@${senderId}>`,inline:true},{name:'Total Paid',value:`**${totalGiven}** ${COIN_EMOJI}`,inline:true},{name:'Winners',value:`${reactors.length} members`,inline:true},{name:'Per Person',value:`**${per}** ${COIN_EMOJI}`,inline:true}]});
      await rainMsg.reply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🌧️ Rain Finished!').setDescription(`<@${senderId}> rained **${totalGiven}** ${COIN_EMOJI} across **${reactors.length}** members!\nEach got **${per}** ${COIN_EMOJI}\n\n**Winners:** ${names.join(' ')}`)]});
    } catch(e){console.error('Rain end error:',e.message);}
  },2*60*1000);
}

// ══════════════════════════════════════════
//  INTERACTION HANDLER
// ══════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  // ── BLACKJACK BUTTON HANDLER ──
  if (interaction.isButton() && (interaction.customId === 'bj_hit' || interaction.customId === 'bj_stand')) {
    const game = activeBlackjack.get(interaction.user.id);
    if (!game) return interaction.reply({embeds:[errEmbed('No active game found. Start one with `/blackjack`.')],flags:MessageFlags.Ephemeral});
    if (game.userId !== interaction.user.id) return interaction.reply({embeds:[errEmbed("This isn't your game!")],flags:MessageFlags.Ephemeral});

    const { drawCard, cardVal, handTotal, fmtCard, bet } = game;
    function fmtC(c){return `${c.val}${c.suit}`;}
    function total(hand){let t=hand.reduce((s,c)=>s+cardVal(c),0),a=hand.filter(c=>c.val==='A').length;while(t>21&&a>0){t-=10;a--;}return t;}
    function bjEmbed(status) {
      const pt=total(game.player), dt=total(game.dealer);
      const dealerDisplay = status==='playing' ? `${fmtC(game.dealer[0])} 🂠` : game.dealer.map(fmtC).join(' ');
      const dealerVal = status==='playing' ? '?' : dt;
      const color = status==='win'?0x57F287:status==='push'?0xFEE75C:status==='playing'?0x5865F2:0xED4245;
      const title = status==='playing'?'🃏 Blackjack':status==='win'?'🃏 Blackjack — You Win! 🎉':status==='push'?'🃏 Blackjack — Push!':'🃏 Blackjack — You Lose!';
      return new EmbedBuilder().setColor(color).setTitle(title)
        .addFields(
          {name:`🏦 Dealer (${dealerVal})`, value:dealerDisplay, inline:false},
          {name:`🧑 Your Hand (${pt})`,     value:game.player.map(fmtC).join(' '), inline:false},
          {name:'Bet', value:`**${bet.toLocaleString()}** ${COIN_EMOJI}`, inline:true}
        );
    }
    function bjButtons(disabled=false) {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bj_hit').setLabel('👊 Hit').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId('bj_stand').setLabel('✋ Stand').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
      );
    }

    await interaction.deferUpdate();

    if (interaction.customId === 'bj_hit') {
      game.player.push(drawCard());
      const pt = total(game.player);

      if (pt > 21) {
        // Bust
        activeBlackjack.delete(interaction.user.id);
        const u = await getUser(interaction.user.id, interaction.user.username);
        u.coins = Math.max(0, u.coins - bet);
        await saveUser(u);
        const embed = bjEmbed('lose');
        embed.addFields({name:'💥 Bust!',value:`Lost **${bet.toLocaleString()}** ${COIN_EMOJI}`,inline:true},{name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true});
        return interaction.editReply({embeds:[embed], components:[bjButtons(true)]});
      }
      if (pt === 21) {
        // Auto-stand at 21
        game.standing = true;
      }
      if (game.standing) {
        // Play out dealer
        while(total(game.dealer) < 17) game.dealer.push(drawCard());
        const pt2=total(game.player), dt=total(game.dealer);
        const playerWins = dt>21 || pt2>dt;
        const push = pt2===dt;
        activeBlackjack.delete(interaction.user.id);
        const u = await getUser(interaction.user.id, interaction.user.username);
        if (playerWins)  { u.coins+=bet; u.totalEarned=(u.totalEarned||0)+bet; }
        else if (!push)  { u.coins=Math.max(0,u.coins-bet); }
        await saveUser(u);
        const status = playerWins?'win':push?'push':'lose';
        const embed = bjEmbed(status);
        const resultLabel = playerWins?'Won':push?'Returned':'Lost';
        embed.addFields(
          {name:dt>21?'💥 Dealer Bust!':playerWins?'🎉 You Win!':push?'🤝 Push':'🏦 Dealer Wins', value:`${resultLabel} **${bet.toLocaleString()}** ${COIN_EMOJI}`,inline:true},
          {name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}
        );
        return interaction.editReply({embeds:[embed], components:[bjButtons(true)]});
      }
      // Still playing
      return interaction.editReply({embeds:[bjEmbed('playing')], components:[bjButtons()]});
    }

    if (interaction.customId === 'bj_stand') {
      // Dealer plays out
      while(total(game.dealer) < 17) game.dealer.push(drawCard());
      const pt=total(game.player), dt=total(game.dealer);
      const playerWins = dt>21 || pt>dt;
      const push = pt===dt;
      activeBlackjack.delete(interaction.user.id);
      const u = await getUser(interaction.user.id, interaction.user.username);
      if (playerWins)  { u.coins+=bet; u.totalEarned=(u.totalEarned||0)+bet; }
      else if (!push)  { u.coins=Math.max(0,u.coins-bet); }
      await saveUser(u);
      const status = playerWins?'win':push?'push':'lose';
      const embed = bjEmbed(status);
      embed.addFields(
        {name:dt>21?'💥 Dealer Bust!':playerWins?'🎉 You Win!':push?'🤝 Push':'🏦 Dealer Wins', value:`${playerWins?'Won':push?'Returned':'Lost'} **${bet.toLocaleString()}** ${COIN_EMOJI}`,inline:true},
        {name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}
      );
      return interaction.editReply({embeds:[embed], components:[bjButtons(true)]});
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith('claim_modal_')) return;
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const claimId=interaction.customId.replace('claim_modal_','');
    const u=await getUser(interaction.user.id,interaction.user.username);
    const idx=(u.inventory||[]).findIndex(i=>i.claimId===claimId);
    if (idx===-1) return interaction.editReply({embeds:[errEmbed('Item not found in your inventory.')]});
    const item=u.inventory[idx];
    const robloxUser=interaction.fields.getTextInputValue('roblox_username').trim();
    const gamepassLink=item.category==='Robux'?interaction.fields.getTextInputValue('gamepass_link').trim():null;
    const claims=await getClaims(), claimsArr=Array.isArray(claims)?claims:[];
    claimsArr.push({claimId,userId:interaction.user.id,username:interaction.user.username,itemId:item.itemId||item.id,itemName:item.name,category:item.category,robuxAmt:item.robuxAmt||0,robloxUsername:robloxUser,gamepassLink:gamepassLink||null,claimedAt:Date.now(),status:'pending'});
    await saveClaims(claimsArr);
    sendLog(client,{title:'📋 Claim Submitted',color:0x5865F2,fields:[{name:'User',value:`<@${interaction.user.id}>`,inline:true},{name:'Claim ID',value:`\`${claimId}\``,inline:true},{name:'Item',value:item.name,inline:true},{name:'Roblox Username',value:robloxUser,inline:true},{name:'Category',value:item.category,inline:true}]});
    u.inventory.splice(idx,1); await saveUser(u);
    return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('📬 Claim Submitted!').setDescription(`Your claim for **${item.name}** has been submitted!\n\n**Claim ID:** \`${claimId}\`\n**Roblox:** \`${robloxUser}\`\n${gamepassLink?`**Gamepass:** ${gamepassLink}\n`:''}\nAn admin will process this shortly!`)]});
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd=interaction.commandName, me=interaction.user, reply=p=>interaction.reply(p);

  try {
    if (cmd==='balance')     return await cmdBalance(reply, interaction.options.getUser('user')||me);
    if (cmd==='daily')       return await cmdDaily(reply, me.id, me.username);
    if (cmd==='shop')        return await cmdShop(reply);
    if (cmd==='inventory')   return await cmdInventory(reply, me.id, me.username);
    if (cmd==='leaderboard') return await cmdLeaderboard(reply, interaction.guild);
    if (cmd==='help')        return await cmdHelp(reply);
    if (cmd==='adminhelp')   return await cmdAdminHelp(reply);
    if (cmd==='use-code')    return await cmdUseCode(reply, me.id, me.username, interaction.options.getString('code'));
    if (cmd==='rain') { await interaction.deferReply(); return await cmdRain(interaction, interaction.guild, me.id, me.username, interaction.options.getInteger('amount')); }
    if (cmd==='redeem') { await interaction.deferReply(); return await cmdRedeem(p=>interaction.editReply(p), me.id, me.username, interaction.options.getString('item')); }

    if (cmd==='claim') {
      const idArg=interaction.options.getString('id').toUpperCase();
      const u=await getUser(me.id,me.username), item=(u.inventory||[]).find(i=>i.claimId===idArg);
      if (!item) return reply({embeds:[errEmbed(`No item \`${idArg}\` in your inventory.`)],flags:MessageFlags.Ephemeral});
      const modal=new ModalBuilder().setCustomId(`claim_modal_${item.claimId}`).setTitle(`Claim: ${item.name}`);
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('Your Roblox Username').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Builderman').setRequired(true)));
      if (item.category==='Robux') modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gamepass_link').setLabel(`Gamepass Link (set price to ${item.robuxAmt||0} Robux)`).setStyle(TextInputStyle.Short).setPlaceholder('https://www.roblox.com/game-pass/...').setRequired(true)));
      return interaction.showModal(modal);
    }

    if (cmd==='claims') {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const allClaims=await getClaims(), pending=(Array.isArray(allClaims)?allClaims:[]).filter(c=>c.status==='pending');
      if (!pending.length) return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x57F287).setDescription('✅ No pending claims!')]});
      const fields=pending.map(c=>({name:`${c.claimId} — ${c.itemName}`,value:`👤 **${c.username}** · Roblox: \`${c.robloxUsername}\`\n${c.gamepassLink?`🔗 ${c.gamepassLink}\n`:''}📅 ${ts(c.claimedAt,'R')}`,inline:false}));
      const chunks=[]; for(let i=0;i<fields.length;i+=10) chunks.push(fields.slice(i,i+10));
      for(let i=0;i<chunks.length;i++){
        const e=new EmbedBuilder().setColor(0xF1C40F).setTitle(i===0?`📋 Pending Claims — ${pending.length} total`:'📋 (continued)').addFields(chunks[i]).setFooter({text:'/claimed <id>  ·  /deny-claim <id> [reason]'});
        if(i===0) await interaction.editReply({embeds:[e]}); else await interaction.followUp({embeds:[e],flags:MessageFlags.Ephemeral});
      }
      return;
    }

    if (cmd==='claimed') {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const claimId=interaction.options.getString('id').toUpperCase();
      const allClaims=await getClaims(), arr=Array.isArray(allClaims)?allClaims:[];
      const idx=arr.findIndex(c=>c.claimId===claimId);
      if (idx===-1)                    return interaction.editReply({embeds:[errEmbed(`Claim \`${claimId}\` not found.`)]});
      if (arr[idx].status==='fulfilled') return interaction.editReply({embeds:[errEmbed('Already fulfilled.')]});
      if (arr[idx].status==='denied')    return interaction.editReply({embeds:[errEmbed('Already denied.')]});
      const claim=arr[idx];
      // Remove from claims array entirely — fulfilled claims don't need to stay
      arr.splice(idx, 1);
      await saveClaims(arr);
      sendLog(client,{title:'✅ Claim Fulfilled',color:0x57F287,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Claim ID',value:`\`${claimId}\``,inline:true},{name:'User',value:`<@${claim.userId}>`,inline:true},{name:'Item',value:claim.itemName,inline:true}]});
      let dmSent=false;
      try {
        const t=await client.users.fetch(claim.userId);
        const fulfillMsg=claim.category==='Robux'
          ?`Your claim **${claimId}** for **${claim.itemName}** has been fulfilled! Check your Roblox gamepass!`
          :`Your claim **${claimId}** for **${claim.itemName}** has been fulfilled!\n\n**vru4447** has sent you a friend request on Roblox. Accept it and they will join your game to deliver your reward!`;
        await t.send({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎉 Claim Fulfilled!').setDescription(fulfillMsg)]}); dmSent=true;
      } catch {}
      try { await interaction.channel.send({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎉 Claim Fulfilled!').setDescription(`<@${claim.userId}> your claim **${claimId}** for **${claim.itemName}** has been fulfilled by <@${me.id}>!\n${claim.category==='Robux'?'Check your Roblox gamepass!':'Accept the friend request from **vru4447** on Roblox!'}`)]}); } catch {}
      try {
        const t=await client.users.fetch(claim.userId);
        try { await t.send({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('⭐ Please Leave a Vouch!').setDescription(`Hey! You just received **${claim.itemName}** 🎉\n\nPlease leave a vouch in <#${VOUCH_CHANNEL_ID}>!\n\n**Format:** \`Vouch @${me.username} <your feedback>\`\n\nIt only takes a second and helps us a lot! 🙏`).setFooter({text:`Claim ${claimId}`})]}); } catch {}
        // Send ONE reminder after 1 hour, then stop
        const vt=setTimeout(async()=>{
          if (!pendingVouches.has(claim.userId)) return;
          pendingVouches.delete(claim.userId);
          try { const target=await client.users.fetch(claim.userId); await target.send({embeds:[new EmbedBuilder().setColor(0xFEE75C).setTitle('⭐ Reminder: Please Vouch!').setDescription(`Hey! You received **${claim.itemName}** a while ago.\n\nPlease drop a vouch in <#${VOUCH_CHANNEL_ID}>!\n\n**Format:** \`Vouch @${me.username} <your feedback>\`\n\nThis helps us a lot! 🙏`).setFooter({text:`Claim ${claimId}`})]}); } catch {}
        }, 60*60*1000);
        pendingVouches.set(claim.userId,{claimId,itemName:claim.itemName,fulfilledBy:me.username,timeout:vt});
      } catch {}
      return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Claim Fulfilled').addFields({name:'Claim',value:`\`${claimId}\``,inline:true},{name:'User',value:`<@${claim.userId}>`,inline:true},{name:'Item',value:claim.itemName,inline:true},{name:'DM',value:dmSent?'✅ Sent':'❌ DMs off',inline:true})]});
    }

    if (cmd==='deny-claim') {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const claimId=interaction.options.getString('id').toUpperCase(), reason=interaction.options.getString('reason')||null;
      const allClaims=await getClaims(), arr=Array.isArray(allClaims)?allClaims:[];
      const idx=arr.findIndex(c=>c.claimId===claimId);
      if (idx===-1)                    return interaction.editReply({embeds:[errEmbed(`Claim \`${claimId}\` not found.`)]});
      if (arr[idx].status==='fulfilled') return interaction.editReply({embeds:[errEmbed('Already fulfilled.')]});
      if (arr[idx].status==='denied')    return interaction.editReply({embeds:[errEmbed('Already denied.')]});
      const claim=arr[idx];
      // Remove from claims array — denied
      arr.splice(idx, 1);
      await saveClaims(arr);
      sendLog(client,{title:'❌ Claim Denied',color:0xED4245,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Claim ID',value:`\`${claimId}\``,inline:true},{name:'User',value:`<@${claim.userId}>`,inline:true},{name:'Item',value:claim.itemName,inline:true},{name:'Reason',value:reason||'No reason given',inline:false}]});
      const shopItem=SHOP.find(i=>i.id===claim.itemId);
      const u=await getUser(claim.userId,claim.username);
      u.inventory.push({claimId:claim.claimId,itemId:claim.itemId,name:claim.itemName,category:claim.category,robuxAmt:claim.robuxAmt||0,cost:shopItem?shopItem.cost:0});
      await saveUser(u);
      const store=await getStore();
      if (claim.category==='Robux') store.robux+=(claim.robuxAmt||0);
      else if (claim.itemId==='etfb_cel') store.celestials+=1;
      else if (claim.itemId==='etfb_div') store.divines+=1;
      await saveStore(store); await updateStockEmbed(client);
      let dmSent=false;
      try {
        const t=await client.users.fetch(claim.userId);
        await t.send({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('❌ Claim Denied').setDescription(`Your claim \`${claimId}\` for **${claim.itemName}** was denied.\n\n${reason?`**Reason:** ${reason}\n\n`:''}The item has been returned to your inventory.\nUse \`/claim ${claimId}\` to re-submit.`)]});
        dmSent=true;
      } catch {}
      return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('❌ Claim Denied').addFields({name:'Claim',value:`\`${claimId}\``,inline:true},{name:'User',value:`<@${claim.userId}>`,inline:true},{name:'Item',value:claim.itemName,inline:true},{name:'Reason',value:reason||'No reason given',inline:false},{name:'Refunded',value:'✅ Inventory',inline:true},{name:'Stock',value:'✅ Restored',inline:true},{name:'DM',value:dmSent?'✅ Sent':'❌ DMs off',inline:true})]});
    }

    if (cmd==='give') {
      const t=interaction.options.getUser('user'), amt=interaction.options.getInteger('amount');
      const u=await getUser(t.id,t.username); u.coins+=amt; u.totalEarned=(u.totalEarned||0)+amt; await saveUser(u);
      sendLog(client,{title:'💰 Coins Given',color:0x57F287,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Recipient',value:`<@${t.id}>`,inline:true},{name:'Amount',value:`+**${amt}** ${COIN_EMOJI}`,inline:true},{name:'New Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});
      return reply({embeds:[okEmbed(`Gave **${amt}** ${COIN_EMOJI} to <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)]});
    }
    if (cmd==='take') {
      const t=interaction.options.getUser('user');
      const takeAll=interaction.options.getBoolean('all')||false;
      const amt=takeAll?null:interaction.options.getInteger('amount');
      if (!takeAll && !amt) return reply({embeds:[errEmbed('Provide an amount or set `all` to true.')],flags:MessageFlags.Ephemeral});
      const u=await getUser(t.id,t.username);
      const taken=takeAll?u.coins:amt;
      u.coins=takeAll?0:Math.max(0,u.coins-amt);
      await saveUser(u);
      sendLog(client,{title:'💸 Coins Taken',color:0xED4245,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'From',value:`<@${t.id}>`,inline:true},{name:'Amount',value:`-**${taken.toLocaleString()}** ${COIN_EMOJI}${takeAll?' (ALL)':''}`,inline:true},{name:'New Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});
      return reply({embeds:[okEmbed(`Took **${taken.toLocaleString()}** ${COIN_EMOJI} from <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)]});
    }

    // ── CODES (all saved to JSONBin now) ──
    if (cmd==='make-code') {
      const code=interaction.options.getString('code').toUpperCase().trim();
      const coins=interaction.options.getInteger('coins');
      const desc=interaction.options.getString('description')||'🎟️ Special code';
      if (await codeExists(code)) return reply({embeds:[errEmbed(`Code \`${code}\` already exists!`)]});
      const codeObj={coins, description:desc, multiUse:false};
      await saveCode(code, codeObj);
      sendLog(client,{title:'🎟️ Code Created',color:0x57F287,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Code',value:`\`${code}\``,inline:true},{name:'Coins',value:`**${coins}** ${COIN_EMOJI}`,inline:true},{name:'Type',value:'One-time',inline:true}],user:me.username});
      return reply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎟️ Code Created!')
        .addFields({name:'Code',value:`\`${code}\``,inline:true},{name:'Coins',value:`**${coins}** ${COIN_EMOJI}`,inline:true},{name:'Description',value:desc,inline:true})
        .setFooter({text:'Code created successfully!'})]});
    }

    if (cmd==='drop-code') {
      const code=interaction.options.getString('code').toUpperCase().trim();
      const coins=interaction.options.getInteger('coins');
      const mins=interaction.options.getInteger('minutes');
      const desc=interaction.options.getString('description')||'🎟️ Limited drop';
      if (await codeExists(code)) return reply({embeds:[errEmbed(`Code \`${code}\` already exists!`)]});
      const expiresAt=Date.now()+mins*60*1000;
      const codeObj={coins,description:desc,expiresAt,multiUse:true,redeemedBy:[]};
      await saveCode(code, codeObj);
      let dropMsg=null;
      try {
        const dropCh=await client.channels.fetch(DROP_CHANNEL_ID);
        if (dropCh) dropMsg=await dropCh.send({content:'@here',allowedMentions:{parse:['everyone']},embeds:[new EmbedBuilder().setColor(0xF1C40F).setTitle('🎟️ Code Drop!').setDescription(`A new code has been dropped!\n\nUse \`/use-code ${code}\` to claim **${coins}** ${COIN_EMOJI}!\n\n⏰ Expires ${ts(expiresAt)} — ${ts(expiresAt,'T')} your time`).setFooter({text:desc})]});
      } catch(e){console.error('Drop announce error:',e.message);}
      setTimeout(async()=>{
        const saved=await dbRead('codes').catch(()=>({}));
        const redeemCount=(saved[code]?.redeemedBy||[]).length;
        await deleteCode(code);
        if (dropMsg) {
          try { await dropMsg.edit({content:'',embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('🎟️ Code Expired!').setDescription(`The code drop has ended!\n\n**${redeemCount}** member(s) claimed **${coins}** ${COIN_EMOJI} each.\n\nStay active for future drops!`).setFooter({text:`Code was active for ${mins} minute(s)`})]}); } catch(e){console.error('Drop expire edit error:',e.message);}
        }
      },mins*60*1000);
      sendLog(client,{title:'🎟️ Code Dropped',color:0xF1C40F,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Code',value:`\`${code}\``,inline:true},{name:'Coins',value:`**${coins}** ${COIN_EMOJI}`,inline:true},{name:'Expires',value:ts(expiresAt),inline:true},{name:'Type',value:'Multi-use timed',inline:true}],user:me.username});
      return reply({embeds:[new EmbedBuilder().setColor(0xF1C40F).setTitle('🎟️ Code Dropped!').setDescription(`Code \`${code}\` is now live! Expires ${ts(expiresAt)}`).addFields({name:'Code',value:`\`${code}\``,inline:true},{name:'Coins',value:`**${coins}** ${COIN_EMOJI}`,inline:true},{name:'Expires',value:ts(expiresAt),inline:true}).setFooter({text:'Code is live — auto-deleted when expired'})]});
    }

    if (cmd==='remove-code') {
      const code=interaction.options.getString('code').toUpperCase().trim();
      const all=await getCodes();
      if (!(code in all)) return reply({embeds:[errEmbed(`Code \`${code}\` doesn't exist!`)]});
      if (code in PERMANENT_CODES) return reply({embeds:[errEmbed(`\`${code}\` is a permanent hardcoded code — edit PERMANENT_CODES in bot.js to remove it.`)]});
      const {coins, redeemedBy}=all[code];
      const redeemCount=(redeemedBy||[]).length;
      await deleteCode(code);
      sendLog(client,{title:'🗑️ Code Removed',color:0xED4245,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Code',value:`\`${code}\``,inline:true},{name:'Times Redeemed',value:`${redeemCount}`,inline:true}],user:me.username});
      return reply({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('🗑️ Code Removed').setDescription(`Code \`${code}\` has been deleted from the database.`).addFields({name:'Code',value:`\`${code}\``,inline:true},{name:'Redeemed',value:`${redeemCount} time(s)`,inline:true},{name:'Coins/use',value:`**${coins}** ${COIN_EMOJI}`,inline:true})]});
    }

    if (cmd==='list-codes') {
      const all=await getCodes();
      const entries=Object.entries(all);
      if (!entries.length) return reply({embeds:[new EmbedBuilder().setColor(0xFEE75C).setDescription('No active codes right now.')],flags:MessageFlags.Ephemeral});
      const lines=entries.map(([key,c])=>{
        const isPerm=key in PERMANENT_CODES;
        const type=c.multiUse?'🔄 Multi-use':'1️⃣ One-time';
        const expiry=c.expiresAt?` · Expires ${ts(c.expiresAt)}`:'';
        const perm=isPerm?' · **Permanent**':'';
        return `**\`${key}\`** — **${c.coins}** ${COIN_EMOJI} · ${type}${expiry}${perm}`;
      }).join('\n');
      return reply({embeds:[new EmbedBuilder().setColor(0xF1C40F).setTitle(`🎟️ Active Codes — ${entries.length} total`).setDescription(lines)],flags:MessageFlags.Ephemeral});
    }

    if (cmd==='remove-inv') {
      const t=interaction.options.getUser('user'), claimId=interaction.options.getString('claim_id').toUpperCase();
      const u=await getUser(t.id,t.username), idx=(u.inventory||[]).findIndex(i=>i.claimId===claimId);
      if (idx===-1) return reply({embeds:[errEmbed(`No item \`${claimId}\` in <@${t.id}>'s inventory.`)],flags:MessageFlags.Ephemeral});
      const removed=u.inventory.splice(idx,1)[0]; await saveUser(u);
      sendLog(client,{title:'🗑️ Inventory Item Removed',color:0xED4245,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'User',value:`<@${t.id}>`,inline:true},{name:'Item',value:`${removed.name} (\`${claimId}\`)`,inline:true}],user:me.username});
      return reply({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('🗑️ Removed').setDescription(`Removed **${removed.name}** (\`${claimId}\`) from <@${t.id}>'s inventory.`)]});
    }
    if (cmd==='check-inventory') {
      const t=interaction.options.getUser('user'), u=await getUser(t.id,t.username), inv=u.inventory||[];
      if (!inv.length) return reply({embeds:[new EmbedBuilder().setColor(0xFEE75C).setDescription(`🎒 <@${t.id}>'s inventory is empty.`)],flags:MessageFlags.Ephemeral});
      const list=inv.map(i=>`${i.category==='Robux'?'💎':i.name==='Divine'?'🌟':'✨'} **${i.name}** — \`${i.claimId}\``).join('\n');
      return reply({embeds:[new EmbedBuilder().setTitle(`🎒 ${t.username}'s Inventory`).setColor(0x9B59B6).setDescription(list).setFooter({text:`${inv.length} item(s)`})],flags:MessageFlags.Ephemeral});
    }
    if (cmd==='update-robux') {
      await interaction.deferReply();
      const store=await getStore(); store.robux=interaction.options.getInteger('amount'); await saveStore(store); await updateStockEmbed(client);
      sendLog(client,{title:'📦 Robux Stock Updated',color:0x57F287,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'New Amount',value:`**${store.robux}** Robux`,inline:true}],user:me.username});
      return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`💎 Robux set to **${store.robux}**.`)]});
    }
    if (cmd==='update-etfb') {
      await interaction.deferReply();
      const type=interaction.options.getString('type'), amt=interaction.options.getInteger('amount');
      const store=await getStore(); store[type]=amt; await saveStore(store); await updateStockEmbed(client);
      sendLog(client,{title:'📦 ETFB Stock Updated',color:0x57F287,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Type',value:type==='divines'?'Divines':'Celestials',inline:true},{name:'New Amount',value:`**${amt}x**`,inline:true}],user:me.username});
      return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`${type==='divines'?'🌟 Divines':'✨ Celestials'} set to **${amt}x**.`)]});
    }

    if (cmd==='gtn') {
      const min=interaction.options.getInteger('min'), max=interaction.options.getInteger('max');
      const answer=interaction.options.getInteger('number'), prize=interaction.options.getInteger('prize');
      if (answer<min||answer>max) return reply({embeds:[errEmbed(`The winning number must be between **${min}** and **${max}**!`)]});
      if (activeGTN.has(GTN_CHANNEL_ID)) return reply({embeds:[errEmbed('A GTN game is already running! Wait for it to end.')]});
      activeGTN.set(GTN_CHANNEL_ID,{answer,prize,min,max,active:true});
      try {
        const gtnCh=await client.channels.fetch(GTN_CHANNEL_ID);
        if(gtnCh) await gtnCh.send({embeds:[new EmbedBuilder().setColor(0x9B59B6).setTitle('🎮 Guess the Number!').setDescription(`A new game has started!\n\n> 🔢 **Range:** ${min} – ${max}\n> 🏆 **Prize:** **${prize}** ${COIN_EMOJI}\n\nType a number in this channel to guess!\nFirst correct guess wins!`).setFooter({text:`Hosted by ${me.username}`}).setTimestamp()]});
      } catch(e){console.error('GTN channel send error:',e.message);}
      sendLog(client,{title:'🎮 GTN Game Started',color:0x9B59B6,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Range',value:`${min}–${max}`,inline:true},{name:'Answer',value:`||${answer}||`,inline:true},{name:'Prize',value:`**${prize}** ${COIN_EMOJI}`,inline:true}],user:me.username});
      return reply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ GTN Game Started!').addFields({name:'Range',value:`${min} – ${max}`,inline:true},{name:'Answer',value:`**${answer}**`,inline:true},{name:'Prize',value:`**${prize}** ${COIN_EMOJI}`,inline:true}).setFooter({text:'Only you can see this'})],flags:MessageFlags.Ephemeral});
    }

    // ── MODERATION ──
    if (cmd==='timeout') {
      if (!isModerator(interaction.member)) return reply({embeds:[errEmbed('You need a Moderator or Admin role!')],flags:MessageFlags.Ephemeral});
      const t=interaction.options.getUser('user'), mins=interaction.options.getInteger('minutes'), reason=interaction.options.getString('reason')||'No reason given';
      try {
        const member=await interaction.guild.members.fetch(t.id);
        await member.timeout(mins*60*1000, reason);
        try { await t.send({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('⏱️ You have been timed out').addFields({name:'Duration',value:`${mins} minute(s)`,inline:true},{name:'Reason',value:reason,inline:true},{name:'Server',value:interaction.guild.name,inline:true})]}); } catch {}
        sendLog(client,{title:'⏱️ User Timed Out',color:0xED4245,fields:[{name:'Mod',value:`<@${me.id}>`,inline:true},{name:'User',value:`<@${t.id}>`,inline:true},{name:'Duration',value:`${mins} min`,inline:true},{name:'Reason',value:reason,inline:false}],user:me.username});
        return reply({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('⏱️ User Timed Out').addFields({name:'User',value:`<@${t.id}>`,inline:true},{name:'Duration',value:`${mins} min`,inline:true},{name:'Reason',value:reason,inline:false})]});
      } catch(e){return reply({embeds:[errEmbed(`Failed to timeout: ${e.message}`)]}); }
    }
    if (cmd==='untimeout') {
      if (!isModerator(interaction.member)) return reply({embeds:[errEmbed('You need a Moderator or Admin role!')],flags:MessageFlags.Ephemeral});
      const t=interaction.options.getUser('user'), reason=interaction.options.getString('reason')||'No reason given';
      try {
        const member=await interaction.guild.members.fetch(t.id);
        await member.timeout(null, reason);
        try { await t.send({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Timeout Removed').setDescription(`Your timeout in **${interaction.guild.name}** has been removed.\n**Reason:** ${reason}`)]}); } catch {}
        sendLog(client,{title:'✅ Timeout Removed',color:0x57F287,fields:[{name:'Mod',value:`<@${me.id}>`,inline:true},{name:'User',value:`<@${t.id}>`,inline:true},{name:'Reason',value:reason,inline:false}],user:me.username});
        return reply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Timeout Removed').addFields({name:'User',value:`<@${t.id}>`,inline:true},{name:'Reason',value:reason,inline:false})]});
      } catch(e){return reply({embeds:[errEmbed(`Failed to untimeout: ${e.message}`)]}); }
    }
    if (cmd==='warn') {
      if (!isModerator(interaction.member)) return reply({embeds:[errEmbed('You need a Moderator or Admin role!')],flags:MessageFlags.Ephemeral});
      const t=interaction.options.getUser('user'), reason=interaction.options.getString('reason')||'No reason given';
      const warns=await getWarns(t.id); warns.push({reason,by:me.username,at:Date.now()}); await saveWarns(t.id,warns);
      try { await t.send({embeds:[new EmbedBuilder().setColor(0xFEE75C).setTitle('⚠️ You have been warned').addFields({name:'Reason',value:reason,inline:false},{name:'Total Warns',value:`${warns.length}`,inline:true},{name:'Server',value:interaction.guild.name,inline:true})]}); } catch {}
      sendLog(client,{title:'⚠️ User Warned',color:0xFEE75C,fields:[{name:'Mod',value:`<@${me.id}>`,inline:true},{name:'User',value:`<@${t.id}>`,inline:true},{name:'Warn #',value:`${warns.length}`,inline:true},{name:'Reason',value:reason,inline:false}],user:me.username});
      return reply({embeds:[new EmbedBuilder().setColor(0xFEE75C).setTitle('⚠️ User Warned').addFields({name:'User',value:`<@${t.id}>`,inline:true},{name:'Warn #',value:`${warns.length}`,inline:true},{name:'Reason',value:reason,inline:false})]});
    }
    if (cmd==='unwarn') {
      if (!isModerator(interaction.member)) return reply({embeds:[errEmbed('You need a Moderator or Admin role!')],flags:MessageFlags.Ephemeral});
      const t=interaction.options.getUser('user'), index=interaction.options.getInteger('index')-1;
      const warns=await getWarns(t.id);
      if (!warns.length) return reply({embeds:[errEmbed(`<@${t.id}> has no warns.`)]});
      if (index<0||index>=warns.length) return reply({embeds:[errEmbed('Invalid warn number. Use /warns to see the list.')]});
      const removed=warns.splice(index,1)[0]; await saveWarns(t.id,warns);
      sendLog(client,{title:'✅ Warn Removed',color:0x57F287,fields:[{name:'Mod',value:`<@${me.id}>`,inline:true},{name:'User',value:`<@${t.id}>`,inline:true},{name:'Removed Warn',value:removed.reason,inline:false},{name:'Remaining',value:`${warns.length} warn(s)`,inline:true}],user:me.username});
      return reply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Warn Removed').addFields({name:'User',value:`<@${t.id}>`,inline:true},{name:'Removed Warn',value:removed.reason,inline:false},{name:'Remaining Warns',value:`${warns.length}`,inline:true})]});
    }
    if (cmd==='warns') {
      if (!isModerator(interaction.member)) return reply({embeds:[errEmbed('You need a Moderator or Admin role!')],flags:MessageFlags.Ephemeral});
      const t=interaction.options.getUser('user'), warns=await getWarns(t.id);
      if (!warns.length) return reply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle(`⚠️ Warns — ${t.username}`).setDescription('This user has no warns! ✅')]});
      const list=warns.map((w,i)=>`**#${i+1}** — ${w.reason}\n> By ${w.by} · ${ts(w.at,'R')}`).join('\n\n');
      return reply({embeds:[new EmbedBuilder().setColor(0xFEE75C).setTitle(`⚠️ Warns — ${t.username}`).setDescription(list).setFooter({text:`${warns.length} total warn(s)`})]});
    }
    if (cmd==='kick') {
      if (!isModerator(interaction.member)) return reply({embeds:[errEmbed('You need a Moderator or Admin role!')],flags:MessageFlags.Ephemeral});
      const t=interaction.options.getUser('user'), reason=interaction.options.getString('reason')||'No reason given';
      try {
        const member=await interaction.guild.members.fetch(t.id);
        try { await t.send({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('👢 You have been kicked').addFields({name:'Reason',value:reason,inline:false},{name:'Server',value:interaction.guild.name,inline:true})]}); } catch {}
        await member.kick(reason);
        sendLog(client,{title:'👢 User Kicked',color:0xED4245,fields:[{name:'Mod',value:`<@${me.id}>`,inline:true},{name:'User',value:`<@${t.id}>`,inline:true},{name:'Reason',value:reason,inline:false}],user:me.username});
        return reply({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('👢 User Kicked').addFields({name:'User',value:`<@${t.id}>`,inline:true},{name:'Reason',value:reason,inline:false})]});
      } catch(e){return reply({embeds:[errEmbed(`Failed to kick: ${e.message}`)]}); }
    }
    if (cmd==='ban') {
      if (!isModerator(interaction.member)) return reply({embeds:[errEmbed('You need a Moderator or Admin role!')],flags:MessageFlags.Ephemeral});
      const t=interaction.options.getUser('user'), reason=interaction.options.getString('reason')||'No reason given';
      try {
        try { await t.send({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('🔨 You have been banned').addFields({name:'Reason',value:reason,inline:false},{name:'Server',value:interaction.guild.name,inline:true})]}); } catch {}
        await interaction.guild.members.ban(t.id,{reason});
        sendLog(client,{title:'🔨 User Banned',color:0xED4245,fields:[{name:'Mod',value:`<@${me.id}>`,inline:true},{name:'User',value:`<@${t.id}>`,inline:true},{name:'Reason',value:reason,inline:false}],user:me.username});
        return reply({embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('🔨 User Banned').addFields({name:'User',value:`<@${t.id}>`,inline:true},{name:'Reason',value:reason,inline:false})]});
      } catch(e){return reply({embeds:[errEmbed(`Failed to ban: ${e.message}`)]}); }
    }

    // ══════════════════════════════════════════
    //  ROBLOX USER LINKING
    // ══════════════════════════════════════════
    if (cmd==='add-user') {
      const robloxUser = interaction.options.getString('roblox_username').trim();
      const data = await dbRead('roblox');
      // Check if this Roblox username is already taken by someone else
      const takenBy = Object.entries(data).find(([uid, d]) => d.robloxUsername && d.robloxUsername.toLowerCase() === robloxUser.toLowerCase() && uid !== me.id);
      if (takenBy) return reply({embeds:[errEmbed(`The Roblox username \`${robloxUser}\` is already linked to another Discord account!`)],flags:MessageFlags.Ephemeral});
      // Update if already linked
      if (data[me.id]) {
        const prev = data[me.id];
        data[me.id] = { discordName: me.username, robloxUsername: robloxUser, updatedAt: Date.now() };
        await dbWrite('roblox', data);
        sendLog(client,{title:'🎮 Roblox Username Updated',color:0xFEE75C,fields:[{name:'Discord',value:`<@${me.id}>`,inline:true},{name:'Old Roblox',value:prev.robloxUsername,inline:true},{name:'New Roblox',value:robloxUser,inline:true}]});
        return reply({embeds:[new EmbedBuilder().setColor(0xFEE75C).setTitle('🎮 Roblox Username Updated!').setDescription(`Your Roblox username has been updated!

**Discord:** ${me.username}
**Roblox:** \`${robloxUser}\``).setFooter({text:'Updated successfully'})],flags:MessageFlags.Ephemeral});
      }
      // Fresh link
      data[me.id] = { discordName: me.username, robloxUsername: robloxUser, linkedAt: Date.now() };
      await dbWrite('roblox', data);
      sendLog(client,{title:'🎮 Roblox Username Linked',color:0x57F287,fields:[{name:'Discord',value:`<@${me.id}>`,inline:true},{name:'Roblox',value:robloxUser,inline:true}]});
      return reply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎮 Roblox Username Linked!').setDescription(`You've been linked successfully!

**Discord:** ${me.username}
**Roblox:** \`${robloxUser}\``).setFooter({text:'Use /add-user again to update your username'})],flags:MessageFlags.Ephemeral});
    }

    if (cmd==='check-user') {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const data = await dbRead('roblox');
      const entries = Object.entries(data).filter(([k]) => k !== '_init');
      if (!entries.length) return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xFEE75C).setDescription('No users linked yet.')]});
      const pages = [];
      const perPage = 15;
      for (let i = 0; i < entries.length; i += perPage) {
        const chunk = entries.slice(i, i + perPage);
        const lines = chunk.map(([uid, d]) => `<@${uid}> — \`${d.robloxUsername}\``).join('\n');
        pages.push(lines);
      }
      return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle(`🎮 Linked Roblox Users — ${entries.length} total`).setDescription(pages[0]).setFooter({text:`Page 1 of ${pages.length}`})]});
    }

    // ══════════════════════════════════════════
    //  LOOT DROP
    // ══════════════════════════════════════════
    if (cmd==='lootdrop') {
      if (activeLootDrop) return reply({embeds:[errEmbed('A Loot Drop is already active! Someone needs to claim it first.')],flags:MessageFlags.Ephemeral});
      const coins = Math.floor(Math.random()*41)+10; // 10-50, secret until claimed
      // Send the public embed and save the message reference so we can edit it later
      let dropMsg = null;
      try {
        dropMsg = await interaction.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle('📦 Loot Drop!')
            .setDescription(
              'A mystery loot box has appeared!\n\n' +
              '🎁 **Unknown amount of coins inside...**\n\n' +
              'Use `u!use-code LOOTDROP` or `/use-code LOOTDROP` to claim it!\n\n' +
              '⚡ **First person to claim it wins — only 1 winner!**'
            )
            .setFooter({ text: 'Be fast — only one person can claim this!' })
            .setTimestamp()]
        });
      } catch(e){ console.error('Lootdrop send error:', e.message); }
      // Store state with message reference
      activeLootDrop = { coins, claimed: false, msg: dropMsg };
      sendLog(client,{title:'📦 Loot Drop Started',color:0xF1C40F,fields:[{name:'Admin',value:`<@${me.id}>`,inline:true},{name:'Coins Inside',value:`**${coins}** ${COIN_EMOJI}`,inline:true},{name:'Status',value:'🟢 Active — awaiting claim',inline:true}],user:me.username});
      return reply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('📦 Loot Drop Created!').setDescription(`A loot drop with **${coins}** ${COIN_EMOJI} is now live!\n\nFirst to use \`LOOTDROP\` wins it.`).setFooter({text:'Only you can see the coin amount'})],flags:MessageFlags.Ephemeral});
    }

    // ══════════════════════════════════════════
    //  GAMBLING COMMANDS
    // ══════════════════════════════════════════

    // ── Win chance: 30% normal, 20% if bet >= 500 ──
    function gamblingWinChance(bet) { return bet >= 500 ? 0.20 : 0.30; }
    function gamblingRoll(bet)      { return Math.random() < gamblingWinChance(bet); }

    if (cmd==='coinflip') {
      await interaction.deferReply();
      const bet  = interaction.options.getInteger('bet');
      const side = interaction.options.getString('side');
      const u    = await getUser(me.id, me.username);
      if (u.coins < bet) return interaction.editReply({embeds:[errEmbed(`You only have **${u.coins.toLocaleString()}** ${COIN_EMOJI}!`)]});

      const won    = gamblingRoll(bet);
      const result = Math.random() < 0.5 ? 'heads' : 'tails';
      // Determine result
      const actualResult = won ? side : (side==='heads'?'tails':'heads');
      const emoji  = actualResult==='heads' ? '🟡' : '⚫';

      if (won) { u.coins += bet; u.totalEarned=(u.totalEarned||0)+bet; }
      else      { u.coins = Math.max(0, u.coins - bet); }
      await saveUser(u);
      sendLog(client,{title:'🪙 Coinflip',color:won?0x57F287:0xED4245,fields:[{name:'Player',value:`<@${me.id}>`,inline:true},{name:'Result',value:actualResult,inline:true},{name:won?'Won':'Lost',value:`**${bet.toLocaleString()}** ${COIN_EMOJI}`,inline:true},{name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});

      const color = won ? 0x57F287 : 0xED4245;
      const title = won ? `${emoji} ${actualResult.toUpperCase()} — You Win!` : `${emoji} ${actualResult.toUpperCase()} — You Lose!`;
      return interaction.editReply({embeds:[new EmbedBuilder().setColor(color).setTitle(`🪙 Coinflip — ${title}`)
        .addFields(
          {name:'Your Pick', value:side.charAt(0).toUpperCase()+side.slice(1), inline:true},
          {name:'Result',    value:actualResult.charAt(0).toUpperCase()+actualResult.slice(1), inline:true},
          {name:'Bet',       value:`**${bet.toLocaleString()}** ${COIN_EMOJI}`, inline:true},
          {name:won?'Won':'Lost', value:`**${bet.toLocaleString()}** ${COIN_EMOJI}`, inline:true},
          {name:'Balance',   value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`, inline:true}
        ).setFooter({text:'Good luck! 🎲'})]});
    }

    if (cmd==='slots') {
      await interaction.deferReply();
      const bet = interaction.options.getInteger('bet');
      const u   = await getUser(me.id, me.username);
      if (u.coins < bet) return interaction.editReply({embeds:[errEmbed(`You only have **${u.coins.toLocaleString()}** ${COIN_EMOJI}!`)]});

      const SYMBOLS = ['🍒','🍋','🍊','🍇','⭐','💎','🎰'];
      // Weight symbols so jackpot (💎💎💎) is very rare
      const WEIGHTED = ['🍒','🍒','🍒','🍋','🍋','🍋','🍊','🍊','🍋','🍇','🍇','⭐','⭐','🎰','💎'];
      function spin() { return WEIGHTED[Math.floor(Math.random()*WEIGHTED.length)]; }

      const won = gamblingRoll(bet);
      let reels;
      if (won) {
        // Win: give them two matching at least (but not jackpot unless very lucky)
        const s = spin();
        reels = Math.random() < 0.1 ? [s,s,s] : [s,s,spin()]; // 10% chance full match on a win
        if (reels[2]===reels[0]) reels[2]=spin(); // prevent accidental jackpot on basic win
      } else {
        // Loss: guarantee no two consecutive match or only allow one pair max
        reels = [spin(),spin(),spin()];
        if (reels[0]===reels[1]&&reels[1]===reels[2]) reels[2]=SYMBOLS.find(s=>s!==reels[0])||'🍒';
        if (reels[0]===reels[1]) reels[1]=SYMBOLS.find(s=>s!==reels[0])||'🍋';
      }

      const isJackpot = reels[0]===reels[1]&&reels[1]===reels[2];
      const isWin     = isJackpot || won;
      const multiplier = isJackpot ? 5 : 1;
      const payout    = bet * multiplier;

      if (isWin)  { u.coins += payout; u.totalEarned=(u.totalEarned||0)+payout; }
      else         { u.coins = Math.max(0, u.coins - bet); }
      await saveUser(u);
      sendLog(client,{title:'🎰 Slots',color:isWin?0x57F287:0xED4245,fields:[{name:'Player',value:`<@${me.id}>`,inline:true},{name:'Reels',value:reels.join(' '),inline:true},{name:isWin?'Won':'Lost',value:`**${(isWin?payout:bet).toLocaleString()}** ${COIN_EMOJI}`,inline:true},{name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});

      const color = isWin ? 0x57F287 : 0xED4245;
      const resultText = isJackpot ? '🎉 **JACKPOT! 5x payout!**' : isWin ? '✅ **Winner!**' : '❌ **No match — You lose!**';
      return interaction.editReply({embeds:[new EmbedBuilder().setColor(color).setTitle('🎰 Slot Machine')
        .setDescription(`## ${reels.join(' │ ')}\n\n${resultText}`)
        .addFields(
          {name:'Bet',     value:`**${bet.toLocaleString()}** ${COIN_EMOJI}`, inline:true},
          {name:isWin?'Won':'Lost', value:`**${payout.toLocaleString()}** ${COIN_EMOJI}`, inline:true},
          {name:'Balance', value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`, inline:true}
        ).setFooter({text:'Good luck! 🎲'})]});
    }

    if (cmd==='blackjack') {
      const bet = interaction.options.getInteger('bet');
      const u   = await getUser(me.id, me.username);
      if (u.coins < bet) return reply({embeds:[errEmbed(`You only have **${u.coins.toLocaleString()}** ${COIN_EMOJI}!`)],flags:MessageFlags.Ephemeral});
      if (activeBlackjack.has(me.id)) return reply({embeds:[errEmbed('You already have a game in progress!')],flags:MessageFlags.Ephemeral});

      const SUITS  = ['♠️','♥️','♦️','♣️'];
      const VALUES = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
      function drawCard() { return {suit:SUITS[Math.floor(Math.random()*4)],val:VALUES[Math.floor(Math.random()*13)]}; }
      function cardVal(c) { return ['J','Q','K'].includes(c.val)?10:c.val==='A'?11:parseInt(c.val); }
      function handTotal(hand) {
        let total=hand.reduce((s,c)=>s+cardVal(c),0), aces=hand.filter(c=>c.val==='A').length;
        while(total>21&&aces>0){total-=10;aces--;}
        return total;
      }
      function fmtCard(c){return `${c.val}${c.suit}`;}
      function bjEmbed(game, status='playing') {
        const pt=handTotal(game.player), dt=handTotal(game.dealer);
        const dealerDisplay = status==='playing'
          ? `${fmtCard(game.dealer[0])} 🂠` // hide second card
          : game.dealer.map(fmtCard).join(' ');
        const dealerVal = status==='playing' ? '?' : dt;
        const color = status==='win'?0x57F287:status==='push'?0xFEE75C:status==='playing'?0x5865F2:0xED4245;
        const title = status==='playing'?'🃏 Blackjack':status==='win'?'🃏 Blackjack — You Win! 🎉':status==='push'?'🃏 Blackjack — Push!':'🃏 Blackjack — You Lose!';
        return new EmbedBuilder().setColor(color).setTitle(title)
          .addFields(
            {name:`🏦 Dealer (${dealerVal})`, value:dealerDisplay, inline:false},
            {name:`🧑 Your Hand (${pt})`,     value:game.player.map(fmtCard).join(' '), inline:false},
            {name:'Bet', value:`**${game.bet.toLocaleString()}** ${COIN_EMOJI}`, inline:true}
          );
      }
      function bjButtons(disabled=false) {
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('bj_hit').setLabel('👊 Hit').setStyle(ButtonStyle.Primary).setDisabled(disabled),
          new ButtonBuilder().setCustomId('bj_stand').setLabel('✋ Stand').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
        );
      }

      const playerHand = [drawCard(), drawCard()];
      const dealerHand = [drawCard(), drawCard()];
      const game = { player: playerHand, dealer: dealerHand, bet, userId: me.id, drawCard, cardVal, handTotal, fmtCard };
      activeBlackjack.set(me.id, game);

      const pt = handTotal(playerHand);

      // Natural blackjack check
      if (pt === 21) {
        activeBlackjack.delete(me.id);
        const dt = handTotal(dealerHand);
        const push = dt === 21;
        if (!push) { u.coins += Math.floor(bet*1.5); u.totalEarned=(u.totalEarned||0)+Math.floor(bet*1.5); }
        await saveUser(u);
        const finalEmbed = bjEmbed(game, push?'push':'win');
        if (!push) finalEmbed.addFields({name:'Won',value:`**${Math.floor(bet*1.5).toLocaleString()}** ${COIN_EMOJI} (Blackjack 3:2!)`,inline:true},{name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true});
        else finalEmbed.addFields({name:'Result',value:'Push — bet returned',inline:true});
        return reply({embeds:[finalEmbed], components:[bjButtons(true)]});
      }

      return reply({embeds:[bjEmbed(game,'playing')], components:[bjButtons()]});
    }

    if (cmd==='doubleornothing') {
      await interaction.deferReply();
      const bet = interaction.options.getInteger('bet');
      const u   = await getUser(me.id, me.username);
      if (u.coins < bet) return interaction.editReply({embeds:[errEmbed(`You only have **${u.coins.toLocaleString()}** ${COIN_EMOJI}!`)]});

      const won = gamblingRoll(bet);
      // Dramatic number reveal
      const roll     = won ? Math.floor(Math.random()*50)+51 : Math.floor(Math.random()*50)+1; // 51-100 = win, 1-50 = lose
      const THRESHOLD = 50;

      if (won)  { u.coins += bet; u.totalEarned=(u.totalEarned||0)+bet; }
      else       { u.coins = Math.max(0, u.coins - bet); }
      await saveUser(u);
      sendLog(client,{title:'⚡ Double or Nothing',color:won?0x57F287:0xED4245,fields:[{name:'Player',value:`<@${me.id}>`,inline:true},{name:'Roll',value:`**${roll}**/100`,inline:true},{name:won?'Won':'Lost',value:`**${bet.toLocaleString()}** ${COIN_EMOJI}`,inline:true},{name:'Balance',value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`,inline:true}]});

      const color = won ? 0x57F287 : 0xED4245;
      const bar   = won ? '🟩'.repeat(Math.round(roll/10)) : '🟥'.repeat(Math.round(roll/10));

      return interaction.editReply({embeds:[new EmbedBuilder().setColor(color).setTitle('⚡ Double or Nothing')
        .setDescription(`The die was cast...\n\n## ${roll} / 100\n${bar}\n\n${won?`🎉 **DOUBLED!** You needed > ${THRESHOLD}, rolled **${roll}**!`:`💀 **NOTHING!** You needed > ${THRESHOLD}, rolled **${roll}**.`}`)
        .addFields(
          {name:'Bet',     value:`**${bet.toLocaleString()}** ${COIN_EMOJI}`, inline:true},
          {name:won?'Won':'Lost', value:`**${bet.toLocaleString()}** ${COIN_EMOJI}`, inline:true},
          {name:'Balance', value:`**${u.coins.toLocaleString()}** ${COIN_EMOJI}`, inline:true}
        ).setFooter({text:'Good luck! 🎲'})]});
    }

  } catch(e) {
    console.error(`/${cmd} error:`,e);
    const err={embeds:[errEmbed('Something went wrong!')],flags:MessageFlags.Ephemeral};
    try { interaction.replied||interaction.deferred?await interaction.followUp(err):await interaction.reply(err); } catch {}
  }
});

setInterval(()=>console.log('Heartbeat:',new Date().toISOString()),300_000);
client.login(BOT_TOKEN);
