import { io, Socket } from 'socket.io-client';

let _socket: Socket | null = null;
let _pendingUsername = '';

export function setSocketUsername(name: string): void {
  _pendingUsername = name;
  if (_socket && _socket.connected) {
    _socket.emit('set_name', { name });
  }
}

export function getSocket(): Socket {
  if (!_socket) {
    _socket = io({
      path: '/socket.io',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    _socket.on('connect', () => {
      if (_pendingUsername) {
        _socket!.emit('set_name', { name: _pendingUsername });
      }
    });
  }
  // Never recreate a socket that already exists — even if temporarily
  // disconnected, socket.io will reconnect automatically and keep all
  // registered event listeners intact.
  return _socket;
}

export function disconnectSocket(): void {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
}
