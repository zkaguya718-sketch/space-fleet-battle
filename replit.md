# Space Fleet Battle

A real-time online multiplayer strategy game (similar to Battleship) built with React, Vite, and Tailwind CSS.

## Tech Stack

- **Frontend:** React 19, TypeScript
- **Build Tool:** Vite 7
- **Styling:** Tailwind CSS 4
- **Multiplayer:** MQTT over WebSockets (public HiveMQ broker) with BroadcastChannel fallback
- **Audio:** Web Audio API for sound effects
- **Bundling:** vite-plugin-singlefile (produces a single HTML file)

## Project Structure

```
src/
  App.tsx          - Main UI (Lobby, WaitingRoom, BattleScreen, etc.)
  multiplayer.ts   - Game logic & transport layer (MQTT/BroadcastChannel)
  main.tsx         - App bootstrap
  styles.css       - Game-specific styles/animations
  index.css        - Global Tailwind directives
  utils/cn.ts      - Tailwind class utility
```

## Development

- **Dev server:** `npm run dev` — runs on port 5000
- **Build:** `npm run build` — outputs to `dist/`

## Deployment

Configured as a static site deployment:
- Build command: `npm run build`
- Public directory: `dist`
