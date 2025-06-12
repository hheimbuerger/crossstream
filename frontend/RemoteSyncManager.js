/**
 * RemoteSyncManager - Handles peer-to-peer connection and synchronization
 * using WebRTC via PeerJS.
 */
import bus from './EventBus.js';

export class RemoteSyncManager {
    /**
     * Creates a new RemoteSyncManager instance and connects to the specified session.
     * @param {string} sessionId - The session ID to connect to
     * @param {Object} localConfig - Local stream configuration to share with peers
     * @param {number} [maxCommandAge=2000] - Maximum age of commands to process (in milliseconds)
     */
    constructor(sessionId, localConfig, maxCommandAge = 2000) {
        this.sessionId = sessionId;
        this.localConfig = localConfig;
        this.peer = null;
        this.connection = null;
        this.maxCommandAge = maxCommandAge;
        
        // Initialize PeerJS with default configuration
        this.peer = new Peer(sessionId || null);

        // Handle peer open event
        this.peer.on('open', (id) => {
            console.log('Initialized with peer ID:', id);
            
            // Try to connect to the session
            if (!this.sessionId) {
                console.log('Attempting to connect to session:', 'crossstream-dev');
                this.connection = this.peer.connect('crossstream-dev', {
                    reliable: true,
                    serialization: 'json'
                });
            }
            
            this.setupDataChannel();
        });

        // Handle errors
        this.peer.on('error', (err) => {
            console.error('PeerJS error:', err);
            bus.emit('syncError', err);
        });

        // Handle incoming connections (for when another peer joins)
        this.peer.on('connection', (conn) => {
            console.log('Incoming connection from:', conn.peer);
            this.connection = conn;
            this.setupDataChannel();
            
            // Emit connection event for any interested components
            bus.emit('peerConnected', { peerId: conn.peer });
        });
    }

    /**
     * Sets up the data channel for an established connection
     * @private
     */
    setupDataChannel() {
        if (!this.connection) return;
        
        // Clear any pending connection timeout
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        
        this.connection.on('open', () => {
            console.log('Connection to peer established');
            // Clear the timeout since we have a successful connection
            if (this.connectionTimeout) {
                clearTimeout(this.connectionTimeout);
                this.connectionTimeout = null;
            }
            // Send our config to the remote peer
            this.sendConfig();
        });
        
        this.connection.on('data', (data) => {
            if (data.type === 'config') {
                console.log('Received config from peer:', data.config);
                bus.emit('peerConfig', data.config);
            } else if (data.type === 'command') {
                console.log('Received command from peer:', data.command);
                this.handleIncomingCommand(data.command);
            }
        });
        
        this.connection.on('close', () => {
            console.log('Connection to peer closed');
            if (this.connectionTimeout) {
                clearTimeout(this.connectionTimeout);
                this.connectionTimeout = null;
            }
            bus.emit('peerDisconnected');
        });
        
        this.connection.on('error', (err) => {
            console.error('Connection error:', err);
            if (this.connectionTimeout) {
                clearTimeout(this.connectionTimeout);
                this.connectionTimeout = null;
            }
            bus.emit('syncError', err);
        });
    }

    /**
     * Sends the local configuration to the connected peer
     * @private
     */
    sendConfig() {
        if (this.connection?.open) {
            this.connection.send({
                type: 'config',
                config: this.localConfig
            });
        }
    }

    /**
     * Sends a command to the connected peer
     * @param {Object} command - The command to send
     */
    sendCommand(command) {
        if (this.connection?.open) {
            this.connection.send({
                type: 'command',
                command: command
            });
        } else {
            console.warn('Cannot send command: No active connection');
        }
    }

    /**
     * Disconnects from the peer and cleans up resources
     */
    /**
     * Handles an incoming command, applying timestamp validation
     * @param {Object} command - The command to process
     * @private
     */
    handleIncomingCommand(command) {
        // Add timestamp if not present (for backward compatibility)
        if (command.timestamp === undefined) {
            command.timestamp = Date.now();
        }

        // Check if command is too old
        const commandAge = Date.now() - command.timestamp;
        if (commandAge > this.maxCommandAge) {
            console.log(`Ignoring stale command (${commandAge}ms old):`, command.type || 'unknown');
            return;
        }

        // Emit the validated command via the event bus
        bus.emit('remoteCommand', command);
    }

    /**
     * Disconnects from the peer and cleans up resources
     */
    disconnect() {
        if (this.connection) {
            this.connection.close();
            this.connection = null;
        }
        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }
    }
}
