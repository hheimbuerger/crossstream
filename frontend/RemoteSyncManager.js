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
        // Vector clock for causal ordering
        this.vectorClock = {};
        // Last applied command's vector clock for conflict resolution
        this.lastAppliedClock = null;
        // Local peer ID will be assigned in the `open` callback
        this.peerId = null;
        this.lastAppliedSenderId = null;

        // Initialize PeerJS with default configuration
        this.peer = new Peer(sessionId || null);

        // Handle peer open event
        this.peer.on('open', (id) => {
            console.log('Initialized with peer ID:', id);

            // Save local peer ID and initialize vector clock entry
            this.peerId = id;
            this.vectorClock[id] = 0;

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
            // Attach vector clock and metadata
            command.clock = this._tick();
            command.senderId = this.peerId;
            command.timestamp = Date.now();
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

    /**
     * Helper: Increment local vector clock and return the new clock object
     * @private
     */
    _tick = () => {
        if (!this.peerId) return;
        this.vectorClock[this.peerId] = (this.vectorClock[this.peerId] || 0) + 1;
        return { ...this.vectorClock };
    };

    /**
     * Helper: Merge an incoming vector clock into the local one
     * @param {Object} incomingClock
     * @private
     */
    _mergeClock = (incomingClock) => {
        Object.keys(incomingClock).forEach((pid) => {
            const localVal = this.vectorClock[pid] || 0;
            this.vectorClock[pid] = Math.max(localVal, incomingClock[pid]);
        });
    };

    /**
     * Helper: Compare two clocks
     * @param {Object} a
     * @param {Object} b
     * @returns {number} -1 if a < b, 1 if a > b, 0 if concurrent
     * @private
     */
    _compareClocks = (a, b) => {
        let aBeforeB = false;
        let bBeforeA = false;
        const pids = new Set([...Object.keys(a), ...Object.keys(b)]);
        pids.forEach((pid) => {
            const av = a[pid] || 0;
            const bv = b[pid] || 0;
            if (av < bv) aBeforeB = true;
            if (bv < av) bBeforeA = true;
        });
        if (aBeforeB && !bBeforeA) return -1; // a happens before b
        if (bBeforeA && !aBeforeB) return 1;  // a happens after b
        return 0; // concurrent
    };

    /**
     * Handles an incoming command, applying timestamp validation
     * @param {Object} command - The command to process
     * @private
     */
    handleIncomingCommand(command) {
        // Ignore commands without vector clocks (all supported peers should include them)
        if (!command.clock) {
            console.warn('Ignoring command without vector clock:', command);
            return;
        }

        // Compare clocks to decide if we should apply the command
        if (this.lastAppliedClock) {
            const cmp = this._compareClocks(command.clock, this.lastAppliedClock);
            if (cmp === -1) {
                // Incoming command is causally older; ignore
                return;
            }
            if (cmp === 0) {
                // Concurrent – tie-break by senderId
                if (command.senderId > (this.lastAppliedSenderId || '')) {
                    return; // Keep existing state
                }
            }
        }

        // Merge clocks and accept command
        this._mergeClock(command.clock);
        this.lastAppliedClock = { ...command.clock };
        this.lastAppliedSenderId = command.senderId;

        const eventName = `remote${command.type.charAt(0).toUpperCase()}${command.type.slice(1)}`;
        bus.emit(eventName, command);
    }
}
