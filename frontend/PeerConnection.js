/**
 * PeerConnection - Handles peer-to-peer connection and synchronization
 * using WebRTC via PeerJS.
 */
import bus from './EventBus.js';

export class PeerConnection {
    /**
     * Creates a new PeerConnection instance and connects to the specified session.
     * @param {string} sessionId - The session ID to connect to
     * @param {Object} localConfig - Local stream configuration to share with peers
     */
    constructor(sessionId, localConfig) {
        this.sessionId = sessionId;
        this.localConfig = localConfig;
        this.peer = null;
        this.connection = null;
        this.peerId = null;
        this._destroying = false;
        this._isHost = false;
        this._pendingConnect = null;
        this._wasConnected = false;
        this.resetVectorClock();
        this.initializePeerConnection();
    }

    /**
     * Resets the vector clock and related state
     * Should be called when initializing a new connection
     */
    resetVectorClock() {
        this.vectorClock = {};
        this.lastAppliedClock = null;
        this.lastAppliedSenderId = null;
        
        // If we have a peerId, initialize our own vector clock entry
        if (this.peerId) {
            this.vectorClock[this.peerId] = 0;
        }
    }

    async initializePeerConnection() {
        // Step 1: Try as guest (random peer ID, connect to session ID)
        await this._tryConnectWithRandomId();
    }

    async _tryConnectWithRandomId() {
        this._isHost = false;
        this._destroying = false;
        console.log('[Peer] Opening with random peer ID');
        this.peer = new Peer(undefined); // random peer id
        this.resetVectorClock();
        let resolved = false;
        let peerOpen;
        try {
            peerOpen = await new Promise((resolve, reject) => {
                this.peer.on('open', (id) => {
                    if (resolved) return;
                    resolved = true;
                    resolve(id);
                });
                this.peer.on('error', (err) => {
                    if (resolved) return;
                    resolved = true;
                    reject(err);
                });
            });
        } catch (err) {
            this._handlePeerError(err);
            return;
        }
        this.peerId = peerOpen;
        this.vectorClock[this.peerId] = 0;
        console.log(`[Peer] Attempting to connect to session peer: ${this.sessionId}`);
        let connectTimeout;
        let conn;
        try {
            conn = this.peer.connect(this.sessionId, {
                reliable: true,
                serialization: 'json'
            });
            await new Promise((resolve, reject) => {
                let done = false;
                connectTimeout = setTimeout(() => {
                    if (!done) {
                        done = true;
                        reject(new Error('Peer connection timeout'));
                    }
                }, 3500);
                conn.on('open', () => {
                    if (!done) {
                        done = true;
                        clearTimeout(connectTimeout);
                        resolve();
                    }
                });
                conn.on('error', (err) => {
                    if (!done) {
                        done = true;
                        clearTimeout(connectTimeout);
                        reject(err);
                    }
                });
                conn.on('close', () => {
                    if (!done) {
                        done = true;
                        clearTimeout(connectTimeout);
                        reject(new Error('Peer connection closed'));
                    }
                });
            });
        } catch (err) {
            clearTimeout(connectTimeout);
            console.log('[Peer] Could not connect to session peer, switching to host mode');
            await this._shutdownPeer();
            await this._tryHostMode();
            return;
        }
        clearTimeout(connectTimeout);
        this.establishConnection(conn, 'client')
    }

    async _tryHostMode() {
        this._isHost = true;
        console.log(`[Peer] Opening as host with peer ID: ${this.sessionId}`);
        this.peer = new Peer(this.sessionId);
        let resolved = false;
        try {
            await new Promise((resolve, reject) => {
                this.peer.on('open', (id) => {
                    if (resolved) return;
                    resolved = true;
                    this.peerId = id;
                    this.resetVectorClock();
                    resolve();
                });
                this.peer.on('error', (err) => {
                    if (resolved) return;
                    resolved = true;
                    // If the error is 'ID is taken', try as client instead
                    if (err && err.message && err.message.includes('is taken')) {
                        console.log(`[Peer] Host ID '${this.sessionId}' is taken, attempting to connect as client.`);
                        this._shutdownPeer().then(() => this._tryConnectWithRandomId());
                        return;
                    }
                    reject(err);
                });
            });
        } catch (err) {
            this._handlePeerError(err);
            return;
        }
        console.log('[Peer] Waiting for incoming connections as host');
        this.peer.on('connection', (conn) => {
            this.establishConnection(conn, 'host');
        });
    }

    /**
     * Called when a connection is fully established as host or client.
     * Sets up the data channel and emits lifecycle events.
     *
     * @param {Peer.DataConnection} conn - The PeerJS connection
     * @param {'host'|'client'} type - Connection role
     */
    establishConnection(conn, type) {
        console.log(`[Peer] Connected to session peer as ${type}`);
        this.connection = conn;
        this._wasConnected = true;
        // Attach close/error handlers for lifecycle events
        conn.on('close', () => {
            if (this._wasConnected && !this._destroying) {
                console.log('[Peer] Connection closed gracefully');
                // Reset connection state
                this.connection = null;
                this._wasConnected = false;
                // Emit disconnection event and let Core.js handle reconnection
                bus.emit('peerDisconnected');
            }
        });
        conn.on('error', (err) => {
            if (this._wasConnected) {
                console.error('[Peer] Connection terminated unexpectedly:', err);
                bus.emit('peerTerminated', err);
            }
        });
        // Data channel setup
        this.setupDataChannel();
        // Immediately send config if connection is already open
        if (conn.open) {
            this.sendConfig();
        } else {
            conn.on('open', () => {
                this.sendConfig();
            });
        }
    }

    async _shutdownPeer() {
        if (this.connection) {
            try { this.connection.close(); } catch (e) {}
            this.connection = null;
        }
        if (this.peer) {
            try { this.peer.destroy(); } catch (e) {}
            this.peer = null;
        }
        // Don't reset peerId here as it's needed for reconnection
    }

    /**
     * Handles PeerJS errors and emits 'peerTerminated' for ungraceful disconnects.
     *
     * @param {Error} err
     */
    _handlePeerError(err) {
        console.error('PeerJS error:', err);
        bus.emit('peerTerminated', err);
    }

    /**
     * Sets up the data channel for an established connection
     * @private
     */
    /**
     * Sets up the data channel for an established connection.
     * Handles only data and command events.
     * Connection open/close/error events are handled in establishConnection.
     * @private
     */
    setupDataChannel() {
        if (!this.connection) return;

        // Clear any pending connection timeout
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }

        this.connection.on('data', (data) => {
            if (data.type === 'config') {
                console.log('[Peer] Received config from peer:', data.config);
                bus.emit('peerConfig', data.config);
            } else if (data.type === 'command') {
                // Concise inbound sync logging
                this._log('IN', data.command);
                this.handleIncomingCommand(data.command);
            }
        });
    }

    /**
     * Sends the local configuration to the connected peer
     * @private
     */
    sendConfig() {
        if (this.connection?.open) {
            console.log('[Peer] Sending config to peer:', this.localConfig);
            this.connection.send({
                type: 'config',
                config: this.localConfig
            });
        } else {
            console.warn('[Peer] Cannot send config: connection not open');
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

            // Concise outbound sync logging
            this._log('OUT', command);

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
        this._destroying = true;
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
     * Helper: Create concise command summary for logging
     * @param {Object} command
     * @returns {string}
     * @private
     */
    _summarizeCommand = (command) => {
        const parts = [command.type];
        
        // Add playhead if present
        if (command.playhead !== undefined) {
            parts.push(`@${command.playhead.toFixed(2)}s`);
        }
        
        // Add track if present (for audioChange)
        if (command.track) {
            parts.push(`track:${command.track}`);
        }
        
        // Add any buffering info
        if (command.videos) {
            parts.push(`videos:${JSON.stringify(command.videos)}`);
        }
        
        return parts.join(' ');
    };

    /**
     * Helper: Unified logger for sync messages
     * @param {"IN"|"OUT"|"WARN"} direction
     * @param {Object|string} detail
     * @private
     */
    _log = (direction, detail) => {
        const msg = typeof detail === 'string' ? detail : this._summarizeCommand(detail);
        
        // Use different symbols for different directions
        let prefix;
        switch (direction) {
            case 'OUT':
                prefix = '🡆 OUT';  // Right arrow for outgoing
                break;
            case 'IN':
                prefix = '🡄 IN';   // Left arrow for incoming
                break;
            case 'WARN':
                prefix = '⚠️ WARN';
                break;
            default:
                prefix = `[${direction}]`;
        }
        
        // Add timestamp
        const logLine = `[${prefix}] ${msg}`;
        
        // Use appropriate console method
        if (direction === 'WARN') {
            console.warn(logLine);
        } else {
            console.log(logLine);
        }
    };

    /**
     * Handles an incoming command, applying timestamp validation
     * @param {Object} command - The command to process
     * @private
     */
    handleIncomingCommand(command) {
        // Ignore commands without vector clocks (all supported peers should include them)
        if (!command.clock) {
            this._log('WARN', 'Ignoring command without vector clock');
            return;
        }

        // Compare clocks to decide if we should apply the command
        if (this.lastAppliedClock) {
            const cmp = this._compareClocks(command.clock, this.lastAppliedClock);
            if (cmp === -1) {
                // Incoming command is causally older; ignore
                this._log('WARN', `Vector clock older command ignored (${this._summarizeCommand(command)})`);
                return;
            }
            if (cmp === 0) {
                // Concurrent – tie-break by senderId
                if (command.senderId > (this.lastAppliedSenderId || '')) {
                    this._log('WARN', `Vector clock concurrent; kept ${this.lastAppliedSenderId} over ${command.senderId} for ${this._summarizeCommand(command)}`);
                    return; // Keep existing state
                }
            }
        }

        // Merge clocks and accept command
        this._mergeClock(command.clock);
        this.lastAppliedClock = { ...command.clock };
        this.lastAppliedSenderId = command.senderId;

        // Map command types to their corresponding event names
        const eventMap = {
            'playIntent': 'remotePlayIntent',
            'playReady': 'remotePlayReady',
            'playNotReady': 'remotePlayNotReady',
            'pauseIntent': 'remotePauseIntent',
            'seekIntent': 'remoteSeekIntent',
            'seekComplete': 'remoteSeekComplete',
            'bufferingStarted': 'remoteBufferingStarted',
            'bufferingComplete': 'remoteBufferingComplete',
            'audioChange': 'remoteAudioChange'
        };
        
        const eventName = eventMap[command.type];
        bus.emit(eventName, command);
    }
}
