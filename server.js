/**
 * Monster Grind — Multiplayer Network Foundation
 * =================================================
 * STEP 1 (done): WebSocket connection test only (DISCONNECTED/CONNECTING/CONNECTED/RECONNECTING).
 * STEP 2 (done): CREATE ROOM / JOIN ROOM / LEAVE ROOM, with a 4-player cap per room.
 * STEP 3 (done): PLAYER SYNC — position/rotation/animation broadcast to everyone else in a room.
 * STEP 4 (previous): MONSTER SYNC — the room HOST's existing single-player monster
 *                     spawn/AI keeps running completely unchanged; this server just
 *                     relays a summary of it (spawn/state/despawn) to everyone else in
 *                     the same room, and caches it so late joiners see monsters instantly.
 * STEP 4 BUGFIX (previous): a joining player wasn't seeing the host's monsters. Root
 *                     cause was client-side (loadWorld() running twice on the host's first
 *                     PLAY press, orphaning the first batch of monsters on the server without
 *                     ever despawning them) — fixed in monster-rpg-19-3.html. This server
 *                     update adds 'requestMonsterSnapshot' as a robust, explicit pull so a
 *                     joining client can always ask for the room's current monster list the
 *                     moment it's ready to render one, instead of relying only on the
 *                     automatic push at join time.
 * STEP 5 (previous, client-only): MONSTER TARGETING — the host's monster AI now picks
 *                     the nearest player (itself or any remote player) as a target instead
 *                     of always the host. This server needed NO changes: it already relays
 *                     whatever fields are on a monster object verbatim (monsterSpawn/
 *                     monsterState/monsterSnapshot), so the new `targetPlayerId` field on
 *                     each monster payload just flows through the existing relay untouched.
 *                     Still no real damage/HP applied to remote players — see client comments.
 * DAY/NIGHT SYNC (previous, v2 — bugfix): v1 sent a Date.now()-based timestamp and had
 *                     each client derive elapsed time from (Date.now() - origin). Real
 *                     2-device testing showed this fails whenever the devices' system
 *                     clocks disagree (very common on phones/tablets) — one device saw day,
 *                     the other night, despite being in the same room. FIXED by removing
 *                     all Date.now()/timestamp comparison entirely: every client just keeps
 *                     ticking Game.timeOfDay locally every frame (same mechanism Single
 *                     Player always used — driven by requestAnimationFrame's delta time,
 *                     never by the system clock), and the host periodically broadcasts its
 *                     current timeOfDay (a plain 0..1 fraction) which every other client
 *                     hard-snaps to. No wall-clock or timezone value is ever compared
 *                     across devices. Stored per-room, so Room A and Room B never share a
 *                     clock. Sent to a joiner immediately on join (same pattern as the
 *                     monster snapshot), plus an explicit 'requestWorldTime' pull.
 * ATTACK ANIMATION SYNC (previous): a quick attack could previously fall between two
 *                     ~12Hz playerState snapshot ticks and never be seen by other players.
 *                     Fixed with a dedicated one-shot 'playerAttack' event sent the instant
 *                     a local attack fires (independent of the periodic snapshot), relayed
 *                     live to the rest of the room only — nothing is cached, since it's a
 *                     transient animation cue, not persistent state.
 * MULTIPLAYER COMBAT (previous): host-authoritative. The host's client is the only one
 *                     with real monster objects, so a non-host's attack ('monsterAttack')
 *                     is relayed ONLY to that room's host (never broadcast, never trusted
 *                     to set HP itself) — roomId/playerId always come from the socket's own
 *                     session, never from the packet. The host applies the hit locally
 *                     (reusing its existing damage/death code, unchanged) and confirms with
 *                     'monsterCombatResult', which this server relays to everyone else in
 *                     the same room. Both messages are transient events (like playerAttack)
 *                     — nothing is cached, since monster HP itself is already kept in sync
 *                     via the existing monsterState/monsterSnapshot system.
 * MULTIPLAYER EXP + LEVEL SYNC (previous): still host-authoritative — only the host ever
 *                     runs killMonster() (it's the only one with real monster objects), so
 *                     only the host may award EXP via 'monsterExpAward', and only to players
 *                     it lists as contributors (tracked client-side from the existing combat
 *                     hits in STEP 5). Each contributor's own client applies the EXP to
 *                     itself via the existing gainExp()/level-up code, completely unchanged
 *                     — this server never computes or stores anyone's level/exp math, it only
 *                     relays 'playerLevelSync' events (sent on room join and on EXP gain,
 *                     never per-frame) and remembers each socket's last-known level/exp so a
 *                     late joiner's playerList snapshot already includes everyone's level.
 * BUGFIX + NEW FEATURES (this update):
 *   1. Monster-hits-remote-player bugfix: a monster targeting a guest previously applied no
 *      damage anywhere. Added 'monsterAttacksPlayer', sent by the host directly to that
 *      specific player's own socket (found within the SAME room only), so their own client
 *      applies it to their own real HP.
 *   2. Player-vs-player (new): each player stays authoritative over their own HP, same
 *      principle as monster combat. 'playerAttackPlayer' carries only the attacker's own
 *      atk/crit stats (never a damage number) to the target's socket; the target computes
 *      real damage using their own def and applies it locally, then 'playerCombatResult'
 *      relays the confirmed number back to the original attacker so they see it too.
 *   3. Equipment visual sync (new): 'playerEquipment' carries only a color per slot (no
 *      stats, no item data) so other players can see actual equipped gear instead of a
 *      generic look. Stored on the socket like level/exp, included in the join snapshot.
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
 *   Client -> Server (any room member — used to explicitly ask for the current list)
 *     { type:'requestMonsterSnapshot' }
 *     { type:'worldTime', timeOfDay }        (host only — plain 0..1 fraction, never a timestamp)
 *     { type:'requestWorldTime' }            (any room member)
 *
 *   Client -> Server (attack animation cue)
 *     { type:'playerAttack', kind }   (kind: 'basic'|'heavy'|'skill1'|'skill2'|'skill3'|'ultimate')
 *   Server -> Client
 *     { type:'playerAttack', playerId, kind }   (relayed live, never cached, never echoed to sender)
 *
 *   Client -> Server (combat)
 *     { type:'monsterAttack', monsterId, attackType, damage, crit, attackId }
 *       (sent by a non-host attacker; playerId is NOT trusted from the packet — the server
 *        stamps it from the socket's own session before relaying to the room's host)
 *     { type:'monsterCombatResult', monsterId, attackerId, damage, crit, hp, maxHp }
 *       (sent ONLY by the room's host, after applying a hit — relayed to everyone else)
 *   Server -> Client (combat)
 *     { type:'monsterAttack', monsterId, attackerId, attackType, damage, crit, attackId }
 *       (sent ONLY to the room's host socket — never broadcast)
 *     { type:'monsterCombatResult', monsterId, attackerId, damage, crit, hp, maxHp }
 *       (relayed to every OTHER member of the same room)
 *
 *   Client -> Server (EXP/Level)
 *     { type:'playerLevelSync', level, exp }
 *   Server -> Client
 *     { type:'playerLevelSync', playerId, level, exp }   (relayed to every OTHER room member)
 *     { type:'monsterExpAward', contributorIds:[...], exp }   (host only)
 *   Server -> Client (individually, never broadcast)
 *     { type:'expAward', exp }   (sent to each contributing player's own socket)
 *
 *   Client -> Server (bugfix: monster hits a remote player)
 *     { type:'monsterAttacksPlayer', targetPlayerId, damage, monsterId, monsterName }  (host only)
 *   Server -> Client (individually, never broadcast)
 *     { type:'monsterAttacksPlayer', targetPlayerId, damage, monsterId, monsterName }
 *
 *   Client -> Server (new: player vs player)
 *     { type:'playerAttackPlayer', targetPlayerId, attackType, atk, critRate, critDmg }
 *     { type:'playerCombatResult', targetPlayerId, damage, crit }   (sent by the victim)
 *   Server -> Client (individually, never broadcast)
 *     { type:'playerAttackPlayer', targetPlayerId, attackerId, attackType, atk, critRate, critDmg }
 *     { type:'playerCombatResult', targetPlayerId, attackerId, damage, crit }
 *
 *   Client -> Server (new: equipment visuals)
 *     { type:'playerEquipment', equipment:{weapon,armor,helmet,accessory} }  (color per slot only)
 *   Server -> Client
 *     { type:'playerEquipment', playerId, equipment }   (relayed to every OTHER room member)
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
console.log('[Server] STEP 4 mode (bugfix): Room + Player sync + Monster sync with explicit snapshot requests — no combat sync yet.');

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
  return { members: new Set([hostSocket]), hostSocket, monsters: new Map(), worldTimeOfDay: 0.28 };
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
  // STEP 6: last known level/exp (defaults match a fresh character — real values arrive
  // via 'playerLevelSync' the moment this socket enters a room).
  socket.level = 1; socket.exp = 0;
  // New feature: last known equipment visuals (color per slot only — never full item/stats).
  socket.equipment = { weapon:null, armor:null, helmet:null, accessory:null };

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
          // STEP 6: include each existing member's last known level/exp too, so a late
          // joiner immediately knows the host's (and anyone else's) level without waiting.
          const existingPlayers = [];
          room.members.forEach(memberSocket => existingPlayers.push({
            playerId: memberSocket.playerId,
            x: memberSocket.px, y: memberSocket.py, z: memberSocket.pz,
            rot: memberSocket.prot, anim: memberSocket.panim,
            level: memberSocket.level, exp: memberSocket.exp,
            equipment: memberSocket.equipment, // new feature: existing members' gear visuals
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

          // Day/Night sync (v2 — plain progress fraction, never a wall-clock timestamp):
          // give the new joiner the room's current World Time immediately so they see the
          // correct sky (day or night) right away instead of starting their own clock. A
          // sensible default (0.28) is always set at room creation, so this always has a
          // real value to send, even before the host's first periodic broadcast.
          send(socket, { type:'worldTime', timeOfDay: room.worldTimeOfDay });
          console.log(`[WorldTime] sent timeOfDay=${room.worldTimeOfDay.toFixed(3)} to ${socket.playerId} joining room ${roomId}`);

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

        // Attack animation sync: a one-shot event, not persistent state — nothing is cached
        // room-side (unlike monsters/world time), it's just relayed live to everyone else
        // currently in the SAME room. Never echoed back to the attacker, and a socket not in
        // any room has nowhere valid to relay to, so it's silently ignored (never crashes).
        case 'playerAttack': {
          if(!socket.roomId) break;
          const room = rooms.get(socket.roomId);
          if(!room) break;
          const kind = typeof data.kind === 'string' ? data.kind : 'basic';
          const payload = { type:'playerAttack', playerId: socket.playerId, kind };
          room.members.forEach(memberSocket => { if(memberSocket !== socket) send(memberSocket, payload); });
          console.log(`[PlayerAttack] ${socket.playerId} (${kind}) in room ${socket.roomId}`);
          break;
        }

        // ---------------- STEP 5: MULTIPLAYER COMBAT ----------------
        // Host-authoritative: only the client that actually owns the real monster objects
        // (the room's host) can ever apply damage. A non-host socket's attack is relayed
        // ONLY to that room's host (never broadcast, never trusted to change HP itself) —
        // roomId always comes from the socket's own server-side session, never from the
        // packet, so a player can never target another room's monster (spec section 7).
        case 'monsterAttack': {
          if(!socket.roomId) break; // not in a room — nothing valid to attack
          const room = rooms.get(socket.roomId);
          if(!room) break;
          if(socket === room.hostSocket) break; // the host applies its own attacks locally, never via this path
          if(typeof data.monsterId !== 'string') break;
          const payload = {
            type:'monsterAttack',
            monsterId: data.monsterId,
            attackerId: socket.playerId, // authoritative — from the session, never trust a client-supplied playerId
            attackType: typeof data.attackType === 'string' ? data.attackType : 'basic',
            damage: typeof data.damage === 'number' ? data.damage : 0,
            crit: !!data.crit,
            attackId: typeof data.attackId === 'string' ? data.attackId : undefined,
          };
          send(room.hostSocket, payload);
          console.log(`[COMBAT] Player attack ${socket.playerId} -> monster ${data.monsterId} (room ${socket.roomId})`);
          break;
        }

        // The host confirms a combat result; relay to everyone else in the SAME room only
        // (never cached — like playerAttack, this is a transient event, not persistent state).
        case 'monsterCombatResult': {
          if(!socket.roomId) break;
          const room = rooms.get(socket.roomId);
          if(!room || room.hostSocket !== socket) break; // only the host may confirm combat results
          if(typeof data.monsterId !== 'string') break;
          const payload = {
            type:'monsterCombatResult',
            monsterId: data.monsterId,
            attackerId: typeof data.attackerId === 'string' ? data.attackerId : null,
            damage: typeof data.damage === 'number' ? data.damage : 0,
            crit: !!data.crit,
            hp: typeof data.hp === 'number' ? data.hp : 0,
            maxHp: typeof data.maxHp === 'number' ? data.maxHp : 0,
          };
          room.members.forEach(memberSocket => { if(memberSocket !== socket) send(memberSocket, payload); });
          console.log(`[COMBAT] Combat result monster=${data.monsterId} hp=${payload.hp}/${payload.maxHp} room=${socket.roomId}`);
          break;
        }

        // BUGFIX: a monster targeting a remote player previously had nowhere to send that
        // damage — this routes it directly to that specific player's own socket so THEIR
        // client applies it to their own real HP (only the room's host may send this, same
        // authority check as the other combat messages; targetPlayerId is matched against
        // this room's own members only, so it can never reach another room).
        case 'monsterAttacksPlayer': {
          if(!socket.roomId) break;
          const room = rooms.get(socket.roomId);
          if(!room || room.hostSocket !== socket) break; // only the host's monsters may deal damage
          if(typeof data.targetPlayerId !== 'string') break;
          const targetSocket = Array.from(room.members).find(s => s.playerId === data.targetPlayerId);
          if(!targetSocket) break; // that player isn't (or is no longer) in this room — nothing to do
          const damage = Math.max(1, Math.min(Number(data.damage)||0, 999999));
          send(targetSocket, {
            type:'monsterAttacksPlayer', targetPlayerId: data.targetPlayerId,
            damage, monsterId: data.monsterId, monsterName: typeof data.monsterName==='string' ? data.monsterName : undefined,
          });
          console.log(`[COMBAT] Monster hit ${data.targetPlayerId} for ${damage} (room ${socket.roomId})`);
          break;
        }

        // ---------------- NEW FEATURE: PLAYER vs PLAYER ----------------
        // Each player stays authoritative over their own HP (same principle as the host
        // being authoritative over monster HP): the attacker only sends their own attack
        // power, never a damage number to apply — the VICTIM's own client computes real
        // damage using their own def/crit and applies it to themselves, then confirms back
        // so the attacker sees a number too. targetPlayerId/attackerId are always resolved
        // against this room's own members, so PvP can never cross into another room.
        case 'playerAttackPlayer': {
          if(!socket.roomId) break;
          const room = rooms.get(socket.roomId);
          if(!room) break;
          if(typeof data.targetPlayerId !== 'string') break;
          const targetSocket = Array.from(room.members).find(s => s.playerId === data.targetPlayerId);
          if(!targetSocket || targetSocket === socket) break; // not in this room, or attacking yourself — ignore
          send(targetSocket, {
            type:'playerAttackPlayer', targetPlayerId: data.targetPlayerId, attackerId: socket.playerId,
            attackType: typeof data.attackType==='string' ? data.attackType : 'basic',
            atk: Number(data.atk)||0, critRate: Number(data.critRate)||5, critDmg: Number(data.critDmg)||150,
          });
          console.log(`[PVP] ${socket.playerId} attacked ${data.targetPlayerId} (room ${socket.roomId})`);
          break;
        }
        case 'playerCombatResult': {
          if(!socket.roomId) break;
          const room = rooms.get(socket.roomId);
          if(!room) break;
          if(typeof data.targetPlayerId !== 'string') break; // this is the ORIGINAL ATTACKER's playerId
          const attackerSocket = Array.from(room.members).find(s => s.playerId === data.targetPlayerId);
          if(!attackerSocket) break;
          send(attackerSocket, {
            type:'playerCombatResult', targetPlayerId: data.targetPlayerId,
            attackerId: socket.playerId, // the victim's own id — lets the original attacker know who confirmed
            damage: Math.max(0, Number(data.damage)||0), crit: !!data.crit,
          });
          console.log(`[PVP] Combat result ${socket.playerId} -> ${data.targetPlayerId} dmg=${data.damage} (room ${socket.roomId})`);
          break;
        }

        // ---------------- STEP 6: MULTIPLAYER EXP + LEVEL SYNC ----------------
        // A player's level/exp changed (on room join, or after gaining EXP/leveling up —
        // never every frame, per spec section 7). Stored on the socket itself (same pattern
        // as px/py/pz for position) so a future joiner's playerList snapshot can include it,
        // then relayed live to every OTHER member of the same room.
        case 'playerLevelSync': {
          if(!socket.roomId) break;
          const room = rooms.get(socket.roomId);
          if(!room) break;
          if(typeof data.level === 'number') socket.level = data.level;
          if(typeof data.exp === 'number') socket.exp = data.exp;
          const payload = { type:'playerLevelSync', playerId: socket.playerId, level: socket.level, exp: socket.exp };
          room.members.forEach(memberSocket => { if(memberSocket !== socket) send(memberSocket, payload); });
          console.log(`[EXP] ${socket.playerId} is now Lv.${socket.level} (room ${socket.roomId})`);
          break;
        }

        // New feature: EQUIPMENT VISUAL SYNC. Only color-per-slot is ever sent (no stats,
        // no full item data) — stored on the socket (same pattern as level/exp) so a late
        // joiner's playerList snapshot already shows everyone's current gear.
        case 'playerEquipment': {
          if(!socket.roomId) break;
          const room = rooms.get(socket.roomId);
          if(!room) break;
          if(data.equipment && typeof data.equipment === 'object'){
            const eq = { weapon:null, armor:null, helmet:null, accessory:null };
            for(const slot of ['weapon','armor','helmet','accessory']){
              const it = data.equipment[slot];
              if(it && typeof it.color === 'number') eq[slot] = { color: it.color };
            }
            socket.equipment = eq;
          }
          const payload = { type:'playerEquipment', playerId: socket.playerId, equipment: socket.equipment };
          room.members.forEach(memberSocket => { if(memberSocket !== socket) send(memberSocket, payload); });
          console.log(`[Equip] ${socket.playerId} equipment updated (room ${socket.roomId})`);
          break;
        }

        // Host-authoritative EXP distribution (spec section 3): only the room's host may
        // award EXP, and only to players actually in that same room — a client can never
        // just claim "I killed it, give me EXP" and have the server believe it. Each
        // contributor's own client applies the EXP to itself via gainExp() on receipt
        // (see 'expAward' below) — this server never touches anyone's level/exp math.
        case 'monsterExpAward': {
          if(!socket.roomId) break;
          const room = rooms.get(socket.roomId);
          if(!room || room.hostSocket !== socket) break; // only the host may award EXP
          if(!Array.isArray(data.contributorIds) || typeof data.exp !== 'number') break;
          const exp = Math.max(0, Math.min(data.exp, 1000000)); // sanity cap, same spirit as the combat damage cap
          let awardedTo = 0;
          data.contributorIds.forEach(pid => {
            if(typeof pid !== 'string') return;
            for(const memberSocket of room.members){
              if(memberSocket !== room.hostSocket && memberSocket.playerId === pid){
                send(memberSocket, { type:'expAward', exp });
                awardedTo++;
                break;
              }
            }
          });
          console.log(`[EXP] Monster reward distributed: ${exp} EXP -> ${awardedTo} player(s) in room ${socket.roomId}`);
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

        // Day/Night sync (v2 — plain progress fraction, never a wall-clock timestamp): only
        // the room's host may set World Time (mirrors the monster-sync authority check).
        // Stored per-room so Room A and Room B never share a clock, and relayed to every
        // OTHER member — never echoed back to the host that sent it.
        case 'worldTime': {
          const room = rooms.get(socket.roomId);
          if(!room || room.hostSocket !== socket) break;
          if(typeof data.timeOfDay !== 'number') break; // malformed packet safety
          room.worldTimeOfDay = ((data.timeOfDay % 1) + 1) % 1;
          room.members.forEach(memberSocket => {
            if(memberSocket !== socket) send(memberSocket, { type:'worldTime', timeOfDay: room.worldTimeOfDay });
          });
          console.log(`[WorldTime] timeOfDay=${room.worldTimeOfDay.toFixed(3)} set for room ${socket.roomId}`);
          break;
        }

        // Explicit pull — any room member (usually a joiner) can ask for the current World
        // Time at any moment; always answered from the room's cached value, no host round-trip needed.
        case 'requestWorldTime': {
          const room = rooms.get(socket.roomId);
          if(!room) break;
          send(socket, { type:'worldTime', timeOfDay: room.worldTimeOfDay });
          console.log(`[WorldTime] Request from ${socket.playerId} -> sent timeOfDay=${room.worldTimeOfDay.toFixed(3)}`);
          break;
        }

        // Explicit pull, requested by a joining client right when it's ready to render the
        // answer — independent of the automatic push already sent at join time (which is
        // skipped if the room had 0 monsters at that exact moment). Always answers, even
        // with an empty list, so the client can confirm "0 monsters" rather than guessing.
        case 'requestMonsterSnapshot': {
          const room = rooms.get(socket.roomId);
          const list = room ? Array.from(room.monsters.values()) : [];
          send(socket, { type:'monsterSnapshot', monsters: list });
          console.log(`[MonsterSync] Request snapshot from ${socket.playerId} -> sent ${list.length} monster(s)`);
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
