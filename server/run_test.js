const { spawn } = require('child_process');
const io = require('socket.io-client');

// Start the server
const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: '4011' }
});

server.stdout.on('data', (data) => {
  // console.log(`[server]: ${data}`);
});

server.stderr.on('data', (data) => {
  // console.error(`[server err]: ${data}`);
});

// Wait 1.5 seconds for server to start, then run client code
setTimeout(() => {
  console.log("Connecting clients...");
  const socketA = io('http://localhost:4011');
  const socketB = io('http://localhost:4011');

  socketA.on('connect', () => {
    console.log('Client A connected');
    socketA.emit('create_room', { name: 'HostTest' });
  });

  socketA.on('room_created', (data) => {
    console.log('Client A created room:', data);
    // After A creates the room, let client B list rooms
    setTimeout(() => {
      socketB.emit('list_rooms');
    }, 500);
  });

  socketB.on('connect', () => {
    console.log('Client B connected');
  });

  socketB.on('rooms_list', (rooms) => {
    console.log('Client B received rooms_list:', JSON.stringify(rooms));
    // Check if any room has hostName === 'HostTest'
    const containsRoom = rooms.some(r => r.hostName === 'HostTest');
    console.log('RESULT_CONTAINS_ROOM:', containsRoom);
    
    // Disconnect clients and stop server
    socketA.disconnect();
    socketB.disconnect();
    server.kill();
    process.exit(0);
  });

  // Timeout safety
  setTimeout(() => {
    console.log('Timeout reached, cleaning up...');
    socketA.disconnect();
    socketB.disconnect();
    server.kill();
    process.exit(1);
  }, 10000);

}, 1500);
