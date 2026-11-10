
const net = require('node:net');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !CHANNEL_ID) {
  console.error('Missing environment variables:');
  console.error('DISCORD_CLIENT_ID');
  console.error('DISCORD_CLIENT_SECRET');
  console.error('DISCORD_CHANNEL_ID');
  process.exit(1);
}

let socket;
let buffer = Buffer.alloc(0);
let connected = false;
let authenticated = false;
let authorizeNonce = null;

function sendPacket(opcode, data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(8);

  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(payload.length, 4);

  socket.write(Buffer.concat([header, payload]));
}

function sendCommand(cmd, args = {}, evt) {
  const nonce = `${Date.now()}-${Math.random()}`;

  const packet = { cmd, args, nonce };

  if (evt) packet.evt = evt;

  sendPacket(1, packet);
  return nonce;
}

async function exchangeCode(code) {
  const response = await fetch(
    'https://discord.com/api/oauth2/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:42813/callback',
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description ||
      data.error ||
      `HTTP ${response.status}`
    );
  }

  return data;
}

async function handleMessage(message) {
  if (message.evt === 'READY') {
    console.log('\nRPC handshake successful!');
    console.log('Discord user:', message.data?.user?.username);

    authorizeNonce = sendCommand('AUTHORIZE', {
      client_id: CLIENT_ID,
      scopes: ['rpc', 'identify', 'messages.read']
    });

    console.log('Authorization request sent.');
    console.log('Check Discord for the authorization prompt.');
    return;
  }

  if (message.evt === 'ERROR') {
    console.error('\nDiscord RPC error:');
    console.error('Code:', message.data?.code);
    console.error('Message:', message.data?.message);
    return;
  }

  if (message.cmd === 'AUTHORIZE') {
    if (message.nonce !== authorizeNonce) return;

    const code = message.data?.code;

    if (!code) {
      console.error('No authorization code received.');
      return;
    }

    console.log('\nAuthorization accepted.');
    console.log('Exchanging authorization code...');

    try {
      const token = await exchangeCode(code);

      if (!token.access_token) {
        throw new Error('No access token returned.');
      }

      console.log('Token exchange successful.');

      sendCommand('AUTHENTICATE', {
        access_token: token.access_token
      });
    } catch (error) {
      console.error('Token exchange failed:', error.message);
    }

    return;
  }

  if (message.cmd === 'AUTHENTICATE') {
    const scopes = message.data?.scopes || [];

    console.log('\nRPC authentication response received.');
    console.log('Authorized scopes:', scopes.join(', '));

    if (!scopes.includes('messages.read')) {
      console.error('messages.read was not granted.');
      return;
    }

    authenticated = true;

    console.log('\nAuthentication successful!');
    console.log('Subscribing to channel:', CHANNEL_ID);

    sendCommand(
      'SUBSCRIBE',
      { channel_id: CHANNEL_ID },
      'MESSAGE_CREATE'
    );

    return;
  }

  if (message.cmd === 'SUBSCRIBE') {
    console.log('\nSubscription response received.');
    console.log('Event:', message.data?.evt || 'MESSAGE_CREATE');
    console.log('Listening for messages...');
    return;
  }

  if (message.evt === 'MESSAGE_CREATE') {
    if (!authenticated) return;

    const data = message.data;
    const msg = data?.message;

    if (data?.channel_id !== CHANNEL_ID || !msg) return;

    console.log('\n--------------------------------');
    console.log('New Discord message!');
    console.log('Author:', msg.author?.username);
    console.log('Bot:', msg.author?.bot ?? false);
    console.log('Content:', msg.content);
    console.log('Channel:', data.channel_id);
    console.log('--------------------------------');
  }
}

function connect(index = 0) {
  if (index > 9) {
    console.error('Could not find Discord RPC.');
    console.error('Make sure Discord desktop is running.');
    process.exit(1);
  }

  const pipe = `\\\\?\\pipe\\discord-ipc-${index}`;

  console.log(`Trying Discord pipe ${index}...`);

  const candidate = net.createConnection(pipe);

  candidate.once('connect', () => {
    socket = candidate;
    connected = true;

    console.log('Connected to Discord IPC.');

    sendPacket(0, {
      v: 1,
      client_id: CLIENT_ID
    });
  });

  candidate.on('error', error => {
    if (!connected) {
      candidate.destroy();
      connect(index + 1);
    } else {
      console.error('RPC socket error:', error.message);
    }
  });

  candidate.on('close', () => {
    connected = false;
    authenticated = false;
    console.log('Discord RPC connection closed.');
  });

  candidate.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 8) {
      const opcode = buffer.readUInt32LE(0);
      const length = buffer.readUInt32LE(4);

      if (buffer.length < 8 + length) break;

      const payload = buffer.subarray(8, 8 + length);
      buffer = buffer.subarray(8 + length);

      if (opcode === 1) {
        try {
          const message = JSON.parse(payload.toString('utf8'));

          void handleMessage(message).catch(error => {
            console.error('Handler error:', error.message);
          });
        } catch (error) {
          console.error('RPC parsing error:', error.message);
        }
      }

      if (opcode === 3) {
        const pong = Buffer.alloc(8 + length);
        pong.writeUInt32LE(4, 0);
        pong.writeUInt32LE(length, 4);
        payload.copy(pong, 8);
        socket.write(pong);
      }

      if (opcode === 2) {
        candidate.destroy();
        break;
      }
    }
  });
}

console.log('================================');
console.log('       Wookie RPC Listener');
console.log('================================');
console.log('Application ID:', CLIENT_ID);
console.log('Target channel:', CHANNEL_ID);

connect();
