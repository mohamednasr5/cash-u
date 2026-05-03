function setupWebSocket(wss) {
  wss.on('connection', (ws, req) => {
    console.log('📱 WebSocket client connected');
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      console.log('📴 WebSocket client disconnected');
    });

    // Send welcome
    ws.send(JSON.stringify({ type: 'connected', message: 'مرحباً بك في نظام إدارة المحافظ' }));
  });
}

function broadcast(wss, data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

module.exports = { setupWebSocket, broadcast };
