# openpiste-bridge

OpenPiste Level 1 bridge — translates EFP1.1 Cyrano UDP traffic to MQTT and back, so commercial fencing competition management software (EnGarde, Engarde-Escrime, …) can communicate with OpenPiste apparatus over a standard MQTT broker without any reconfiguration on the CMS side.

## How it works

The bridge runs on a Raspberry Pi (or any Linux host) on the same network as the CMS and the MQTT broker. For each configured piste it binds a UDP socket to a static IP alias, so the CMS connects to the address it already knows. Incoming UDP packets are forwarded to MQTT; outgoing MQTT messages are forwarded back to the CMS via UDP unicast.

```
CMS ──UDP──► bridge ──MQTT──► apparatus (ESP32)
CMS ◄─UDP── bridge ◄─MQTT── apparatus (ESP32)
```

MQTT topics: `openpiste/{piste_id}/software/efp1` (CMS→apparatus) and `openpiste/{piste_id}/apparatus/efp1` (apparatus→CMS).

## Install on Raspberry Pi

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/pietwauters/openpiste-bridge/main/install-on-pi.sh)
```

The script clones this repo, runs `npm install`, copies `config.example.json` → `config.json`, and registers a systemd service that starts automatically at boot.

Edit `~/openpiste-bridge/config.json` to match your network, then:

```bash
sudo systemctl start openpiste-bridge
sudo systemctl status openpiste-bridge
journalctl -u openpiste-bridge -f
```

## Configuration

Copy `config.example.json` to `config.json` and adjust:

| Field | Description |
|-------|-------------|
| `mqttBroker` | MQTT broker URL, e.g. `mqtt://localhost` |
| `udpPort` | UDP port for Cyrano traffic (default `50100`) |
| `subnet` | Network subnet prefix, e.g. `192.168.0` |
| `ipBase` | Base offset for piste IP aliases (`ipBase + piste number`) |
| `networkInterface` | Interface to add IP aliases on, e.g. `eth0` |
| `pistes` | Array of `{ "number": N, "id": "..." }` entries |

## Protocol specification

This bridge implements the UDP–MQTT relay described in **[OpenPiste Protocol — Level 1](https://github.com/pietwauters/esp32scoringdeviceMqtt/blob/opp2-canonical-state/docs/level1.md)** (§7 "The UDP–MQTT bridge"). That document covers topic structure, QoS rules, deployment scenarios, and the fixed-IP constraint.

## Part of OpenPiste

This bridge is part of the [OpenPiste](https://github.com/pietwauters/esp32scoringdeviceMqtt) platform — open source electronics for fencing competitions.
