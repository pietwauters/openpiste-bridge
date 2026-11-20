'use strict';

// OpenPiste Level 1 bridge — EFP1.1 UDP ↔ MQTT
//
// Two modes, selected with "mode" in config.json:
//
//   "cms-side" (default)
//     Classic Cyrano CMS  ⇄ UDP ⇄  bridge  ⇄ MQTT ⇄  OpenPiste apparatus
//     The bridge impersonates the apparatus: for each piste it binds a UDP
//     socket to the piste's static IP so the CMS connects without
//     reconfiguration.
//
//   "apparatus-side"
//     Classic Cyrano apparatus  ⇄ UDP ⇄  bridge  ⇄ MQTT ⇄  Level 1 CMS
//     The bridge impersonates the CMS: it listens on the IP the apparatus
//     already sends to ("cmsIp") and identifies each piste by the sender's
//     IP address. CMS messages from MQTT are sent to the apparatus' IP.
//
// Usage:
//   cp config.example.json config.json   # edit to match your network
//   npm install
//   node bridge.js [--verbose] [--config path/to/config.json]

const dgram        = require('dgram');
const mqtt         = require('mqtt');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

// ── Logging ───────────────────────────────────────────────────────────────────

const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
const log = (...args) => { if (verbose) console.log(...args); };

// ── Config ───────────────────────────────────────────────────────────────────

const configArg  = process.argv.indexOf('--config');
const configPath = configArg !== -1 && process.argv[configArg + 1]
  ? path.resolve(process.argv[configArg + 1])
  : path.join(__dirname, 'config.json');

if (!fs.existsSync(configPath)) {
  console.error(`[config] ${configPath} not found.`);
  console.error('[config] Copy config.example.json to config.json and edit it.');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error('[config] Failed to parse config.json:', e.message);
  process.exit(1);
}

const { mqttBroker, udpPort, subnet, ipBase, pistes } = config;
const mode = config.mode || 'cms-side';

if (mode !== 'cms-side' && mode !== 'apparatus-side') {
  console.error(`[config] Unknown mode "${mode}" — use "cms-side" or "apparatus-side".`);
  process.exit(1);
}

// Default piste IP: subnet.(ipBase + number). A piste may override it with
// "ip" (e.g. when apparatus addresses don't follow a regular pattern).
function pisteIp(piste) {
  return piste.ip || `${subnet}.${ipBase + piste.number}`;
}

const topicSoftware  = piste => `openpiste/${piste.id}/software/efp1`;
const topicApparatus = piste => `openpiste/${piste.id}/apparatus/efp1`;

// ── IP alias setup ────────────────────────────────────────────────────────────
// Requires root (run via systemd service). Silently skips if already assigned.
// Skipped entirely when "networkInterface" is not set (e.g. local testing).

function addIpAlias(ip) {
  if (!config.networkInterface) return;
  const cidr = `${ip}/24`;
  try {
    execSync(`ip addr add ${cidr} dev ${config.networkInterface}`, { stdio: 'pipe' });
    log(`[network] Added IP alias ${cidr} on ${config.networkInterface}`);
  } catch (e) {
    // RTNETLINK: File exists — alias already set, ignore
  }
}

// ── MQTT client ───────────────────────────────────────────────────────────────

// Topics this bridge subscribes to, and the dispatcher for each.
// A single 'message' listener avoids MaxListenersExceededWarning with many pistes.
const mqttDispatch = new Map();

const mqttClient = mqtt.connect(mqttBroker);

mqttClient.on('connect', () => {
  log(`[MQTT] Connected to ${mqttBroker}`);
  for (const topic of mqttDispatch.keys()) {
    mqttClient.subscribe(topic, { qos: 0 }, () => log(`[MQTT] Subscribed: ${topic}`));
  }
});

mqttClient.on('error',      err => console.error('[MQTT] Error:', err.message));
mqttClient.on('disconnect', ()  => console.warn('[MQTT] Disconnected'));
mqttClient.on('reconnect',  ()  => log('[MQTT] Reconnecting...'));

mqttClient.on('message', (topic, payload) => {
  const dispatch = mqttDispatch.get(topic);
  if (dispatch) dispatch(payload);
});

// ── Mode: cms-side ────────────────────────────────────────────────────────────
// One UDP socket per piste, bound to the piste's IP. CMS → MQTT software/efp1,
// MQTT apparatus/efp1 → CMS (address learned from the first CMS packet).

function startCmsSide() {
  pistes.forEach(piste => {
    const ip   = pisteIp(piste);
    const sock = dgram.createSocket('udp4');
    let   cmsIp = null;

    addIpAlias(ip);

    // UDP → MQTT: CMS sends HELLO/DISP/ACK/NAK to this piste's IP
    sock.on('message', (msg, rinfo) => {
      if (!cmsIp) {
        cmsIp = rinfo.address;
        log(`[${piste.id}] CMS address: ${cmsIp}`);
      }
      mqttClient.publish(topicSoftware(piste), msg, { qos: 0, retain: false });
      log(`[${piste.id}] UDP→MQTT  from=${rinfo.address}  bytes=${msg.length}`);
    });

    sock.on('error', err => {
      console.error(`[${piste.id}] UDP error: ${err.message}`);
      console.error(`[${piste.id}] Is the IP alias set? sudo ip addr add ${ip}/24 dev ${config.networkInterface}`);
    });

    sock.bind(udpPort, ip, () => log(`[${piste.id}] Listening on UDP ${ip}:${udpPort}`));

    // MQTT → UDP: apparatus publishes INFO/NEXT/PREV; forward to CMS
    mqttDispatch.set(topicApparatus(piste), payload => {
      if (!cmsIp) {
        log(`[${piste.id}] MQTT→UDP skipped — CMS address not yet known`);
        return;
      }
      sock.send(payload, udpPort, cmsIp, err => {
        if (err) console.error(`[${piste.id}] UDP send error: ${err.message}`);
        else log(`[${piste.id}] MQTT→UDP  to=${cmsIp}  bytes=${payload.length}`);
      });
    });

    log(`[${piste.id}] Configured — IP ${ip}:${udpPort}`);
  });
}

// ── Mode: apparatus-side ──────────────────────────────────────────────────────
// One UDP socket bound to cmsIp (the address the apparatus sends to).
// Apparatus → MQTT apparatus/efp1 (piste found by sender IP),
// MQTT software/efp1 → apparatus at its configured IP.

function startApparatusSide() {
  const cmsIp = config.cmsIp;
  if (!cmsIp) {
    console.error('[config] mode "apparatus-side" requires "cmsIp" — the IP address the apparatus sends to.');
    process.exit(1);
  }

  addIpAlias(cmsIp);

  const byIp = new Map();
  pistes.forEach(piste => {
    const ip = pisteIp(piste);
    if (byIp.has(ip)) {
      console.error(`[config] Pistes "${byIp.get(ip).id}" and "${piste.id}" share IP ${ip}.`);
      process.exit(1);
    }
    byIp.set(ip, piste);
  });

  const sock = dgram.createSocket('udp4');
  const warnedUnknown = new Set();

  // UDP → MQTT: apparatus sends INFO/NEXT/PREV/ACK/NAK to the CMS IP
  sock.on('message', (msg, rinfo) => {
    const piste = byIp.get(rinfo.address);
    if (!piste) {
      if (!warnedUnknown.has(rinfo.address)) {
        warnedUnknown.add(rinfo.address);
        console.warn(`[bridge] Ignoring UDP from unknown apparatus ${rinfo.address} — add it to "pistes" in config.json`);
      }
      return;
    }
    mqttClient.publish(topicApparatus(piste), msg, { qos: 0, retain: false });
    log(`[${piste.id}] UDP→MQTT  from=${rinfo.address}  bytes=${msg.length}`);
  });

  sock.on('error', err => {
    console.error(`[bridge] UDP error: ${err.message}`);
    console.error(`[bridge] Is the IP alias set? sudo ip addr add ${cmsIp}/24 dev ${config.networkInterface}`);
    console.error('[bridge] Is another program (e.g. the CMS) still using this address and port?');
  });

  sock.bind(udpPort, cmsIp, () => log(`[bridge] Listening on UDP ${cmsIp}:${udpPort} (as CMS)`));

  // MQTT → UDP: CMS publishes HELLO/DISP/ACK/NAK; forward to the apparatus
  pistes.forEach(piste => {
    const ip = pisteIp(piste);
    mqttDispatch.set(topicSoftware(piste), payload => {
      sock.send(payload, udpPort, ip, err => {
        if (err) console.error(`[${piste.id}] UDP send error: ${err.message}`);
        else log(`[${piste.id}] MQTT→UDP  to=${ip}  bytes=${payload.length}`);
      });
    });
    log(`[${piste.id}] Configured — apparatus ${ip}:${udpPort}`);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (mode === 'apparatus-side') startApparatusSide();
else startCmsSide();

log(`[bridge] Started — mode=${mode}, ${pistes.length} piste(s)`);
