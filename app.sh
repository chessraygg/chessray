#!/bin/bash
# ChessRay Electron app management script

APP_LOG="/tmp/chessray-app.log"
FORGE_LOG="/tmp/chessray-forge.log"
APP_DIR="$(cd "$(dirname "$0")/packages/electron" && pwd)"
SCREEN_NAME="chessray"

kill_app() {
  # Kill the screen session
  screen -S "$SCREEN_NAME" -X quit 2>/dev/null
  # Kill any remaining Electron/node processes
  pkill -9 -f "Electron" 2>/dev/null
  pkill -9 -f "electron-forge" 2>/dev/null
  lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null
  lsof -ti:5174 2>/dev/null | xargs kill -9 2>/dev/null
  sleep 1
}

case "${1:-}" in
  start)
    echo "Starting ChessRay..."
    screen -dmS "$SCREEN_NAME" bash -c "cd '$APP_DIR' && npx electron-forge start 2>&1 | tee '$FORGE_LOG'"
    echo "App starting in screen session '$SCREEN_NAME'"
    echo "  Attach: screen -r $SCREEN_NAME"
    echo "  Forge log: $FORGE_LOG"
    echo "  App log: $APP_LOG"
    ;;
  stop)
    echo "Stopping ChessRay..."
    kill_app
    echo "Done."
    ;;
  restart)
    echo "Stopping ChessRay..."
    kill_app
    echo "Starting ChessRay..."
    screen -dmS "$SCREEN_NAME" bash -c "cd '$APP_DIR' && npx electron-forge start 2>&1 | tee '$FORGE_LOG'"
    echo "App restarting in screen session '$SCREEN_NAME'"
    ;;
  log)
    tail -f "$APP_LOG"
    ;;
  forge-log)
    tail -f "$FORGE_LOG"
    ;;
  status)
    if pgrep -f "Electron" > /dev/null 2>&1; then
      echo "Running"
      pgrep -af "Electron" 2>/dev/null | head -3
    else
      echo "Not running"
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|log|forge-log|status}"
    exit 1
    ;;
esac
