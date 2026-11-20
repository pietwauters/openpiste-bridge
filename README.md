# openpiste-bridge

OpenPiste Level 1 bridge — relays EFP1.1 (Cyrano) UDP traffic to and from an MQTT broker, unchanged. It lets classic Cyrano equipment talk to MQTT-native equipment without reconfiguring the classic side.

It runs in one of two modes, depending on which side is classic:

| Mode | Classic (UDP) side | MQTT side | Bridge impersonates |
|------|--------------------|-----------|---------------------|
| `cms-side` (default) | Competition management software (EnGarde, …) | OpenPiste apparatus | the apparatus |
| `apparatus-side` | Scoring apparatus | CMS implementing OpenPiste Level 1 | the CMS |

MQTT topics (both modes): `openpiste/{piste_id}/software/efp1` (CMS→apparatus) and `openpiste/{piste_id}/apparatus/efp1` (apparatus→CMS).

## Mode `cms-side` — classic CMS, OpenPiste apparatus

```
CMS ──UDP──► bridge ──MQTT──► apparatus (ESP32)
CMS ◄─UDP── bridge ◄─MQTT── apparatus (ESP32)
```

For each configured piste the bridge binds a UDP socket to a static IP alias — the address the CMS already uses for that piste's apparatus. Incoming UDP packets are published on `software/efp1`; messages on `apparatus/efp1` are sent back to the CMS (its address is learned from the first packet it sends).

## Mode `apparatus-side` — classic apparatus, Level 1 CMS

```
apparatus ──UDP──► bridge ──MQTT──► CMS (Level 1)
apparatus ◄─UDP── bridge ◄─MQTT── CMS (Level 1)
```

Use this to test or run a CMS that implements OpenPiste Level 1 with existing Cyrano scoring apparatus.

The bridge binds one UDP socket to `cmsIp` — the address the apparatus is configured to send to. Each incoming packet is matched to a piste by its **sender IP** and published on that piste's `apparatus/efp1`. Messages the CMS publishes on `software/efp1` are sent to the apparatus' IP. Packets from unknown IPs are ignored (with a warning in the log).

Things to get right:

- **The bridge must own `cmsIp`.** Either give the bridge host the IP address the apparatus already sends to (the CMS PC then no longer uses that address — it only talks to the broker), or reconfigure the apparatus to send to the bridge host's address.
- **Apparatus IPs must be fixed** and listed in `pistes` — by default `subnet.(ipBase + number)`, or per piste with `"ip"`.
- See `config.apparatus-side.example.json`.

## Install on Raspberry Pi

```bash
bash <(wget -qO- https://raw.githubusercontent.com/pietwauters/openpiste-bridge/main/install-on-pi.sh)
```

The script clones this repo, runs `npm install`, copies `config.example.json` → `config.json`, and registers a systemd service that starts automatically at boot. For `apparatus-side`, copy `config.apparatus-side.example.json` over `config.json` instead.

Edit `~/openpiste-bridge/config.json` to match your network, then:

```bash
sudo systemctl start openpiste-bridge
sudo systemctl status openpiste-bridge
journalctl -u openpiste-bridge -f
```

Add `--verbose` to `ExecStart` in the service file to log every relayed packet.

## Configuration

Copy `config.example.json` (or `config.apparatus-side.example.json`) to `config.json` and adjust. Use `--config <file>` to load a different file.

| Field | Description |
|-------|-------------|
| `mode` | `cms-side` (default) or `apparatus-side` |
| `mqttBroker` | MQTT broker URL, e.g. `mqtt://localhost` |
| `udpPort` | UDP port for Cyrano traffic (default `50100`) |
| `cmsIp` | `apparatus-side` only: the IP the apparatus sends to; the bridge binds it |
| `subnet` | Network subnet prefix, e.g. `192.168.0` |
| `ipBase` | Base offset for piste IPs (`ipBase + piste number`) |
| `networkInterface` | Interface to add IP aliases on, e.g. `eth0`. Omit to skip alias creation (addresses already configured, or local testing) |
| `pistes` | Array of `{ "number": N, "id": "...", "ip": "..." }`. `ip` is optional and overrides `subnet.(ipBase + number)` |

What the piste IPs mean depends on the mode: in `cms-side` they are the aliases the bridge takes on; in `apparatus-side` they are the addresses of the real apparatus.

## Testing

`test.js` runs the real bridge on loopback addresses (no root, no IP aliases) and checks a message in each direction. It needs an MQTT broker on `localhost:1883` (`sudo apt install mosquitto`) and Linux (it uses `127.0.0.2`).

```bash
node test.js                   # both modes
node test.js apparatus-side    # one mode
node test.js --verbose         # include the bridge's log
```

To check a Level 1 CMS on its own, without apparatus or bridge, publish a sample EFP1.1 message where the bridge would put it:

```bash
mosquitto_pub -t 'openpiste/1/apparatus/efp1' \
  -m '|EFP1.1|INFO|1|TestComp|1|1|1|1|3:00|000|I|E|N|H|REF|||%||||||||||||||%||||||||||||||%|'
mosquitto_sub -v -t 'openpiste/+/software/efp1'   # watch what the CMS sends
```

## Protocol specification

This bridge implements the UDP–MQTT relay described in **[OpenPiste Protocol — Level 1](https://github.com/pietwauters/esp32scoringdeviceMqtt/blob/main/docs/level1.md)** (§7 "The UDP–MQTT bridge"). That document covers topic structure, QoS rules, deployment scenarios, and the fixed-IP constraint.

## Part of OpenPiste

This bridge is part of the [OpenPiste](https://github.com/pietwauters/esp32scoringdeviceMqtt) platform — open source electronics for fencing competitions.
