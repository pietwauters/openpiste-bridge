#!/bin/bash
# Run this on the Raspberry Pi to clone, install, and enable the bridge service.

set -e

REPO_DIR="$HOME/openpiste-bridge"
SERVICE_NAME="openpiste-bridge"

# ── Clone ─────────────────────────────────────────────────────────────────────

git clone https://github.com/pietwauters/openpiste-bridge.git "$REPO_DIR"
cd "$REPO_DIR"

# ── Install dependencies ──────────────────────────────────────────────────────

npm install

# ── Config ────────────────────────────────────────────────────────────────────

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo ""
  echo "config.json created. Edit it before starting the bridge:"
  echo "  nano $REPO_DIR/config.json"
  echo ""
else
  echo "config.json already exists — not overwritten."
fi

# ── Systemd service ───────────────────────────────────────────────────────────

# Patch WorkingDirectory in the service file to match the actual install path
sed "s|WorkingDirectory=.*|WorkingDirectory=$REPO_DIR|" \
  "$REPO_DIR/openpiste-bridge.service" \
  > /tmp/${SERVICE_NAME}.service

sudo cp /tmp/${SERVICE_NAME}.service /etc/systemd/system/${SERVICE_NAME}.service
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo ""
echo "Service installed and enabled."
echo "After editing config.json, start it with:"
echo "  sudo systemctl start $SERVICE_NAME"
echo ""
echo "Check status with:"
echo "  sudo systemctl status $SERVICE_NAME"
echo "  journalctl -u $SERVICE_NAME -f"
