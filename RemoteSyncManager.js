// RemoteSyncManager.js - Handles network communication for player synchronization
export class RemoteSyncManager {
    /**
     * Creates a new RemoteSyncManager instance
     * @param {string} sessionId - The session ID to join (optional for host)
     * @param {Function} onRemoteConfig - Callback when remote config is received
     * @param {Object} localConfig - The local stream configuration
     * @param {Object} remoteConfig - The remote stream configuration
     */
    constructor(sessionId, onRemoteConfig, localConfig, remoteConfig) {
        if (!localConfig?.stream) {
            throw new Error('Local stream configuration is required');
        }
        if (!remoteConfig?.stream) {
            throw new Error('Remote stream configuration is required');
        }
        
        // Configure PeerJS settings
        this.peerConfig = {
            debug: 1,  // not so verbose?
            // debug: 3,  // Enable verbose logging
        };
        
        this.sessionId = sessionId || `session-${Math.random().toString(36).substr(2, 8)}`;
        this.onRemoteConfig = onRemoteConfig;
        this.localConfig = localConfig;
        this.remoteConfig = remoteConfig;
        this.connection = null;
        this.peer = null;
        this.isConnected = false;
        this.isHost = false;
        this.connectionTimeout = 10000; // 10 seconds
        
        // Clean up on page unload
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', () => this.disconnect());
            window.addEventListener('unload', () => this.disconnect());
        }
    }

    /**
     * Initializes the connection as a host
     * @returns {Promise<string>} The peer ID of the host
     */
    async connectAsHost() {
        await this.disconnect();
        this.isHost = true;
        
        return new Promise((resolve, reject) => {
            console.log('Creating host peer with ID:', this.sessionId);
            
            this.peer = new Peer(this.sessionId, this.peerConfig);
            
            const connectionTimeout = setTimeout(() => {
                this.disconnect().finally(() => {
                    reject(new Error('Connection to PeerJS server timed out'));
                });
            }, this.connectionTimeout);

            this.peer.on('open', (id) => {
                clearTimeout(connectionTimeout);
                console.log('Host peer connected with ID:', id);
                this.isConnected = true;
                this.#setupHostHandlers();
                console.log('Host setup complete');
                resolve(id);
            });

            this.peer.on('error', (err) => {
                clearTimeout(connectionTimeout);
                this.disconnect().finally(() => reject(err));
            });

            this.peer.on('disconnected', () => {
                console.log('Peer disconnected, trying to reconnect...');
                this.peer.reconnect();
            });
        });
    }

    /**
     * Connects to a host as a client
     * @returns {Promise<void>}
     */
    async connectAsClient() {
        // Clean up any existing connection
        // await this.disconnect();
        this.isHost = false;
        
        return new Promise((resolve, reject) => {
            // Generate a random peer ID for the client
            const clientId = `client-${Math.random().toString(36).substr(2, 4)}`;
            this.peer = new Peer(clientId);
            
            this.peer.on('open', (id) => {
                console.log('Client peer ID:', id);
                console.log('Connecting to session:', this.sessionId);
                
                this.connection = this.peer.connect(this.sessionId);
                
                // Set up client-specific handlers
                this.#setupClientHandlers();
                
                // Set up connection open handler
                this.connection.on('open', () => {
                    console.log('Client: Connection to host established');
                    this.isConnected = true;
                    
                    // Send our config to the host
                    console.log('Client: Sending config to host');
                    this.sendConfig();
                    
                    resolve();
                });
                
                // Set up error handler for the connection
                this.connection.on('error', (err) => {
                    this.isConnected = false;
                    reject(err);
                });
            });
            
            this.peer.on('error', (err) => {
                this.isConnected = false;
                reject(err);
            });
        });
    }

    /**
     * Sends the local stream config to the remote peer
     */
    sendConfig() {
        if (!this.isConnected) {
            console.warn('Cannot send stream config: Not connected to peer');
            return;
        }
        console.log('Sending stream config to peer:', this.localConfig);
        this.connection.send({ type: 'config', data: this.localConfig });
    }

    /**
     * Sends the current player state to the remote peer
     * @param {Object} state - The state to send
     */
    sendState(state) {
        if (!this.isConnected) {
            console.warn('Cannot send state: Not connected to peer');
            return;
        }
        this.connection.send({ type: 'state', data: state });
    }

    /**
     * Closes the connection and cleans up resources
     * @returns {Promise<void>}
     */
    async disconnect() {
        // Close data connection
        if (this.connection) {
            try {
                console.log('Closing data connection');
                this.connection.off('data', this.#handleIncomingData);
                this.connection.off('open');
                this.connection.off('close');
                this.connection.off('error');
                this.connection.close();
            } catch (e) {
                console.error('Error closing connection:', e);
            } finally {
                this.connection = null;
            }
        }
        
        // Close peer connection
        if (this.peer) {
            try {
                console.log('Destroying peer connection');
                this.peer.off('open');
                this.peer.off('error');
                this.peer.off('connection');
                this.peer.off('disconnected');
                this.peer.destroy();
                this.peer = null;
                console.log('Peer connection destroyed');
            } catch (e) {
                console.error('Error destroying peer:', e);
            }
        }
        
        this.isConnected = false;
        this.isHost = false;
    }

    // Private methods
    #setupCommonConnectionHandlers(conn) {
        // Common event handlers for any connection
        // Note: We don't set up data handler here to avoid duplicates
        
        conn.on('close', () => {
            console.log('Connection closed');
            this.connection = null;
            this.isConnected = false;
        });
        
        conn.on('error', (err) => {
            console.error('Connection error:', err);
            this.connection = null;
            this.isConnected = false;
        });
        
        return conn;
    }
    
    /**
     * Sets up event handlers for the host peer.
     * Listens for incoming client connections and handles the connection lifecycle.
     * When a client connects, it sets up common connection handlers and sends the host's stream config.
     * @private
     */
    #setupHostHandlers() {
        try {
            this.peer.on('connection', (conn) => {
                console.log('Host: New connection from peer');
                
                // Disconnect any existing connection
                if (this.connection) {
                    console.log('Host: Already have a connection, disconnecting previous one');
                    this.connection.close();
                }
                
                this.connection = conn;
                
                // Set up common handlers
                this.#setupCommonConnectionHandlers(conn);
                
                // Set up connection handlers
                conn.on('open', () => {
                    console.log('Host: Connection established with client');
                    this.isConnected = true;
                    
                    // Call connected handler if provided
                    if (this.onConnect && typeof this.onConnect === 'function') {
                        this.onConnect();
                    }
                    
                    // Send our config to the client
                    console.log('Host: Sending config to client');
                    this.sendConfig();
                });
                
                conn.on('error', (error) => {
                    console.error('Host connection error:', error);
                    this.isConnected = false;
                    if (this.onError && typeof this.onError === 'function') {
                        this.onError(error);
                    }
                });
                
                conn.on('close', () => {
                    console.log('Host: Client disconnected');
                    this.isConnected = false;
                    if (this.onDisconnect && typeof this.onDisconnect === 'function') {
                        this.onDisconnect();
                    }
                });
                
                // Set up data handler - only set it up once
                conn.off('data'); // Remove any existing handler first
                conn.on('data', (data) => {
                    try {
                        this.#handleIncomingData(data);
                    } catch (error) {
                        console.error('Error handling incoming data:', error);
                        if (this.onError && typeof this.onError === 'function') {
                            this.onError(error);
                        }
                    }
                });
            });
            
            this.peer.on('error', (error) => {
                console.error('Peer error in host mode:', error);
                this.isConnected = false;
                if (this.onError && typeof this.onError === 'function') {
                    this.onError(error);
                }
            });
            
            console.log('Host handlers set up successfully');
            
        } catch (error) {
            console.error('Failed to set up host handlers:', error);
            this.isConnected = false;
            throw error;
        }
    }
    
    /**
     * Sets up event handlers for the client peer.
     * Configures the connection to the host and handles the connection lifecycle.
     * Sends the client's stream config to the host once the connection is established.
     * @private
     * @throws {Error} If there is no active connection to set up handlers for
     */
    #setupClientHandlers() {
        if (!this.connection) {
            const error = new Error('No active connection to set up client handlers');
            console.error(error);
            throw error;
        }
        
        try {
            // Set up common handlers (without data handler)
            this.#setupCommonConnectionHandlers(this.connection);
            
            // Set up error handler for the connection
            this.connection.on('error', (error) => {
                console.error('Connection error in client handlers:', error);
                this.isConnected = false;
                if (this.onError && typeof this.onError === 'function') {
                    this.onError(error);
                }
            });
            
            // Set up close handler
            this.connection.on('close', () => {
                console.log('Connection closed');
                this.isConnected = false;
                if (this.onDisconnect && typeof this.onDisconnect === 'function') {
                    this.onDisconnect();
                }
            });
            
            // Set up data handler - only set it up once here
            this.connection.off('data'); // Remove any existing handler first
            this.connection.on('data', (data) => {
                try {
                    this.#handleIncomingData(data);
                } catch (error) {
                    console.error('Error handling incoming data:', error);
                    if (this.onError && typeof this.onError === 'function') {
                        this.onError(error);
                    }
                }
            });
            
            console.log('Client handlers set up successfully');
            
        } catch (error) {
            console.error('Failed to set up client handlers:', error);
            this.isConnected = false;
            throw error;
        }
    }

    #handleIncomingData(data) {
        if (!data || !data.type) return;
        
        switch (data.type) {
            case 'config':
                console.log('Received remote config:', data.data);
                if (typeof this.onRemoteConfig === 'function') {
                    this.onRemoteConfig(data.data);
                }
                break;
                
            case 'state':
                console.log('Received remote state:', data.data);
                this.onRemoteState?.(data.data);
                break;
                
            default:
                console.warn('Unknown message type:', data.type);
        }
    }
    
    /**
     * Sets the callback for remote state updates
     * @param {Function} callback - The callback function
     */
    onRemoteState(callback) {
        this.onRemoteState = callback;
    }
}

// Export for ES modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RemoteSyncManager;
}
