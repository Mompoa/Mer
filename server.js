const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const FOOD_COUNT = 320;
const VIRUS_COUNT = 10;
const TICK_RATE = 50;
const MAX_BLOBS = 64;

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return Math.random() * (max - min) + min; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function hsl(h, s, l) { return `hsl(${h},${s}%,${l}%)`; }
function randColor() { return hsl(randInt(0, 360), randInt(60, 90), randInt(45, 65)); }
function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[randInt(0, chars.length - 1)];
  return code;
}

let nextId = 1;
function genId() { return nextId++; }
function massToRadius(mass) { return Math.sqrt(mass / Math.PI); }
function totalMass(player) { return player.blobs.reduce((s, b) => s + Math.PI * b.r * b.r, 0); }

// ===== ROOMS =====
const rooms = new Map();

function spawnFoodItem(mapWidth, mapHeight) {
  return {
    id: genId(),
    x: randFloat(20, mapWidth - 20),
    y: randFloat(20, mapHeight - 20),
    r: 4,
    color: randColor(),
  };
}

function createRoom(code, roomName, maxPlayers) {
  const MAP_WIDTH = 1500, MAP_HEIGHT = 1500;
  const food = new Map();
  const viruses = new Map();
  for (let i = 0; i < FOOD_COUNT; i++) {
    const f = spawnFoodItem(MAP_WIDTH, MAP_HEIGHT);
    food.set(f.id, f);
  }
  for (let i = 0; i < VIRUS_COUNT; i++) {
    const id = genId();
    viruses.set(id, { id, x: randFloat(100, MAP_WIDTH-100), y: randFloat(100, MAP_HEIGHT-100), r: 35 });
  }
  const room = {
    code,
    name: roomName || "Public Room",
    maxPlayers: maxPlayers || 30,
    mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT,
    players: new Map(),
    food, viruses,
    created: Date.now(),
    isPublic: code === "PUBLIC",
  };
  rooms.set(code, room);
  return room;
}

// Create default public room
createRoom("PUBLIC", "Public Room", 30);

function getRoomList() {
  const list = [];
  for (const [code, room] of rooms) {
    list.push({
      code: room.code,
      name: room.name,
      players: room.players.size,
      maxPlayers: room.maxPlayers,
      isPublic: room.isPublic,
    });
  }
  return list;
}

function broadcastRoomList() {
  const list = getRoomList();
  const msg = JSON.stringify({ type: "roomList", rooms: list });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcastRoom(room, data) {
  const msg = JSON.stringify(data);
  for (const p of room.players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function sendWs(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function createPlayer(ws, name, room) {
  const id = genId();
  const player = {
    id, ws,
    name: (name || "Player").slice(0, 16),
    color: randColor(),
    room,
    blobs: [{
      id: genId(),
      x: randFloat(200, room.mapWidth - 200),
      y: randFloat(200, room.mapHeight - 200),
      r: 30, vx: 0, vy: 0, mergeTimer: 0,
    }],
    score: 0, alive: true,
    targetX: null, targetY: null,
    splitCooldown: 0, ejectCooldown: 0,
    isMoving: false,
  };
  room.players.set(id, player);
  return player;
}

function ejectMass(player) {
  if (player.ejectCooldown > 0 || player.targetX === null) return;
  player.ejectCooldown = 3;
  player.blobs.forEach(blob => {
    if (blob.r < 25) return;
    const dx = player.targetX - blob.x, dy = player.targetY - blob.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx/len, ny = dy/len;
    const ejectR = 7;
    blob.r = massToRadius(Math.PI * blob.r * blob.r - Math.PI * ejectR * ejectR);
    const ejId = genId();
    player.room.food.set(ejId, {
      id: ejId,
      x: blob.x + nx*(blob.r+ejectR+2), y: blob.y + ny*(blob.r+ejectR+2),
      r: ejectR, color: player.color,
      vx: nx*35, vy: ny*35, life: 60,
    });
  });
}

function splitPlayer(player) {
  if (player.splitCooldown > 0 || player.blobs.length >= MAX_BLOBS || player.targetX === null) return;
  player.splitCooldown = 10;
  [...player.blobs].filter(b => b.r > 20).forEach(blob => {
    if (player.blobs.length >= MAX_BLOBS) return;
    const dx = player.targetX - blob.x, dy = player.targetY - blob.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx/len, ny = dy/len;
    const half = (Math.PI * blob.r * blob.r) / 2;
    blob.r = massToRadius(half);
    player.blobs.push({ id: genId(), x: blob.x+nx*blob.r, y: blob.y+ny*blob.r, r: blob.r, vx: nx*20, vy: ny*20, mergeTimer: 200 });
  });
}

// ===== HTTP =====
const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, "client.html"), (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on("connection", ws => {
  let player = null;

  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "getRoomList") {
      sendWs(ws, { type: "roomList", rooms: getRoomList() });
      return;
    }

    if (msg.type === "createRoom") {
      let code; do { code = genRoomCode(); } while (rooms.has(code));
      const roomName = (msg.name || "Custom Room").slice(0, 24);
      const maxP = Math.min(30, Math.max(2, parseInt(msg.maxPlayers) || 30));
      const room = createRoom(code, roomName, maxP);
      sendWs(ws, { type: "roomCreated", code, name: room.name, maxPlayers: room.maxPlayers });
      broadcastRoomList();
      return;
    }

    if (msg.type === "join") {
      let room;
      const code = (msg.room || "").toString().toUpperCase().trim();
      if (code && rooms.has(code)) {
        room = rooms.get(code);
      } else {
        room = rooms.get("PUBLIC");
      }
      // Check max players
      if (room.players.size >= room.maxPlayers) {
        sendWs(ws, { type: "roomFull" });
        return;
      }
      player = createPlayer(ws, msg.name, room);
      sendWs(ws, { type: "init", id: player.id, mapWidth: room.mapWidth, mapHeight: room.mapHeight, roomCode: room.code, roomName: room.name });
      broadcastRoom(room, { type: "playerJoined", id: player.id, name: player.name, color: player.color });
      broadcastRoom(room, { type: "chat", tab: "game", sender: "SERVER", color: "#00ffe7", text: `${player.name} joined!`, ts: Date.now() });
      broadcastRoomList();
      return;
    }

    if (!player) return;

    if (msg.type === "move") { player.targetX = msg.x; player.targetY = msg.y; player.isMoving = true; }
    if (msg.type === "stop") { player.isMoving = false; }
    if (msg.type === "split") splitPlayer(player);
    if (msg.type === "eject") ejectMass(player);
    if (msg.type === "ping") sendWs(ws, { type: "pong" });
    if (msg.type === "chat") {
      const text = (msg.text || "").toString().trim().slice(0, 120);
      if (!text.length) return;
      broadcastRoom(player.room, { type: "chat", tab: "all", sender: player.name, color: player.color, text, ts: Date.now() });
    }
  });

  ws.on("close", () => {
    if (!player) return;
    const room = player.room;
    broadcastRoom(room, { type: "chat", tab: "game", sender: "SERVER", color: "#ff6666", text: `${player.name} left.`, ts: Date.now() });
    room.players.delete(player.id);
    broadcastRoom(room, { type: "playerLeft", id: player.id });
    if (room.code !== "PUBLIC" && room.players.size === 0) rooms.delete(room.code);
    broadcastRoomList();
  });
});

// ===== GAME TICK =====
setInterval(() => {
  for (const [code, room] of rooms) {
    const { players, food, viruses, mapWidth, mapHeight } = room;
    if (players.size === 0) continue;

    for (const [fid, f] of food) {
      if (f.vx !== undefined) {
        f.x += f.vx; f.y += f.vy; f.vx *= 0.88; f.vy *= 0.88;
        if (f.life !== undefined) { f.life--; if (f.life <= 0) { delete f.vx; delete f.vy; delete f.life; } }
        f.x = Math.max(f.r, Math.min(mapWidth-f.r, f.x));
        f.y = Math.max(f.r, Math.min(mapHeight-f.r, f.y));
      }
    }

    for (const [pid, player] of players) {
      if (!player.alive) continue;
      if (player.splitCooldown > 0) player.splitCooldown--;
      if (player.ejectCooldown > 0) player.ejectCooldown--;

      player.blobs.forEach(blob => {
        if (player.isMoving && player.targetX !== null) {
          const dx = player.targetX - blob.x, dy = player.targetY - blob.y;
          const len = Math.hypot(dx, dy) || 1;
          const speed = Math.max(1.5, 6.5 - blob.r * 0.03);
          if (len > 5) {
            blob.vx = (blob.vx||0)*0.75 + (dx/len)*speed*0.25;
            blob.vy = (blob.vy||0)*0.75 + (dy/len)*speed*0.25;
          } else {
            blob.vx = (blob.vx||0)*0.75;
            blob.vy = (blob.vy||0)*0.75;
          }
        } else {
          blob.vx = (blob.vx||0)*0.75;
          blob.vy = (blob.vy||0)*0.75;
          if (Math.abs(blob.vx) < 0.05) blob.vx = 0;
          if (Math.abs(blob.vy) < 0.05) blob.vy = 0;
        }
        blob.x += blob.vx||0; blob.y += blob.vy||0;
        blob.x = Math.max(blob.r, Math.min(mapWidth-blob.r, blob.x));
        blob.y = Math.max(blob.r, Math.min(mapHeight-blob.r, blob.y));
        if (blob.mergeTimer > 0) blob.mergeTimer--;
      });

      const blobs = player.blobs;
      if (blobs.length > 1) {
        for (let i = 0; i < blobs.length; i++) {
          for (let j = i+1; j < blobs.length; j++) {
            const a = blobs[i], b = blobs[j];
            const d = dist(a, b);
            if (a.mergeTimer > 0 || b.mergeTimer > 0) {
              const minD = a.r + b.r;
              if (d < minD && d > 0.01) {
                const ov = minD - d, nx = (b.x-a.x)/d, ny = (b.y-a.y)/d, push = ov*0.5;
                a.x -= nx*push; a.y -= ny*push; b.x += nx*push; b.y += ny*push;
                a.x = Math.max(a.r, Math.min(mapWidth-a.r, a.x)); a.y = Math.max(a.r, Math.min(mapHeight-a.r, a.y));
                b.x = Math.max(b.r, Math.min(mapWidth-b.r, b.x)); b.y = Math.max(b.r, Math.min(mapHeight-b.r, b.y));
              }
              continue;
            }
            if (d < Math.max(a.r, b.r)) {
              const mA = Math.PI*a.r*a.r, mB = Math.PI*b.r*b.r;
              a.r = massToRadius(mA+mB);
              a.x = (a.x*mA+b.x*mB)/(mA+mB); a.y = (a.y*mA+b.y*mB)/(mA+mB);
              blobs.splice(j,1); j--;
            }
          }
        }
      }

      for (const [fid, f] of food) {
        for (const blob of blobs) {
          if (dist(blob,f) < blob.r) {
            blob.r = massToRadius(Math.PI*blob.r*blob.r + Math.PI*f.r*f.r);
            player.score += f.r;
            food.delete(fid);
            const nf = spawnFoodItem(mapWidth, mapHeight);
            food.set(nf.id, nf);
            break;
          }
        }
      }

      for (const [vid, virus] of viruses) {
        for (const blob of blobs) {
          if (blob.r > virus.r*1.1 && dist(blob,virus) < blob.r) {
            const rem = (Math.PI*blob.r*blob.r)/2;
            blob.r = massToRadius(rem);
            const pieces = Math.min(MAX_BLOBS - blobs.length + 1, 8);
            if (pieces > 1) {
              const pm = rem/pieces; blob.r = massToRadius(pm);
              for (let p=1; p<pieces; p++) {
                const angle = (p/pieces)*Math.PI*2;
                blobs.push({ id:genId(), x:blob.x+Math.cos(angle)*blob.r, y:blob.y+Math.sin(angle)*blob.r, r:blob.r, vx:Math.cos(angle)*15, vy:Math.sin(angle)*15, mergeTimer:200 });
              }
            }
            player.score = totalMass(player)/100;
          }
        }
      }

      for (const [eid, enemy] of players) {
        if (eid===pid||!enemy.alive) continue;
        for (let i=0; i<blobs.length; i++) {
          const mb = blobs[i];
          for (let j=enemy.blobs.length-1; j>=0; j--) {
            const tb = enemy.blobs[j];
            if (mb.r > tb.r*1.1 && dist(mb,tb) < mb.r*0.85) {
              mb.r = massToRadius(Math.PI*mb.r*mb.r + Math.PI*tb.r*tb.r);
              player.score += tb.r*2;
              enemy.blobs.splice(j,1);
              if (enemy.blobs.length===0) {
                enemy.alive = false;
                sendWs(enemy.ws, { type:"dead", score:Math.floor(enemy.score) });
                players.delete(eid);
                broadcastRoom(room, { type:"chat", tab:"game", sender:"SERVER", color:"#ffaa00", text:`${player.name} ate ${enemy.name}!`, ts:Date.now() });
              }
            }
          }
        }
      }

      player.score = totalMass(player)/100;
    }

    const playersArr = [...players.values()].filter(p=>p.alive).map(p=>({ id:p.id, name:p.name, color:p.color, blobs:p.blobs.map(b=>({id:b.id,x:b.x,y:b.y,r:b.r})), score:Math.floor(p.score) }));
    const foodArr = [...food.values()].map(f=>({id:f.id,x:f.x,y:f.y,r:f.r,color:f.color}));
    const virusArr = [...viruses.values()].map(v=>({id:v.id,x:v.x,y:v.y,r:v.r}));
    const lb = [...players.values()].sort((a,b)=>b.score-a.score).slice(0,10).map(p=>({name:p.name,score:Math.floor(p.score),color:p.color}));
    const stateMsg = JSON.stringify({ type:"state", players:playersArr, food:foodArr, viruses:virusArr, leaderboard:lb });
    for (const p of players.values()) { if (p.ws.readyState===WebSocket.OPEN) p.ws.send(stateMsg); }
  }
}, TICK_RATE);

server.listen(PORT, () => console.log(`🌐 Nebulous on http://localhost:${PORT}`));
