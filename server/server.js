const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const config = require('./src/config');
const { createCardRegistry } = require('./src/cardRegistry');
const { createRoomStore } = require('./src/roomStore');
const { createGameFlow } = require('./src/gameFlow');
const { registerSocketHandlers } = require('./src/socketHandlers');
const { getLocalIP } = require('./src/network');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use((req, res, next) => {
  const p = req.path || '';
  if (p === '/' || p === '/join' || /\.(html|js|css)$/i.test(p)) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Packaged (pkg) builds keep writable data next to the .exe instead of
// inside the (read-only, virtual) snapshot filesystem. Overridable via
// DATA_DIR so tests don't mutate the real used_cards_memory.json.
const DATA_DIR = process.env.DATA_DIR || (process.pkg ? path.dirname(process.execPath) : __dirname);

const cardRegistry = createCardRegistry({
  cardsJsonPath: path.join(__dirname, 'public', 'data', 'cards.json'),
  dataDir: DATA_DIR,
});

const roomStore = createRoomStore({ config, cardRegistry });
const gameFlow = createGameFlow({ io, config, roomStore, cardRegistry });

registerSocketHandlers({ io, config, roomStore, gameFlow, cardRegistry });

// Join URL route
app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(config.PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const external = process.env.RENDER_EXTERNAL_URL || process.env.VERCEL_URL;
  const publicUrl = external ? `${external.replace(/\/$/, '')}` : `http://${ip}:${config.PORT}`;
  console.log(`\n🎮 Joking Hazard Online`);
  console.log(`   Local:   http://localhost:${config.PORT}`);
  if (external) {
    console.log(`   Public:  ${publicUrl}`);
  } else {
    console.log(`   Red:     http://${ip}:${config.PORT}`);
  }
  console.log(`\n   Compartí la URL de red con tus amigos en la misma WiFi.\n`);
});


