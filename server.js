const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const players = {};
const waitingQueue = [];
const matches = {};

// 90 игровых минут = 20 секунд
const MATCH_DURATION = 90;
const REAL_MINUTE_MS = 222;

io.on('connection', (socket) => {
    console.log('✅ Игрок подключился:', socket.id);
    io.emit('queueUpdate', waitingQueue.length);

    // Загрузка сохранённого профиля
    socket.on('loadProfile', (data) => {
        players[socket.id] = {
            name: data.name || 'Аноним',
            stars: data.stars || 100,
            crystals: data.crystals || 15,
            teamRating: data.teamRating || 50,
            redCards: 0,
            yellowCards: 0
        };
        socket.emit('updateProfile', players[socket.id]);
        io.emit('updateLeaders', getLeaders());
    });

    // Вход в игру
    socket.on('join', (name) => {
        if (players[socket.id]) {
            players[socket.id].name = name || 'Аноним';
        } else {
            players[socket.id] = {
                name: name || 'Аноним',
                stars: 100,
                crystals: 15,
                teamRating: 50,
                redCards: 0,
                yellowCards: 0
            };
        }
        
        io.emit('updateLeaders', getLeaders());
        socket.emit('updateProfile', players[socket.id]);
        socket.emit('waiting', 'Нажми "Найти соперника"');
    });

    // Поиск соперника по кнопке
    socket.on('findMatch', () => {
        if (!players[socket.id]) {
            socket.emit('error', 'Сначала войди в игру');
            return;
        }
        
        if (isPlayerInMatch(socket.id)) {
            socket.emit('error', 'Ты уже в матче');
            return;
        }
        
        if (waitingQueue.includes(socket.id)) {
            socket.emit('waiting', 'Уже в очереди...');
            return;
        }
        
        waitingQueue.push(socket.id);
        io.emit('queueUpdate', waitingQueue.length);
        socket.emit('waiting', 'Поиск соперника...');
        matchmake(socket);
    });

    socket.on('disconnect', () => {
        console.log('❌ Игрок отключился:', socket.id);
        
        const index = waitingQueue.indexOf(socket.id);
        if (index !== -1) {
            waitingQueue.splice(index, 1);
            io.emit('queueUpdate', waitingQueue.length);
        }
        
        for (const [roomId, match] of Object.entries(matches)) {
            if (match.player1 === socket.id || match.player2 === socket.id) {
                const opponentId = match.player1 === socket.id ? match.player2 : match.player1;
                const opponentSocket = io.sockets.sockets.get(opponentId);
                if (opponentSocket) {
                    opponentSocket.emit('matchEnd', 'Соперник отключился');
                    setTimeout(() => {
                        if (players[opponentId]) {
                            opponentSocket.emit('waiting', 'Нажми "Найти соперника"');
                        }
                    }, 2000);
                }
                if (match.timer) clearInterval(match.timer);
                delete matches[roomId];
                break;
            }
        }
        
        delete players[socket.id];
        io.emit('updateLeaders', getLeaders());
        io.emit('queueUpdate', waitingQueue.length);
    });

    socket.on('openPack', () => {
        const player = players[socket.id];
        if (!player) {
            socket.emit('error', 'Игрок не найден');
            return;
        }
        if (player.crystals < 3) {
            socket.emit('error', 'Недостаточно кристаллов! Нужно 3 💎');
            return;
        }
        
        player.crystals -= 3;
        const boost = getRandomBoost();
        const oldRating = player.teamRating;
        player.teamRating = Math.min(100, player.teamRating + boost);
        
        socket.emit('updateProfile', player);
        socket.emit('packResult', `📦 +${boost} к рейтингу! (${oldRating} → ${player.teamRating})`);
        io.emit('updateLeaders', getLeaders());
        
        if (Math.random() < 0.1) {
            const bonus = Math.floor(Math.random() * 3) + 1;
            player.stars += bonus;
            socket.emit('packResult', `⭐ Бонус! +${bonus} звёзд!`);
            socket.emit('updateProfile', player);
        }
    });

    socket.on('endMatch', (roomId) => {
        const match = matches[roomId];
        if (!match) return;
        finishMatch(roomId);
    });
});

function getRandomBoost() {
    const rand = Math.random();
    if (rand < 0.40) return 1;
    if (rand < 0.70) return 2;
    if (rand < 0.85) return 3;
    if (rand < 0.95) return 4;
    return 5;
}

function matchmake(socket) {
    if (!socket) return;
    if (!waitingQueue.includes(socket.id)) return;
    if (isPlayerInMatch(socket.id)) return;
    
    const opponentIndex = waitingQueue.findIndex(id => id !== socket.id);
    if (opponentIndex === -1) return;
    
    const opponentId = waitingQueue[opponentIndex];
    const socketIndex = waitingQueue.indexOf(socket.id);
    
    waitingQueue.splice(socketIndex, 1);
    const oppIndex = waitingQueue.indexOf(opponentId);
    if (oppIndex !== -1) waitingQueue.splice(oppIndex, 1);
    io.emit('queueUpdate', waitingQueue.length);
    
    const roomId = `room_${socket.id}_${opponentId}`;
    
    const p1 = players[socket.id];
    const p2 = players[opponentId];
    
    matches[roomId] = {
        player1: socket.id,
        player2: opponentId,
        score1: 0,
        score2: 0,
        time: 0,
        events: [],
        redCards1: 0,
        redCards2: 0,
        yellowCards1: 0,
        yellowCards2: 0,
        timer: null,
        finished: false
    };
    
    socket.join(roomId);
    const opponentSocket = io.sockets.sockets.get(opponentId);
    if (opponentSocket) {
        opponentSocket.join(roomId);
        
        io.to(roomId).emit('matchStart', { 
            roomId, 
            opponent: p2.name,
            player1: p1.name,
            player2: p2.name,
            rating1: p1.teamRating,
            rating2: p2.teamRating
        });
        
        startMatchTimer(roomId);
    } else {
        delete matches[roomId];
        waitingQueue.push(socket.id);
        socket.emit('waiting', 'Соперник отключился');
        io.emit('queueUpdate', waitingQueue.length);
    }
}

function startMatchTimer(roomId) {
    const match = matches[roomId];
    if (!match) return;
    
    match.timer = setInterval(() => {
        match.time++;
        io.to(roomId).emit('matchTime', { time: match.time });
        
        if (match.time <= MATCH_DURATION) {
            generateEvent(roomId);
        }
        
        if (match.time >= MATCH_DURATION) {
            finishMatch(roomId);
        }
    }, REAL_MINUTE_MS);
}

function generateEvent(roomId) {
    const match = matches[roomId];
    if (!match || match.finished) return;
    
    const p1 = players[match.player1];
    const p2 = players[match.player2];
    if (!p1 || !p2) return;
    
    // Базовый шанс на событие (60%)
    if (Math.random() > 0.60) return;
    
    const p1Rating = p1.teamRating - match.redCards1 * 10;
    const p2Rating = p2.teamRating - match.redCards2 * 10;
    const totalRating = Math.max(1, p1Rating + p2Rating);
    
    const eventRoll = Math.random();
    
    // ===== КРАСНАЯ КАРТОЧКА (ДИНАМИЧЕСКИЙ ШАНС) =====
    const scoreDiff = Math.abs(match.score1 - match.score2);
    const baseRedChance = 0.01 + (scoreDiff * 0.023);
    const redChance = Math.min(0.08, baseRedChance);
    
    let redPlayer = null;
    let redPlayerId = null;
    let redPlayerName = '';
    
    if (match.score1 > match.score2) {
        if (Math.random() < 0.65) {
            redPlayer = 'player2';
            redPlayerId = match.player2;
            redPlayerName = p2.name;
        } else {
            redPlayer = 'player1';
            redPlayerId = match.player1;
            redPlayerName = p1.name;
        }
    } else if (match.score2 > match.score1) {
        if (Math.random() < 0.65) {
            redPlayer = 'player1';
            redPlayerId = match.player1;
            redPlayerName = p1.name;
        } else {
            redPlayer = 'player2';
            redPlayerId = match.player2;
            redPlayerName = p2.name;
        }
    } else {
        if (Math.random() < 0.02) {
            redPlayer = Math.random() < 0.5 ? 'player1' : 'player2';
            redPlayerId = redPlayer === 'player1' ? match.player1 : match.player2;
            redPlayerName = redPlayer === 'player1' ? p1.name : p2.name;
        }
    }
    
    let redCount = 0;
    let maxRed = 2;
    if (redPlayer === 'player1') {
        redCount = match.redCards1;
    } else if (redPlayer === 'player2') {
        redCount = match.redCards2;
    }
    
    if (redPlayer && redCount < maxRed && Math.random() < redChance) {
        if (redPlayer === 'player1') {
            match.redCards1++;
        } else if (redPlayer === 'player2') {
            match.redCards2++;
        }
        
        const event = {
            time: match.time,
            text: `🟥 КРАСНАЯ КАРТОЧКА! ${redPlayerName} удалён! (${match.score1}:${match.score2})`,
            type: 'red'
        };
        match.events.push(event);
        io.to(roomId).emit('matchEvent', event);
        return;
    }
    
    // ===== ЖЁЛТАЯ КАРТОЧКА =====
    const yellowChance = 0.05 + (scoreDiff * 0.02);
    const finalYellowChance = Math.min(0.12, yellowChance);
    
    if (Math.random() < finalYellowChance && match.yellowCards1 < 3 && match.yellowCards2 < 3) {
        let yellowPlayer;
        if (match.score1 > match.score2 && Math.random() < 0.6) {
            yellowPlayer = 'player2';
        } else if (match.score2 > match.score1 && Math.random() < 0.6) {
            yellowPlayer = 'player1';
        } else {
            yellowPlayer = Math.random() < 0.5 ? 'player1' : 'player2';
        }
        
        const playerData = yellowPlayer === 'player1' ? p1 : p2;
        
        if (yellowPlayer === 'player1') {
            match.yellowCards1++;
        } else {
            match.yellowCards2++;
        }
        
        const event = {
            time: match.time,
            text: `🟨 Жёлтая карточка! ${playerData.name}`,
            type: 'yellow'
        };
        match.events.push(event);
        io.to(roomId).emit('matchEvent', event);
        return;
    }
    
    // ===== ГОЛ =====
    const p1Power = Math.max(0, p1Rating - match.redCards1 * 10);
    const p2Power = Math.max(0, p2Rating - match.redCards2 * 10);
    
    let p1GoalBonus = 0;
    let p2GoalBonus = 0;
    if (match.score1 > match.score2) {
        p2GoalBonus = 0.05;
    } else if (match.score2 > match.score1) {
        p1GoalBonus = 0.05;
    }
    
    const p1GoalChance = (p1Power / totalRating) + p1GoalBonus;
    const p2GoalChance = (p2Power / totalRating) + p2GoalBonus;
    const goalChance = 0.15 + (p1GoalChance + p2GoalChance) / 4;
    const finalGoalChance = Math.min(0.40, Math.max(0.08, goalChance));
    
    if (Math.random() < finalGoalChance) {
        if (Math.random() < 0.20) {
            const event = {
                time: match.time,
                text: `🚩 Оффсайд! Гол не засчитан!`,
                type: 'offside'
            };
            match.events.push(event);
            io.to(roomId).emit('matchEvent', event);
            return;
        }
        
        let scorer = '';
        let scorerName = '';
        const roll = Math.random();
        const totalPower = p1Power + p2Power;
        
        if (totalPower === 0) {
            scorer = Math.random() < 0.5 ? 'player1' : 'player2';
        } else if (roll < p1Power / totalPower) {
            scorer = 'player1';
        } else {
            scorer = 'player2';
        }
        
        if (scorer === 'player1') {
            scorerName = p1.name;
            match.score1++;
        } else {
            scorerName = p2.name;
            match.score2++;
        }
        
        const event = {
            time: match.time,
            text: `⚽ ГОЛ! ${scorerName} забивает! (${match.score1}:${match.score2})`,
            type: 'goal',
            scorer: scorerName
        };
        match.events.push(event);
        io.to(roomId).emit('matchEvent', event);
        io.to(roomId).emit('scoreUpdate', { 
            score1: match.score1, 
            score2: match.score2 
        });
        return;
    }
    
    // ===== ОБЫЧНЫЙ МОМЕНТ =====
    if (Math.random() < 0.3) {
        const player = Math.random() < 0.5 ? p1 : p2;
        const event = {
            time: match.time,
            text: `💥 ${player.name} создаёт момент!`,
            type: 'shot'
        };
        match.events.push(event);
        io.to(roomId).emit('matchEvent', event);
    }
}

function finishMatch(roomId) {
    const match = matches[roomId];
    if (!match) return;
    
    if (match.timer) {
        clearInterval(match.timer);
        match.timer = null;
    }
    
    const p1 = players[match.player1];
    const p2 = players[match.player2];
    if (!p1 || !p2) {
        delete matches[roomId];
        return;
    }
    
    let result;
    let stars1 = 0, stars2 = 0;
    let crystals1 = 0, crystals2 = 0;
    
    if (match.score1 > match.score2) {
        stars1 = 15 + Math.floor(Math.random() * 5);
        stars2 = Math.max(0, 5 + Math.floor(Math.random() * 3));
        crystals1 = 3 + Math.floor(Math.random() * 3);
        result = 'p1';
    } else if (match.score2 > match.score1) {
        stars2 = 15 + Math.floor(Math.random() * 5);
        stars1 = Math.max(0, 5 + Math.floor(Math.random() * 3));
        crystals2 = 3 + Math.floor(Math.random() * 3);
        result = 'p2';
    } else {
        stars1 = 3;
        stars2 = 3;
        result = 'draw';
    }
    
    p1.stars += stars1;
    p1.crystals += crystals1;
    p2.stars += stars2;
    p2.crystals += crystals2;
    
    p1.stars = Math.max(0, p1.stars);
    p2.stars = Math.max(0, p2.stars);
    
    // Отправляем правильные результаты каждому игроку
    io.to(match.player1).emit('matchResult', {
        result: result === 'p1' ? 'win' : (result === 'p2' ? 'loss' : 'draw'),
        score1: match.score1,
        score2: match.score2,
        starsGained: stars1,
        crystalsGained: crystals1,
        events: match.events
    });
    
    io.to(match.player2).emit('matchResult', {
        result: result === 'p2' ? 'win' : (result === 'p1' ? 'loss' : 'draw'),
        score1: match.score1,
        score2: match.score2,
        starsGained: stars2,
        crystalsGained: crystals2,
        events: match.events
    });
    
    io.to(match.player1).emit('updateProfile', p1);
    io.to(match.player2).emit('updateProfile', p2);
    
    io.emit('updateLeaders', getLeaders());
    
    const roomIdCopy = roomId;
    setTimeout(() => {
        delete matches[roomIdCopy];
        io.emit('queueUpdate', waitingQueue.length);
    }, 5000);
}

function isPlayerInMatch(socketId) {
    for (const match of Object.values(matches)) {
        if (match.player1 === socketId || match.player2 === socketId) {
            return true;
        }
    }
    return false;
}

function getLeaders() {
    return Object.values(players)
        .sort((a, b) => b.stars - a.stars)
        .slice(0, 10)
        .map(p => ({ 
            name: p.name, 
            stars: p.stars, 
            teamRating: p.teamRating 
        }));
}

server.listen(3000, () => {
    console.log('⚽ Сервер запущен на http://localhost:3000');
    console.log('⏱️ 90 минут = 20 секунд');
});
