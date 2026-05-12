const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 创建HTTP服务器
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'client.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading client.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url.match(/\.(jpg|jpeg|png|gif)$/)) {
        // 处理图片文件请求
        const imagePath = path.join(__dirname, req.url);
        const ext = path.extname(req.url).toLowerCase();
        const contentType = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif'
        }[ext] || 'application/octet-stream';
        
        fs.readFile(imagePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Image not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// 游戏状态管理
class GameManager {
    constructor() {
        this.players = new Map(); // 存储玩家连接
        this.waitingPlayer = null; // 等待中的玩家
        this.games = new Map(); // 活跃的游戏
        this.playerIdCounter = 0;
    }

    // 生成玩家ID
    generatePlayerId() {
        return `player_${++this.playerIdCounter}`;
    }

    // 添加玩家
    addPlayer(ws) {
        const playerId = this.generatePlayerId();
        const player = {
            id: playerId,
            ws: ws,
            choice: null,
            score: 0,
            status: 'waiting' // waiting, playing, finished
        };
        this.players.set(ws, player);
        return player;
    }

    // 移除玩家
    removePlayer(ws) {
        const player = this.players.get(ws);
        if (!player) return;

        // 如果该玩家正在等待，清除等待状态
        if (this.waitingPlayer === ws) {
            this.waitingPlayer = null;
        }

        // 查找并结束该玩家的游戏
        this.games.forEach((game, gameId) => {
            if (game.player1.ws === ws || game.player2.ws === ws) {
                const opponent = game.player1.ws === ws ? game.player2 : game.player1;
                this.sendToPlayer(opponent.ws, {
                    type: 'opponent_disconnected',
                    message: '对手已断开连接'
                });
                this.games.delete(gameId);
            }
        });

        this.players.delete(ws);
    }

    // 匹配玩家
    matchPlayers(player) {
        if (this.waitingPlayer && this.waitingPlayer !== player.ws) {
            const player1 = this.players.get(this.waitingPlayer);
            const player2 = player;

            // 创建游戏房间
            const gameId = `game_${Date.now()}`;
            const game = {
                id: gameId,
                player1: player1,
                player2: player2,
                round: 0,
                maxRounds: 5,
                choices: {},
                ready: new Set()
            };

            this.games.set(gameId, game);
            this.waitingPlayer = null;

            // 更新玩家状态
            player1.status = 'playing';
            player2.status = 'playing';

            // 通知双方游戏开始
            this.sendToPlayer(player1.ws, {
                type: 'game_start',
                gameId: gameId,
                opponent: { id: player2.id, score: player2.score },
                round: game.round,
                maxRounds: game.maxRounds
            });

            this.sendToPlayer(player2.ws, {
                type: 'game_start',
                gameId: gameId,
                opponent: { id: player1.id, score: player1.score },
                round: game.round,
                maxRounds: game.maxRounds
            });

            return true;
        } else {
            this.waitingPlayer = player.ws;
            this.sendToPlayer(player.ws, {
                type: 'waiting',
                message: '等待对手加入...'
            });
            return false;
        }
    }

    // 处理玩家选择
    handleChoice(ws, choice) {
        const player = this.players.get(ws);
        if (!player) return;

        // 查找该玩家的游戏
        let currentGame = null;
        this.games.forEach((game) => {
            if (game.player1.ws === ws || game.player2.ws === ws) {
                currentGame = game;
            }
        });

        if (!currentGame) {
            this.sendToPlayer(ws, {
                type: 'error',
                message: '未找到游戏'
            });
            return;
        }

        // 记录选择
        currentGame.choices[player.id] = choice;

        // 检查是否双方都做出了选择
        const player1Choice = currentGame.choices[currentGame.player1.id];
        const player2Choice = currentGame.choices[currentGame.player2.id];

        if (player1Choice && player2Choice) {
            this.resolveRound(currentGame);
        }
    }

    // 解决回合
    resolveRound(game) {
        const player1Choice = game.choices[game.player1.id];
        const player2Choice = game.choices[game.player2.id];

        // 判断胜负
        const result = this.determineWinner(player1Choice, player2Choice);
        
        // 更新分数
        if (result === 'player1') {
            game.player1.score++;
        } else if (result === 'player2') {
            game.player2.score++;
        }

        game.round++;

        // 准备结果
        const roundResult = {
            type: 'round_result',
            round: game.round,
            maxRounds: game.maxRounds,
            player1: {
                id: game.player1.id,
                choice: player1Choice,
                score: game.player1.score
            },
            player2: {
                id: game.player2.id,
                choice: player2Choice,
                score: game.player2.score
            },
            winner: result === 'player1' ? game.player1.id : 
                   result === 'player2' ? game.player2.id : 'draw'
        };

        // 发送结果给双方
        this.sendToPlayer(game.player1.ws, roundResult);
        this.sendToPlayer(game.player2.ws, roundResult);

        // 检查游戏是否结束
        if (game.round >= game.maxRounds) {
            this.endGame(game);
        } else {
            // 清除本回合选择，准备下一回合
            game.choices = {};
        }
    }

    // 判断胜负
    determineWinner(choice1, choice2) {
        if (choice1 === choice2) return 'draw';
        
        const rules = {
            'rock': 'scissors',
            'scissors': 'paper',
            'paper': 'rock'
        };

        if (rules[choice1] === choice2) return 'player1';
        return 'player2';
    }

    // 结束游戏
    endGame(game) {
        let gameResult;
        if (game.player1.score > game.player2.score) {
            gameResult = game.player1.id;
        } else if (game.player2.score > game.player1.score) {
            gameResult = game.player2.id;
        } else {
            gameResult = 'draw';
        }

        const endGameMessage = {
            type: 'game_over',
            winner: gameResult,
            player1: {
                id: game.player1.id,
                score: game.player1.score
            },
            player2: {
                id: game.player2.id,
                score: game.player2.score
            }
        };

        this.sendToPlayer(game.player1.ws, endGameMessage);
        this.sendToPlayer(game.player2.ws, endGameMessage);

        // 重置玩家状态
        game.player1.status = 'waiting';
        game.player1.score = 0;
        game.player1.choice = null;
        
        game.player2.status = 'waiting';
        game.player2.score = 0;
        game.player2.choice = null;

        // 删除游戏
        this.games.delete(game.id);
    }

    // 发送消息给指定玩家
    sendToPlayer(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }
}

const gameManager = new GameManager();

// WebSocket连接处理
wss.on('connection', (ws) => {
    console.log('新玩家连接');
    
    const player = gameManager.addPlayer(ws);
    
    // 发送玩家ID
    gameManager.sendToPlayer(ws, {
        type: 'connected',
        playerId: player.id
    });

    // 尝试匹配
    gameManager.matchPlayers(player);

    // 处理消息
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'make_choice':
                    gameManager.handleChoice(ws, data.choice);
                    break;
                    
                case 'play_again':
                    const player = gameManager.players.get(ws);
                    if (player) {
                        player.status = 'waiting';
                        gameManager.matchPlayers(player);
                    }
                    break;
                    
                default:
                    console.log('未知消息类型:', data.type);
            }
        } catch (error) {
            console.error('处理消息错误:', error);
        }
    });

    // 处理断开连接
    ws.on('close', () => {
        console.log('玩家断开连接');
        gameManager.removePlayer(ws);
    });

    // 处理错误
    ws.on('error', (error) => {
        console.error('WebSocket错误:', error);
        gameManager.removePlayer(ws);
    });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`猜拳游戏服务器运行在端口 ${PORT}`);
    console.log(`在浏览器中打开 http://localhost:${PORT}`);
});