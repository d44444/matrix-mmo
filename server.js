const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the client HTML file
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- DATABASE CONNECTION ---
// Render will provide this securely, or it falls back to your local test string
const MONGO_URI = process.env.MONGO_URI || "";
const dbClient = new MongoClient(MONGO_URI);
let playersCollection;

async function connectDB() {
    await dbClient.connect();
    const db = dbClient.db('matrix_mmo');
    playersCollection = db.collection('players');
    console.log("Connected to MongoDB Vault!");
}
connectDB();

// --- IN-MEMORY STATE ---
const players = {}; // We keep this so combat is fast!
const activeRaids = {
    "raid_1": { boss: { name: "Rootkit Overlord", hp: 10000, maxHp: 10000, atk: 50 }, players: [] }
};

// --- COMBAT LOOP ---
setInterval(() => {
    for (let raidId in activeRaids) {
        let raid = activeRaids[raidId];
        if (raid.players.length === 0 || raid.boss.hp <= 0) continue;

        raid.players.forEach(pid => {
            let p = players[pid];
            if (p && p.hp > 0) raid.boss.hp -= p.atk;
        });

        let randomTarget = raid.players[Math.floor(Math.random() * raid.players.length)];
        if (players[randomTarget]) players[randomTarget].hp -= raid.boss.atk;

        io.to(raidId).emit('raidUpdate', { boss: raid.boss, activePlayers: raid.players.length });

        if (raid.boss.hp <= 0) {
            io.to(raidId).emit('chatMessage', 'SYSTEM', `The ${raid.boss.name} has been defeated!`);
            raid.players.forEach(pid => { if (players[pid]) players[pid].shards += 500; });
            raid.boss.hp = raid.boss.maxHp; 
        }
    }
}, 100);

// --- PERIODIC SAVE LOOP ---
// Save everyone to the database every 10 seconds so we don't lose data if the server crashes
setInterval(async () => {
    for (let socketId in players) {
        let p = players[socketId];
        let cleanPlayer = { ...p };
        delete cleanPlayer._id; // Remove database ID to avoid write errors
        await playersCollection.updateOne({ username: p.username }, { $set: cleanPlayer });
    }
}, 10000);

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    console.log(`Connection opened: ${socket.id}`);

    socket.on('login', async (username) => {
        // 1. Look for the player in the database
        let player = await playersCollection.findOne({ username: username });
        
        // 2. If they don't exist, create a new profile and save it to the database
        if (!player) {
            player = {
                username: username,
                hp: 500, maxHp: 500, atk: 15, shards: 100,
                inventory: [{ uid: Math.random().toString(), name: "Common Laser" }]
            };
            await playersCollection.insertOne(player);
        }
        
        // 3. Load them into the active game memory
        players[socket.id] = player;
        socket.join('global_chat');
        
        socket.emit('stateUpdate', players[socket.id]);
        io.emit('chatMessage', 'SYSTEM', `${username} logged in.`);
    });

    socket.on('joinRaid', (raidId) => {
        if (activeRaids[raidId] && !activeRaids[raidId].players.includes(socket.id)) {
            activeRaids[raidId].players.push(socket.id);
            socket.join(raidId);
        }
    });

    socket.on('sendChat', (msg) => {
        if(players[socket.id]) io.to('global_chat').emit('chatMessage', players[socket.id].username, msg);
    });

    // 4. Save to database immediately when they disconnect
    socket.on('disconnect', async () => {
        if (players[socket.id]) {
            let cleanPlayer = { ...players[socket.id] };
            delete cleanPlayer._id;
            await playersCollection.updateOne({ username: cleanPlayer.username }, { $set: cleanPlayer });
            
            activeRaids["raid_1"].players = activeRaids["raid_1"].players.filter(id => id !== socket.id);
            delete players[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });