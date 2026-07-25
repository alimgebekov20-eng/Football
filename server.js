const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const players = {}; // { socketId: { name, stars, crystals, teamRating } }
const waitingQueue = [];
const matches = {}; // { roomId: { player1, player2, score1, score2, events } }

io.on('connection', (socket) => {
    console.log('✅ Игрок подключился:', socket.id);

    // Обновляем очередь для всех
    io.emit('queueUpdate', waitingQueue.length);

    socket.on('join', (name) => {
        // Если игрок уже есть, обновляем его
        if (players[socket.id]) {
            players[socket.id].name = name || 'Аноним';
        } else {
            players[socket.id] = {
                name: name || 'Аноним',
                stars: 100,
                crystals: 10,
                teamRating: 50
            };
        }
        
        io.emit('updateLeaders', getLeaders());
        socket.emit('updateProfile', players[socket.id]);
        
        // Добавляем в очередь на поиск соперника
        if (!waitingQueue.includes(socket.id)) {
            waitingQueue.push(socket.id);
            io.emit('queueUpdate', waitingQueue.length);
        }
        socket.emit('waiting', 'Ожидание соперника...');
        
        // Пытаемся найти матч
        matchmake(socket);
    });

    socket.on('disconnect', () => {
        console.log('❌ Игрок отключился:', socket.id);
        
        // Удаляем из очереди
        const index = waitingQueue.indexOf(socket.id);
        if (index !== -1) {
            waitingQueue.splice(index, 1);
            io.emit('queueUpdate', waitingQueue.length);
        }
        
        // Удаляем из матчей
        for (const [roomId, match] of Object.entries(matches)) {
            if (match.player1 === socket.id || match.player2 === socket.id) {
                const opponentId = match.player1 === socket.id ? match.player2 : match.player1;
                const opponentSocket = io.sockets.sockets.get(opponentId);
                if (opponentSocket) {
                    opponentSocket.emit('matchEnd', 'Соперник отключился');
                    opponentSocket.emit('join', players[opponentId]?.name || 'Аноним');
                }
                delete matches[roomId];
                break;
            }
        }
        
        delete players[socket.id];
        io.emit('updateLeaders', getLeaders());
        io.emit('queueUpdate', waitingQueue.length);
    });

    socket.on('action', (data) => {
        const { roomId, action } = data;
        const match = matches[roomId];
        if (!match) {
            socket.emit('error', 'Матч не найден');
            return;
        }

        const isPlayer1 = match.player1 === socket.id;
        const isPlayer2 = match.player2 === socket.id;
        if (!isPlayer1 && !isPlayer2) {
            socket.emit('error', 'Вы не в этом матче');
            return;
        }

        const opponentId = isPlayer1 ? match.player2 : match.player1;
        const opponentSocket = io.sockets.sockets.get(opponentId);
        if (opponentSocket) {
            opponentSocket.emit('opponentAction', { action, from: socket.id });
        }

        // Симуляция события
        const event = simulateEvent(action);
        if (event) {
            match.events.push(event);
            io.to(roomId).emit('matchEvent', event);
            
            // Если это гол — обновляем счёт
            if (event.type === 'goal') {
                // Случайно определяем кто забил (50/50)
                const scorer = Math.random() > 0.5 ? 'player1' : 'player2';
                if (scorer === 'player1') {
                    match.score1++;
                    const playerData = players[match.player1];
                    if (playerData) {
                        io.to(match.player1).emit('matchEvent', { 
                            time: event.time, 
                            text: `⚽ ${playerData.name} забил!` 
                        });
                    }
                } else {
                    match.score2++;
                    const playerData = players[match.player2];
                    if (playerData) {
                        io.to(match.player2).emit('matchEvent', { 
                            time: event.time, 
                            text: `⚽ ${playerData.name} забил!` 
                        });
                    }
                }
                io.to(roomId).emit('scoreUpdate', { 
                    score1: match.score1, 
                    score2: match.score2 
                });
            }
        }
    });

    socket.on('endMatch', (roomId) => {
        const match = matches[roomId];
        if (!match) {
            socket.emit('error', 'Матч не найден');
            return;
        }
        
        const p1 = players[match.player1];
        const p2 = players[match.player2];
        if (!p1 || !p2) {
            socket.emit('error', 'Игрок не найден');
            return;
        }

        let result;
        if (match.score1 > match.score2) {
            // Победа первого игрока
            const starsGain = 10 + Math.floor(Math.random() * 5); // 10-14 звёзд
            p1.stars += starsGain;
            p1.crystals += 2 + Math.floor(Math.random() * 3); // 2-4 кристалла
            
            // Второй игрок теряет звёзды
            const starsLoss = 8 + Math.floor(Math.random() * 5); // 8-12 звёзд
            p2.stars = Math.max(0, p2.stars - starsLoss);
            
            result = 'p1';
        } else if (match.score2 > match.score1) {
            // Победа второго игрока
            const starsGain = 10 + Math.floor(Math.random() * 5);
            p2.stars += starsGain;
            p2.crystals += 2 + Math.floor(Math.random() * 3);
            
            const starsLoss = 8 + Math.floor(Math.random() * 5);
            p1.stars = Math.max(0, p1.stars - starsLoss);
            
            result = 'p2';
        } else {
            // Ничья
            p1.stars += 2;
            p2.stars += 2;
            result = 'draw';
        }

        // Уведомляем игроков о результате
        io.to(roomId).emit('matchResult', { 
            result, 
            score1: match.score1, 
            score2: match.score2 
        });
        
        // Обновляем профили
        io.to(match.player1).emit('updateProfile', p1);
        io.to(match.player2).emit('updateProfile', p2);
        
        // Обновляем лидеров
        io.emit('updateLeaders', getLeaders());
        
        // Удаляем матч
        delete matches[roomId];
        
        // Возвращаем игроков в очередь
        setTimeout(() => {
            if (players[match.player1]) {
                waitingQueue.push(match.player1);
                io.to(match.player1).emit('waiting', 'Ищем нового соперника...');
            }
            if (players[match.player2]) {
                waitingQueue.push(match.player2);
                io.to(match.player2).emit('waiting', 'Ищем нового соперника...');
            }
            io.emit('queueUpdate', waitingQueue.length);
            matchmake(io.sockets.sockets.get(match.player1));
            matchmake(io.sockets.sockets.get(match.player2));
        }, 3000);
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
        const boost = Math.floor(Math.random() * 8) + 3; // 3-10 очков рейтинга
        player.teamRating = Math.min(100, player.teamRating + boost);
        
        socket.emit('updateProfile', player);
        socket.emit('packResult', `📦 +${boost} к рейтингу состава! (текущий: ${player.teamRating})`);
        io.emit('updateLeaders', getLeaders());
        
        // Шанс на бонус
        if (Math.random() < 0.15) {
            const bonus = Math.floor(Math.random() * 5) + 1;
            player.stars += bonus;
            socket.emit('packResult', `⭐ Бонус! +${bonus} звёзд!`);
            socket.emit('updateProfile', player);
        }
    });
});

function matchmake(socket) {
    if (!socket) return;
    
    // Если игрок не в очереди или уже в матче — выходим
    if (!waitingQueue.includes(socket.id)) return;
    if (isPlayerInMatch(socket.id)) return;
    
    // Ищем соперника
    const opponentIndex = waitingQueue.findIndex(id => id !== socket.id);
    if (opponentIndex === -1) return;
    
    const opponentId = waitingQueue[opponentIndex];
    
    // Удаляем обоих из очереди
    const socketIndex = waitingQueue.indexOf(socket.id);
    if (socketIndex !== -1) waitingQueue.splice(socketIndex, 1);
    if (opponentIndex !== -1) waitingQueue.splice(opponentIndex > socketIndex ? opponentIndex - 1 : opponentIndex, 1);
    io.emit('queueUpdate', waitingQueue.length);
    
    // Создаём комнату для матча
    const roomId = `room_${socket.id}_${opponentId}`;
    matches[roomId] = {
        player1: socket.id,
        player2: opponentId,
        score1: 0,
        score2: 0,
        events: []
    };
    
    // Добавляем игроков в комнату
    socket.join(roomId);
    const opponentSocket = io.sockets.sockets.get(opponentId);
    if (opponentSocket) {
        opponentSocket.join(roomId);
        
        const p1 = players[socket.id];
        const p2 = players[opponentId];
        
        // Отправляем информацию о начале матча
        io.to(roomId).emit('matchStart', { 
            roomId, 
            opponent: p2.name 
        });
        socket.emit('matchStart', { 
            roomId, 
            opponent: p2.name 
        });
        
        // Отправляем начальные составы
        io.to(roomId).emit('matchEvent', { 
            time: 0, 
            text: `🏟️ Матч начался! ${p1.name} vs ${p2.name}` 
        });
        
        console.log(`⚽ Матч создан: ${p1.name} vs ${p2.name} (${roomId})`);
    } else {
        // Если оппонент отключился — возвращаем игрока в очередь
        delete matches[roomId];
        waitingQueue.push(socket.id);
        socket.emit('waiting', 'Соперник отключился, ищем нового...');
        io.emit('queueUpdate', waitingQueue.length);
    }
}

function isPlayerInMatch(socketId) {
    for (const match of Object.values(matches)) {
        if (match.player1 === socketId || match.player2 === socketId) {
            return true;
        }
    }
    return false;
}

function simulateEvent(action) {
    const events = [];
    
    // Базовые события
    const eventTypes = [
        { type: 'goal', text: '⚽ ГОЛ!', weight: 15 },
        { type: 'goal', text: '⚽ ГОЛ!', weight: 15 },
        { type: 'yellow', text: '🟨 Жёлтая карточка', weight: 10 },
        { type: 'red', text: '🟥 КРАСНАЯ КАРТОЧКА!', weight: 5 },
        { type: 'offside', text: '🚩 Оффсайд', weight: 12 },
        { type: 'penalty', text: '🔴 Пенальти!', weight: 8 },
        { type: 'shot', text: '💥 Удар в створ!', weight: 20 },
        { type: 'shot', text: '💥 Опасный момент!', weight: 15 }
    ];
    
    // Выбираем событие в зависимости от действия
    let selectedEvent = null;
    if (action === 'goal') {
        // При ударе — больше шансов на гол
        selectedEvent = { type: 'goal', text: '⚽ ГОЛ!' };
    } else if (action === 'foul') {
        selectedEvent = { type: 'yellow', text: '🟨 Жёлтая карточка' };
        if (Math.random() < 0.15) {
            selectedEvent = { type: 'red', text: '🟥 КРАСНАЯ КАРТОЧКА!' };
        }
    } else if (action === 'offside') {
        selectedEvent = { type: 'offside', text: '🚩 Оффсайд' };
    } else {
        // Случайное событие
        const totalWeight = eventTypes.reduce((sum, e) => sum + e.weight, 0);
        let random = Math.random() * totalWeight;
        for (const event of eventTypes) {
            random -= event.weight;
            if (random <= 0) {
                selectedEvent = event;
                break;
            }
        }
    }
    
    if (!selectedEvent) return null;
    
    return {
        ...selectedEvent,
        time: Math.floor(Math.random() * 90) + 1
    };
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

// Периодическая очистка неактивных игроков (каждые 5 минут)
setInterval(() => {
    const now = Date.now();
    for (const [id, player] of Object.entries(players)) {
        // Если игрок не активен 10 минут — удаляем
        // (в реальном приложении нужно добавить время последней активности)
    }
}, 300000);

server.listen(3000, () => {
    console.log('⚽ Сервер запущен на http://localhost:3000');
    console.log('📱 Открой на телефоне: http://[твой-IP]:3000');
    console.log('👥 Ожидаем игроков...');
});
