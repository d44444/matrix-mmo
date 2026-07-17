const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the client HTML file
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- IN-MEMORY DATABASE (Prototype) ---
const players = {};
const activeTrades = {};
const guilds = {
    "g_1": { id: "g_1", name: "The Grid Runners", vault: 0, level: 1 }
};
const activeRaids = {
    "raid_1": {
        boss: { name: "Rootkit Overlord", hp: 10000, maxHp: 10000, atk: 50 },
        players: [] // Array of socket IDs
    }
};

// --- GAME LOOP (Runs at 10 ticks per second for MMO performance) ---
setInterval(() => {
    for (let raidId in activeRaids) {
        let raid = activeRaids[raidId];
        if (raid.players.length === 0 || raid.boss.hp <= 0) continue;

        raid.players.forEach(pid => {
            let p = players[pid];
            if (p && p.hp > 0) raid.boss.hp -= p.atk;
        });

        let randomTarget = raid.players[Math.floor(Math.random() * raid.players.length)];
        if (players[randomTarget]) {
            players[randomTarget].hp -= raid.boss.atk;
        }

        io.to(raidId).emit('raidUpdate', { boss: raid.boss, activePlayers: raid.players.length });

        if (raid.boss.hp <= 0) {
            io.to(raidId).emit('chatMessage', 'SYSTEM', `The ${raid.boss.name} has been defeated! Shards awarded.`);
            raid.players.forEach(pid => { if (players[pid]) players[pid].shards += 500; });
            raid.boss.hp = raid.boss.maxHp; 
        }
    }
}, 100);

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    players[socket.id] = {
        id: socket.id,
        name: `Hacker_${socket.id.substring(0, 4)}`,
        hp: 500, maxHp: 500, atk: 15,
        shards: 100,
        inventory: [
            { uid: Math.random().toString(), name: "Common Laser", type: "weapon" },
            { uid: Math.random().toString(), name: "Rare Shield", type: "shield" }
        ],
        guildId: "g_1"
    };

    socket.join('global_chat');
    socket.join("g_1"); 
    
    socket.emit('stateUpdate', players[socket.id]);
    io.emit('chatMessage', 'SYSTEM', `${players[socket.id].name} jacked into the matrix.`);

    socket.on('sendChat', (msg) => {
        io.to('global_chat').emit('chatMessage', players[socket.id].name, msg);
    });

    socket.on('donateToGuild', (amount) => {
        let p = players[socket.id];
        let g = guilds[p.guildId];
        if (p.shards >= amount) {
            p.shards -= amount;
            g.vault += amount;
            io.to(p.guildId).emit('chatMessage', 'GUILD', `${p.name} donated ${amount} shards. Vault: ${g.vault}`);
            socket.emit('stateUpdate', p);
        }
    });

    socket.on('joinRaid', (raidId) => {
        if (activeRaids[raidId] && !activeRaids[raidId].players.includes(socket.id)) {
            activeRaids[raidId].players.push(socket.id);
            socket.join(raidId);
            io.to(raidId).emit('chatMessage', 'RAID', `${players[socket.id].name} joined the raid!`);
        }
    });

    socket.on('startTrade', (targetId, myItemUid) => {
        let p = players[socket.id];
        let item = p.inventory.find(i => i.uid === myItemUid);
        if (!item || !players[targetId]) return;

        let tradeId = socket.id + "_" + targetId;
        activeTrades[tradeId] = {
            sender: socket.id, senderItem: item, senderLocked: false,
            receiver: targetId, receiverItem: null, receiverLocked: false,
            status: 'PENDING'
        };
        
        io.to(targetId).emit('tradeRequest', tradeId, p.name, item);
    });

    socket.on('offerTradeItem', (tradeId, itemUid) => {
        let trade = activeTrades[tradeId];
        if (!trade) return;
        let item = players[socket.id].inventory.find(i => i.uid === itemUid);
        if (item) {
            trade.receiverItem = item;
            io.to(trade.sender).emit('tradeUpdated', trade);
        }
    });

    socket.on('lockTrade', (tradeId) => {
        let trade = activeTrades[tradeId];
        if (!trade) return;

        if (socket.id === trade.sender) trade.senderLocked = true;
        if (socket.id === trade.receiver) trade.receiverLocked = true;

        if (trade.senderLocked && trade.receiverLocked) {
            let senderP = players[trade.sender];
            let receiverP = players[trade.receiver];

            senderP.inventory = senderP.inventory.filter(i => i.uid !== trade.senderItem.uid);
            receiverP.inventory = receiverP.inventory.filter(i => i.uid !== trade.receiverItem.uid);
            
            senderP.inventory.push(trade.receiverItem);
            receiverP.inventory.push(trade.senderItem);

            io.to(trade.sender).emit('stateUpdate', senderP);
            io.to(trade.receiver).emit('stateUpdate', receiverP);
            io.to(trade.sender).emit('chatMessage', 'SYSTEM', 'Trade successful.');
            io.to(trade.receiver).emit('chatMessage', 'SYSTEM', 'Trade successful.');
            
            delete activeTrades[tradeId];
        }
    });

    socket.on('disconnect', () => {
        activeRaids["raid_1"].players = activeRaids["raid_1"].players.filter(id => id !== socket.id);
        delete players[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Matrix MMO Server running on port ${PORT}`);
});