/**
 * Monster Grind — Multiplayer Network Foundation
 * =================================================
 * STEP 1 (done): WebSocket connection test only (DISCONNECTED/CONNECTING/CONNECTED/RECONNECTING).
 * STEP 2 (done): CREATE ROOM / JOIN ROOM / LEAVE ROOM, with a 4-player cap per room.
 * STEP 3 (done): PLAYER SYNC — position/rotation/animation broadcast to everyone else in a room.
 * STEP 4 (this update): MONSTER SYNC — the room HOST's existing single-player monster
 *                        spawn/AI keeps running completely unchanged; this server just
 *                        relays a summary of it (spawn/state/despawn) to everyone else in
 *                        the same room, and caches it so late joiners see monsters instantly.
 *                        Still no combat/damage/EXP/loot exchanged.
 *
 * Still intentionally NOT implemented (later steps):
 *   - Combat / Damage sync
 *   - HP / MP / EXP / Quest / Inventory / Loot sync
 *   - Party system beyond simple room membership
 *   - Host migration (if the host leaves, monster sync simply stops for that room —
 *     documented, not solved, per STEP 4 instructions)
 *   - Chat
 *
 * STEP 4 message protocol (matches monster-rpg-19.html's RemoteMonsterSystem exactly):
 *
 *   Client -> Server (host only — the server ignores these from a non-host socket)
 *     { type:'monsterSpawn',   monster: {monsterId,type,x,y,z,rotY,hp,maxHp,state} }
 *     { type:'monsterSnapshot', monsters: [ {monsterId,type,x,y,z,rotY,hp,maxHp,state}, ... ] }
 *     { type:'monsterState',   monsterId, x, y, z, rotY, hp, maxHp, state }
 *     { type:'monsterDespawn', monsterId }
 *
 *   Server -> Client
 *     Same four shapes, relayed to every OTHER member of the room (never echoed back to
 *     the host that sent it). A new joiner additionally receives one 'monsterSnapshot'
 *     built from the room's cached monster list immediately after 'roomJoined'.
 *
 * Room data structure (internal only — does not change the wire protocol from STEP 1-3):
 *   rooms: Map<roomId, { members: Set<WebSocket>, hostSocket: WebSocket, monsters: Map<monsterId, data> }>
 *   `monsters` is purely a CACHE of whatever the host last broadcast — this server does not
 *   simulate monster AI itself (that stays entirely client-side, in the existing single-player
 *   code, exactly as instructed).
 *
 * -------------------------------------------------------------------------
 * SETUP (run locally):
 *   1. Make sure Node.js is installed (v16+ recommended).
 *   2. In this folder, run:   npm install
 *   3. Start the server:      npm start        (or: node server.js)
 *   4. You should see:        [Server] Monster Grind test server listening on ws://localhost:8080
 *
 * TEST WITH THE CLIENT (monster-rpg-19.html) — 2 browsers:
 *   - Browser A: ONLINE -> CREATE ROOM (note the Room ID) -> PLAY. A is the host.
 *   - Browser B: ONLINE -> type that Room ID -> JOIN ROOM -> PLAY.
 *   - B should see A's monsters appear within ~1 second of pressing PLAY (monsterSnapshot
 *     sent immediately on join), and see them patrol/chase smoothly as A's world simulates them.
 *   - B does NOT spawn its own separate set of monsters — it's rendering A's.
 *   - Use Developer Mode (/dev MASTER then /killall or /spawn slime 3 in Browser A) to see
 *     spawns/despawns propagate to B live. Type /monstersync on in either browser's console
 *     for verbose [MonsterSync] logs.
 *   - Create a second, separate room (Room C/D) and confirm its monsters never appear in
 *     Room A/B's browsers, and vice versa.
 *   - LEAVE ROOM in either browser must not throw an error or freeze the other player.
 *
 * DEPLOYING LATER:
 *   - Any Node.js host that allows long-lived WebSocket connections works (e.g. Render,
 *     Railway, Fly.io, a VPS). Deploy this file (+ package.json), then change the client's
 *     SERVER_URL (Settings -> Multiplayer Server URL) to wss://<your-deployed-domain>.
 *   - PORT is read from the platform's environment variable automatically.
 * -------------------------------------------------------------------------
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS_PER_ROOM = 4;
const ROOM_ID_LENGTH = 6;
// Excludes 0/O and 1/I so Room IDs read out loud or typed by hand are less ambiguous.
const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const wss = new WebSocket.Server({ port: PORT });

/**
 * @typedef {{ members: Set<WebSocket>, hostSocket: WebSocket, monsters: Map<string, object> }} Room
 * @type {Map<string, Room>} roomId -> Room
 */
const rooms = new Map();
const usedPlayerIds = new Set();

console.log(`[Server] Monster Grind test server listening on ws://localhost:${PORT}`);
console.log('[Server] STEP 4 mode: Room + Player sync + Monster sync (host-authoritative cache) — no combat sync yet.');

function send(socket, obj){
  if(socket.readyState === WebSocket.OPEN){
    try{ socket.send(JSON.stringify(obj)); }
    catch(e){ console.warn('[Server] Send failed:', e.message); }
  }
}

function generateRoomId(){
  let id;
  do{
    id = '';
    for(let i=0;i<ROOM_ID_LENGTH;i++){
      id += ROOM_ID_CHARS[Math.floor(Math.random()*ROOM_ID_CHARS.length)];
    }
  } while(rooms.has(id));
  return id;
}

function generatePlayerId(){
  let id;
  do{ id = 'player_' + Math.random().toString(36).slice(2,8); }
  while(usedPlayerIds.has(id));
  usedPlayerIds.add(id);
  return id;
}

function createRoomRecord(hostSocket){
  return { members: new Set([hostSocket]), hostSocket, monsters: new Map() };
}

function broadcastRoomUpdate(roomId){
  const room = rooms.get(roomId);
  if(!room) return;
  const payload = { type:'roomUpdate', roomId, playerCount: room.members.size, maxPlayers: MAX_PLAYERS_PER_ROOM };
  room.members.forEach(memberSocket => send(memberSocket, payload));
}

function playerStatePayload(socket, type){
  return {
    type, playerId: socket.playerId,
    x: socket.px, y: socket.py, z: socket.pz,
    rot: socket.prot, anim: socket.panim,
  };
}

// Removes a socket from whatever room it's currently in (if any). Used for explicit
// "leaveRoom" requests, for disconnects, and defensively before createRoom/joinRoom
// in case a client somehow asks to join/create while already in a room.
// NOTE (STEP 4 / host migration): if the leaving socket was room.hostSocket, we deliberately
// do NOT promote a new host or touch room.monsters here — per the STEP 4 instructions, host
// migration is out of scope. Remaining members simply stop receiving monster updates until
// someone creates a fresh room.
function leaveCurrentRoom(socket, notifyLeaver){
  const roomId = socket.roomId;
  if(!roomId) return;
  const room = rooms.get(roomId);
  if(room){
    room.members.delete(socket);
    const leftPayload = { type:'playerLeft', playerId: socket.playerId };
    room.members.forEach(memberSocket => send(memberSocket, leftPayload));
    if(room.members.size === 0){
      rooms.delete(roomId);
      console.log(`[Server] Room ${roomId} is now empty — removed.`);
    } else {
      broadcastRoomUpdate(roomId);
    }
  }
  console.log(`[Server] ${socket.playerId} left room ${roomId}`);
  socket.roomId = null;
  if(notifyLeaver) send(socket, { type:'roomLeft' });
}

wss.on('connection', (socket) => {
  socket.playerId = generatePlayerId();
  socket.roomId = null;
  // STEP 3: last known player transform.
  socket.px = 0; socket.py = 0; socket.pz = 0; socket.prot = 0; socket.panim = 'idle';

  console.log(`[Server] Client connected as ${socket.playerId}. Total clients: ${wss.clients.size}`);

  send(socket, { type:'welcome', playerId: socket.playerId, message: 'Connected to Monster Grind test server' });

  socket.on('message', (raw) => {
    // Blanket safety net (requirement: no uncaught exception may ever crash the server,
    // no matter what a malformed or malicious packet contains).
    try{
      console.log('[Server] Received from '+socket.playerId+':', raw.toString());
      let data;
      try{ data = JSON.parse(raw); }
      catch(e){ console.warn('[Server] Ignoring non-JSON message'); return; }
      if(!data || typeof data.type !== 'string') return;

      switch(data.type){
        case 'createRoom': {
          leaveCurrentRoom(socket, false); // defensive: drop any previous room first
          const roomId = generateRoomId();
          rooms.set(roomId, createRoomRecord(socket));
          socket.roomId = roomId;
          console.log(`[Server] ${socket.playerId} created room ${roomId} (host)`);
          send(socket, { type:'roomCreated', roomId, playerCount:1, maxPlayers: MAX_PLAYERS_PER_ROOM });
          break;
        }
        case 'joinRoom': {
          const roomId = String(data.roomId || '').trim().toUpperCase();
          const room = rooms.get(roomId);
          if(!room){ send(socket, { type:'roomError', message:'Room not found' }); break; }
          if(room.members.size >= MAX_PLAYERS_PER_ROOM){ send(socket, { type:'roomError', message:'Room is full' }); break; }
          leaveCurrentRoom(socket, false); // defensive: drop any previous room first

          // STEP 3: tell the new joiner about everyone already here, before adding them.
          const existingPlayers = [];
          room.members.forEach(memberSocket => existingPlayers.push({
            playerId: memberSocket.playerId,
            x: memberSocket.px, y: memberSocket.py, z: memberSocket.pz,
            rot: memberSocket.prot, anim: memberSocket.panim,
          }));

          room.members.add(socket);
          socket.roomId = roomId;
          console.log(`[Server] ${socket.playerId} joined room ${roomId} (${room.members.size}/${MAX_PLAYERS_PER_ROOM})`);

          send(socket, { type:'roomJoined', roomId, playerCount: room.members.size, maxPlayers: MAX_PLAYERS_PER_ROOM });
          send(socket, { type:'playerList', players: existingPlayers }); // STEP 3

          // STEP 4: give the new joiner the room's current monster cache immediately, so
          // they see monsters that already existed without waiting for the next host tick.
          if(room.monsters.size){
            send(socket, { type:'monsterSnapshot', monsters: Array.from(room.monsters.values()) });
            console.log(`[MonsterSync] sent initial snapshot (count=${room.monsters.size}) to ${socket.playerId} joining room ${roomId}`);
          }

          broadcastRoomUpdate(roomId);
          room.members.forEach(memberSocket => {
            if(memberSocket !== socket) send(memberSocket, playerStatePayload(socket, 'playerJoined'));
          });
          break;
        }
        case 'leaveRoom': {
          leaveCurrentRoom(socket, true);
          break;
        }
        case 'playerState': {
          // STEP 3: update this socket's last known transform, then relay to the rest of the room.
          if(!socket.roomId) break;
          if(typeof data.x === 'number') socket.px = data.x;
          if(typeof data.y === 'number') socket.py = data.y;
          if(typeof data.z === 'number') socket.pz = data.z;
          if(typeof data.rot === 'number') socket.prot = data.rot;
          if(typeof data.anim === 'string') socket.panim = data.anim;

          const room = rooms.get(socket.roomId);
          if(room){
            const payload = playerStatePayload(socket, 'playerState');
            room.members.forEach(memberSocket => { if(memberSocket !== socket) send(memberSocket, payload); });
          }
          break;
        }

        // ---------------- STEP 4: MONSTER SYNC ----------------
        // Only the room's host is authoritative for monster data. Anything from a
        // non-host socket (or a socket not in a room at all) is silently ignored —
        // this is the "server-authoritative preparation" the spec asked for: the
        // server already gatekeeps *who* is allowed to say what a monster is doing,
        // even though it doesn't simulate the monsters itself yet.

        case 'monsterSpawn': {
          const room = rooms.get(socket.roomId);
          if(!room || room.hostSocket !== socket) break;
          const m = data.monster;
          if(!m || typeof m.monsterId !== 'string') break; // malformed packet safety
          if(room.monsters.has(m.monsterId)) break; // never spawn a duplicate id
          room.monsters.set(m.monsterId, m);
          room.members.forEach(memberSocket => {
            if(memberSocket !== socket) send(memberSocket, { type:'monsterSpawn', monster: m });
          });
          console.log(`[MonsterSync] spawn monsterId=${m.monsterId} type=${m.type} room=${socket.roomId}`);
          break;
        }
        case 'monsterSnapshot': {
          const room = rooms.get(socket.roomId);
          if(!room || room.hostSocket !== socket) break;
          const list = Array.isArray(data.monsters) ? data.monsters : [];
          list.forEach(m => { if(m && typeof m.monsterId === 'string') room.monsters.set(m.monsterId, m); });
          room.members.forEach(memberSocket => {
            if(memberSocket !== socket) send(memberSocket, { type:'monsterSnapshot', monsters: list });
          });
          break; // intentionally not logged every tick — would spam the console at ~12Hz
        }
        case 'monsterState': {
          const room = rooms.get(socket.roomId);
          if(!room || room.hostSocket !== socket) break;
          const monsterId = data.monsterId;
          if(typeof monsterId !== 'string') break;
          const existing = room.monsters.get(monsterId);
          if(existing) Object.assign(existing, data);
          room.members.forEach(memberSocket => {
            if(memberSocket !== socket) send(memberSocket, { ...data, type:'monsterState' });
          });
          break;
        }
        case 'monsterDespawn': {
          const room = rooms.get(socket.roomId);
          if(!room || room.hostSocket !== socket) break;
          const monsterId = data.monsterId;
          if(typeof monsterId !== 'string') break;
          if(!room.monsters.has(monsterId)) break; // defensive: unknown id -> silent no-op, never crash
          room.monsters.delete(monsterId);
          room.members.forEach(memberSocket => {
            if(memberSocket !== socket) send(memberSocket, { type:'monsterDespawn', monsterId });
          });
          console.log(`[MonsterSync] despawn monsterId=${monsterId} room=${socket.roomId}`);
          break;
        }

        default:
          console.log('[Server] Ignoring unhandled message type:', data.type);
          break;
      }
    }catch(err){
      console.warn(`[Server] Error handling message from ${socket.playerId}:`, err.message);
    }
  });

  socket.on('close', () => {
    console.log(`[Server] ${socket.playerId} disconnected. Total clients: ${wss.clients.size - 1}`);
    leaveCurrentRoom(socket, false);
    usedPlayerIds.delete(socket.playerId);
  });

  socket.on('error', (err) => {
    console.warn(`[Server] Socket error for ${socket.playerId}:`, err.message);
  });
});

wss.on('error', (err) => {
  console.error('[Server] Server error:', err.message);
});
