const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 9090;
const server = app.listen(PORT, () => {
    console.log(`Servidor de Exemplo iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

// Função para gerar um código de sala simples
function generateRoomCode(length = 5) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// Sistema de playerlist baseado no seu projeto
const playerlist = {
    players: [],
    
    getAll: function() {
        return this.players;
    },
    
    get: function(uuid) {
        return this.players.find(player => player.uuid === uuid);
    },
    
    add: function(uuid, roomCode) {
        let player = {
            uuid,
            room: roomCode,
            x: 620,
            y: 300,
        };
        this.players.push(player);
        return player;
    },
    
    update: function(uuid, newX, newY) {
        const player = this.get(uuid);
        if (player) {
            player.x = newX;
            player.y = newY;
        }
    },
    
    remove: function(uuid) {
        this.players = this.players.filter(player => player.uuid !== uuid);
    },
    
    getByRoom: function(roomCode) {
        return this.players.filter(player => player.room === roomCode);
    }
};

wss.on("connection", (socket) => {
    const uuid = uuidv4();
    socket.uuid = uuid;
    console.log(`Cliente conectado: ${uuid}`);

    // Envia o UUID para o novo cliente
    socket.send(JSON.stringify({ 
        cmd: "joined_server", 
        content: { uuid: uuid } 
    }));

    socket.on("message", (message) => {
        let data;
        try { 
            data = JSON.parse(message.toString()); 
        } catch (err) { 
            console.error("Erro ao parsear mensagem:", err);
            return; 
        }

        switch (data.cmd) {
            case "create_room": {
                const newRoomId = generateRoomCode();
                socket.roomId = newRoomId;
                rooms.set(newRoomId, { players: {} });
                rooms.get(newRoomId).players[uuid] = socket;
                
                // Adiciona à playerlist
                const newPlayer = playerlist.add(uuid, newRoomId);
                
                console.log(`Sala ${newRoomId} criada pelo jogador ${uuid}`);
                
                // Resposta para o criador da sala
                socket.send(JSON.stringify({ 
                    cmd: "room_created", 
                    content: { code: newRoomId } 
                }));
                
                // Spawn do jogador local
                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: newPlayer }
                }));
                break;
            }
            
            case "join_room": {
                const roomToJoin = rooms.get(data.content.code.toUpperCase());
                if (!roomToJoin) {
                    socket.send(JSON.stringify({ 
                        cmd: "error", 
                        content: { msg: "Sala não encontrada." } 
                    }));
                    return;
                }
                
                socket.roomId = data.content.code.toUpperCase();
                roomToJoin.players[uuid] = socket;
                
                // Adiciona à playerlist
                const newPlayer = playerlist.add(uuid, socket.roomId);
                
                console.log(`Jogador ${uuid} entrou na sala ${socket.roomId}`);
                
                // Avisa o novo jogador que ele entrou
                socket.send(JSON.stringify({ 
                    cmd: "room_joined", 
                    content: { code: socket.roomId } 
                }));
                
                // Spawn do jogador local para o novo jogador
                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: newPlayer }
                }));
                
                // Envia todos os jogadores da sala para o novo jogador
                const roomPlayers = playerlist.getByRoom(socket.roomId)
                    .filter(p => p.uuid !== uuid);
                
                socket.send(JSON.stringify({
                    cmd: "spawn_network_players",
                    content: { players: roomPlayers }
                }));
                
                // Avisa os outros jogadores que um novo jogador entrou
                for (const clientUuid in roomToJoin.players) {
                    const client = roomToJoin.players[clientUuid];
                    if (client !== socket && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ 
                            cmd: "spawn_new_player", 
                            content: { player: newPlayer } 
                        }));
                    }
                }
                break;
            }
            
            case "position": {
                playerlist.update(uuid, data.content.x, data.content.y);
                
                const room = rooms.get(socket.roomId);
                if (room) {
                    for (const clientUuid in room.players) {
                        const client = room.players[clientUuid];
                        if (client !== socket && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                cmd: "update_position",
                                content: {
                                    uuid: uuid,
                                    x: data.content.x,
                                    y: data.content.y
                                }
                            }));
                        }
                    }
                }
                break;
            }
            
            case "chat": {
                const room = rooms.get(socket.roomId);
                if (room) {
                    for (const clientUuid in room.players) {
                        const client = room.players[clientUuid];
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                cmd: "new_chat_message",
                                content: {
                                    uuid: uuid,
                                    msg: data.content.msg
                                }
                            }));
                        }
                    }
                }
                break;
            }
        }
    });

    socket.on("close", () => {
        console.log(`Cliente desconectado: ${uuid}`);
        
        // Remove da playerlist
        playerlist.remove(uuid);
        
        const room = rooms.get(socket.roomId);
        if (room) {
            delete room.players[uuid];
            
            // Avisa os outros jogadores
            for (const clientUuid in room.players) {
                const client = room.players[clientUuid];
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ 
                        cmd: "player_disconnected", 
                        content: { uuid: uuid } 
                    }));
                }
            }
            
            if (Object.keys(room.players).length === 0) {
                rooms.delete(socket.roomId);
                console.log(`Sala ${socket.roomId} vazia e removida.`);
            }
        }
    });
});