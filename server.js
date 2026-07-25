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
const REAL_MINUTE_MS = 222; // 20000ms / 90 ≈ 222ms

io.on('connection', (socket) => {
    console.log('✅ Игрок подключился:', socket.id);
    io.emit('queueUpdate', waitingQueue.length);

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
        
        if (!waitingQueue.includes(socket.id) && !isPlayerInMatch(socket.id)) {
            waitingQueue.push(socket.id);
            io.emit('queueUpdate', waitingQueue.length);
        }
        socket.emit('waiting', 'Ожидание соперника...');
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
                            waitingQueue.push(opponentId);
                            io.emit('queueUpdate', waitingQueue.length);
                            opponentSocket.emit('waiting', 'Ищем нового соперника...');
                            matchmake(opponentSocket);
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
        
        // Рандомный буст с разным весом
        const boost = getRandomBoost();
        const oldRating = player.teamRating;
        player.teamRating = Math.min(100, player.teamRating + boost);
        
        socket.emit('updateProfile', player);
        socket.emit('packResult', `📦 +${boost} к рейтингу! (${oldRating} → ${player.teamRating})`);
        io.emit('updateLeaders', getLeaders());
        
        // Бонус редко
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
    // +1: 40%, +2: 30%, +3: 15%, +4: 10%, +5: 5%
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
        timer: null
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
        
        // Запускаем таймер матча
        startMatchTimer(roomId);
    } else {
        delete matches[roomId];
        waitingQueue.push(socket.id);
        socket.emit('waiting', 'Соперник отключился, ищем нового...');
        io.emit('queueUpdate', waitingQueue.length);
    }
}

function startMatchTimer(roomId) {
    const match = matches[roomId];
    if (!match) return;
    
    match.timer = setInterval(() => {
        match.time++;
        
        // Обновляем время
        io.to(roomId).emit('matchTime', { time: match.time });
        
        // Каждую минуту генерируем событие
        if (match.time <= MATCH_DURATION) {
            generateEvent(roomId);
        }
        
        // Матч закончился
        if (match.time >= MATCH_DURATION) {
            finishMatch(roomId);
        }
    }, REAL_MINUTE_MS);
}

function generateEvent(roomId) {
    const match = matches[roomId];
    if (!match) return;
    
    const p1 = players[match.player1];
    const p2 = players[match.player2];
    if (!p1 || !p2) return;
    
    const p1Rating = p1.teamRating - match.redCards1 * 10; // красная снижает шанс
    const p2Rating = p2.teamRating - match.redCards2 * 10;
    const totalRating = Math.max(1, p1Rating + p2Rating);
    
    // Шанс на событие (60% что что-то произойдёт)
    if (Math.random() > 0.60) return;
    
    // Определяем тип события
    const eventRoll = Math.random();
    
    // Красная карточка (5%)
    if (eventRoll < 0.05 && match.redCards1 < 2 && match.redCards2 < 2) {
        const player = Math.random() < 0.5 ? 'player1' : 'player2';
        const playerData = player === 'player1' ? p1 : p2;
        const playerName = playerData.name;
        
        if (player === 'player1') {
            match.redCards1++;
            if (match.redCards1 >= 2) match.redCards1 = 2;
        } else {
            match.redCards2++;
            if (match.redCards2 >= 2) match.redCards2 = 2;
        }
        
        const event = {
            time: match.time,
            text: `🟥 КРАСНАЯ КАРТОЧКА! ${playerName} удалён!`,
            type: 'red'
        };
        match.events.push(event);
        io.to(roomId).emit('matchEvent', event);
        return;
    }
    
    // Жёлтая карточка (10%)
    if (eventRoll < 0.15 && match.yellowCards1 < 3 && match.yellowCards2 < 3) {
        const player = Math.random() < 0.5 ? 'player1' : 'player2';
        const playerData = player === 'player1' ? p1 : p2;
        
        if (player === 'player1') {
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
    
    // Гол (шанс зависит от рейтинга)
    const goalChance = 0.15 + (p1Rating - 50) / 500 + (p2Rating - 50) / 500;
    const finalGoalChance = Math.min(0.40, Math.max(0.05, goalChance));
    
    if (Math.random() < finalGoalChance) {
        // Кто забивает? (с учётом рейтинга и красных)
        const p1Power = Math.max(0, p1Rating - match.redCards1 * 10);
        const p2Power = Math.max(0, p2Rating - match.redCards2 * 10);
        const totalPower = p1Power + p2Power;
        
        let isOffside = false;
        let scorer = '';
        let scorerName = '';
        
        // 20% что гол будет с оффсайда (не засчитывается)
        if (Math.random() < 0.20) {
            isOffside = true;
            const event = {
                time: match.time,
                text: `🚩 Оффсайд! Гол не засчитан!`,
                type: 'offside'
            };
            match.events.push(event);
            io.to(roomId).emit('matchEvent', event);
            return;
        }
        
        // Определяем кто забил
        const roll = Math.random();
        if (roll < p1Power / totalPower) {
            scorer = 'player1';
            scorerName = p1.name;
            match.score1++;
            p1.stars += 2;
        } else {
            scorer = 'player2';
            scorerName = p2.name;
            match.score2++;
            p2.stars += 2;
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
    
    // Обычное событие (удар, момент)
    if (Math.random() < 0.3) {
        const player = Math.random() < 0.5 ? p1 : p2;
        const event = {
            time: match.time,
            text: `💥 ${player.name} создаёт опасный момент!`,
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
        // Победа первого
        stars1 = 15 + Math.floor(Math.random() * 5);
        stars2 = Math.max(0, 5 + Math.floor(Math.random() * 3));
        crystals1 = 3 + Math.floor(Math.random() * 3);
        result = 'p1';
    } else if (match.score2 > match.score1) {
        // Победа второго
        stars2 = 15 + Math.floor(Math.random() * 5);
        stars1 = Math.max(0, 5 + Math.floor(Math.random() * 3));
        crystals2 = 3 + Math.floor(Math.random() * 3);
        result = 'p2';
    } else {
        // Ничья
        stars1 = 3;
        stars2 = 3;
        result = 'draw';
    }
    
    // Применяем изменения
    p1.stars += stars1;
    p1.crystals += crystals1;
    p2.stars += stars2;
    p2.crystals += crystals2;
    
    // Не даём уйти в минус
    p1.stars = Math.max(0, p1.stars);
    p2.stars = Math.max(0, p2.stars);
    
    // Обновляем профили
    io.to(match.player1).emit('updateProfile', p1);
    io.to(match.player2).emit('updateProfile', p2);
    
    // Отправляем результат
    io.to(roomId).emit('matchResult', {
        result,
        score1: match.score1,
        score2: match.score2,
        events: match.events,
        stars1,
        stars2,
        crystals1,
        crystals2
    });
    
    io.emit('updateLeaders', getLeaders());
    
    const roomIdCopy = roomId;
    setTimeout(() => {
        delete matches[roomIdCopy];
        // Возвращаем игроков в очередь
        if (players[match.player1]) {
            waitingQueue.push(match.player1);
            const s1 = io.sockets.sockets.get(match.player1);
            if (s1) {
                s1.emit('waiting', 'Ищем нового соперника...');
                matchmake(s1);
            }
        }
        if (players[match.player2]) {
            waitingQueue.push(match.player2);
            const s2 = io.sockets.sockets.get(match.player2);
            if (s2) {
                s2.emit('waiting', 'Ищем нового соперника...');
                matchmake(s2);
            }
        }
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
