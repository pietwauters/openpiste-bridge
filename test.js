'use strict';

// Self-contained end-to-end test for bridge.js — no IP aliases, no root.
//
// Runs the real bridge.js against a temporary config bound to loopback
// addresses (127.0.0.x — all of 127/8 is routable on Linux), simulates the
// UDP and MQTT peers, and checks that a message passes in each direction.
//
// Requires an MQTT broker on localhost:1883 (e.g. `sudo apt install mosquitto`).
//
// Usage:
//   node test.js                  — test both modes
//   node test.js cms-side         — classic CMS (UDP) ⇄ OpenPiste apparatus (MQTT)
//   node test.js apparatus-side   — classic apparatus (UDP) ⇄ Level 1 CMS (MQTT)
//   add --verbose to see the bridge's log

const dgram     = require('dgram');
const mqtt      = require('mqtt');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const { spawn } = require('child_process');

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost';
const UDP_PORT    = 50100;
const PISTE_ID    = 'T1';
const BRIDGE_IP   = '127.0.0.1';   // address the bridge binds
const PEER_IP     = '127.0.0.2';   // address of the simulated UDP peer
const TIMEOUT_MS  = 3000;

const FAKE_HELLO = Buffer.from('|EFP1.1|HELLO|1|TestComp|||||||||||||||||');
const FAKE_INFO  = Buffer.from('|EFP1.1|INFO|1|TestComp|1|1|1|1|3:00|000|I|E|N|H|REF|||%||||||||||||||%||||||||||||||%|');

const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
const sleep   = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, what) {
  return Promise.race([
    promise,
    sleep(TIMEOUT_MS).then(() => { throw new Error(`timeout waiting for ${what}`); }),
  ]);
}

function startBridge(config) {
  const file = path.join(os.tmpdir(), `openpiste-bridge-test-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const child = spawn(process.execPath,
    [path.join(__dirname, 'bridge.js'), '--verbose', '--config', file],
    { stdio: verbose ? 'inherit' : 'ignore' });
  return { child, cleanup: () => { child.kill(); fs.rmSync(file, { force: true }); } };
}

function connectMqtt() {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(MQTT_BROKER, { reconnectPeriod: 0 });
    c.once('connect', () => resolve(c));
    c.once('error', err => reject(new Error(`MQTT broker ${MQTT_BROKER}: ${err.message}`)));
  });
}

function bindUdp(ip) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(UDP_PORT, ip, () => resolve(s));
  });
}

const nextMqtt = (client, topic) => new Promise(resolve =>
  client.on('message', (t, p) => { if (t === topic) resolve(p); }));
const nextUdp = sock => new Promise(resolve =>
  sock.once('message', (msg, rinfo) => resolve({ msg, rinfo })));

function check(label, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

// Classic CMS (UDP) ⇄ bridge ⇄ OpenPiste apparatus (MQTT)
async function testCmsSide() {
  console.log('cms-side:');
  const bridge = startBridge({
    mode: 'cms-side', mqttBroker: MQTT_BROKER, udpPort: UDP_PORT,
    pistes: [{ number: 1, id: PISTE_ID, ip: BRIDGE_IP }],
  });
  const apparatus = await connectMqtt();     // simulated MQTT apparatus
  const cms = await bindUdp(PEER_IP);        // simulated UDP CMS
  try {
    await new Promise(r => apparatus.subscribe(`openpiste/${PISTE_ID}/software/efp1`, r));
    await sleep(500);                        // let the bridge bind and subscribe

    const gotMqtt = nextMqtt(apparatus, `openpiste/${PISTE_ID}/software/efp1`);
    cms.send(FAKE_HELLO, UDP_PORT, BRIDGE_IP);
    const p1 = await withTimeout(gotMqtt, 'CMS HELLO on software/efp1');
    check('CMS UDP → software/efp1', p1.equals(FAKE_HELLO));

    const gotUdp = nextUdp(cms);
    apparatus.publish(`openpiste/${PISTE_ID}/apparatus/efp1`, FAKE_INFO);
    const { msg } = await withTimeout(gotUdp, 'INFO at CMS');
    check('apparatus/efp1 → CMS UDP', msg.equals(FAKE_INFO));
  } finally {
    cms.close(); apparatus.end(); bridge.cleanup();
  }
}

// Classic apparatus (UDP) ⇄ bridge ⇄ Level 1 CMS (MQTT)
async function testApparatusSide() {
  console.log('apparatus-side:');
  const bridge = startBridge({
    mode: 'apparatus-side', mqttBroker: MQTT_BROKER, udpPort: UDP_PORT, cmsIp: BRIDGE_IP,
    pistes: [{ number: 1, id: PISTE_ID, ip: PEER_IP }],
  });
  const cms = await connectMqtt();           // simulated Level 1 CMS
  const apparatus = await bindUdp(PEER_IP);  // simulated UDP apparatus
  try {
    await new Promise(r => cms.subscribe(`openpiste/${PISTE_ID}/apparatus/efp1`, r));
    await sleep(500);

    const gotMqtt = nextMqtt(cms, `openpiste/${PISTE_ID}/apparatus/efp1`);
    apparatus.send(FAKE_INFO, UDP_PORT, BRIDGE_IP);
    const p1 = await withTimeout(gotMqtt, 'apparatus INFO on apparatus/efp1');
    check('apparatus UDP → apparatus/efp1', p1.equals(FAKE_INFO));

    const gotUdp = nextUdp(apparatus);
    cms.publish(`openpiste/${PISTE_ID}/software/efp1`, FAKE_HELLO);
    const { msg, rinfo } = await withTimeout(gotUdp, 'HELLO at apparatus');
    check('software/efp1 → apparatus UDP', msg.equals(FAKE_HELLO));
    check(`apparatus sees CMS at ${BRIDGE_IP}`, rinfo.address === BRIDGE_IP);
  } finally {
    apparatus.close(); cms.end(); bridge.cleanup();
  }
}

(async () => {
  const which = process.argv.slice(2).find(a => !a.startsWith('-'));
  try {
    if (!which || which === 'cms-side')       await testCmsSide();
    if (!which || which === 'apparatus-side') await testApparatusSide();
    if (which && !['cms-side', 'apparatus-side'].includes(which)) {
      console.log('Usage: node test.js [cms-side|apparatus-side] [--verbose]');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`  FAIL  ${e.message}`);
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(), 100);
})();
