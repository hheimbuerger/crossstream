// Main entry point for the CrossStream player
// Uses a modular architecture with three main components:
// 1. VideoPlayer - Handles local video playback and UI
// 2. PlayerSynchronizer - Manages sync between local videos
// 3. RemoteSyncManager - Handles network communication

// Import our modules
import { VideoPlayer } from './VideoPlayer.js';
import { PlayerSynchronizer } from './PlayerSynchronizer.js';
import { RemoteSyncManager } from './RemoteSyncManager.js';

// --- Constants and globals ---
const urlParams = new URLSearchParams(window.location.search);
const SESSION_ID = urlParams.get('session'); // Optional for both host and client

// Global instances
let videoPlayer;
let playerSynchronizer;
let remoteSyncManager;
let localStreamConfig;

/**
 * Initialize the application with the given parameters
 * @param {boolean} isHost - Whether this is a host session
 * @param {string} [sessionId] - Optional session ID for client connections
 * @returns {Promise<void>}
 */
async function initializeSession(isHost, sessionId) {
    try {
        // Show video UI and set up event listeners
        showVideoUI(true);
        console.log(`Initializing ${isHost ? 'host' : 'client'} session`);
        
        // Initialize video player with local config
        videoPlayer = new VideoPlayer(localStreamConfig, isHost);
        
        // Initialize player synchronizer with local config
        playerSynchronizer = new PlayerSynchronizer(videoPlayer, localStreamConfig);
        
        // For now, just store the session ID and isHost flag
        // We'll initialize the remote sync manager when we have the remote config
        this.pendingSessionId = sessionId;
        this.isHost = isHost;
        
        if (isHost) {
            console.log('Hosting new session with ID:', remoteSyncManager.sessionId);
        } else {
            console.log('Joining session with ID:', sessionId);
        }
        
        // Start the appropriate connection
        if (isHost) {
            await startAsHost();
        } else {
            await startAsClient();
        }
        
        console.log(`${isHost ? 'Host' : 'Client'} session started successfully`);
    } catch (error) {
        console.error(`Error initializing ${isHost ? 'host' : 'client'} session:`, error);
        throw error;
    }
}

// Load configuration from server
// Throws an error if configuration cannot be loaded
async function loadConfig() {
    const response = await fetch('/config');
    if (!response.ok) {
        throw new Error(`Failed to load configuration: HTTP ${response.status}`);
    }
    const config = await response.json();
    
    return config;
}

// Start as host
async function startAsHost() {
    console.log('Starting as host');
    
    try {
        // Connect as host with local config
        await remoteSyncManager.connectAsHost(localStreamConfig);
        
        // Host starts with the left video
        videoPlayer.loadVideo('left-video', localStreamConfig.stream);
        
        // Start synchronization
        playerSynchronizer.startSync();
        
        // Update UI to show we're the host
        document.querySelector('.videoContainer').classList.add('host');
        document.querySelector('.videoContainer').classList.remove('client');
    } catch (error) {
        console.error('Failed to start as host:', error);
        throw error;
    }
}

// Start as client
async function startAsClient() {
    console.log('Starting as client');
    
    if (!SESSION_ID) {
        throw new Error('No session ID provided in URL. Please join using a valid session link.');
    }
    
    console.log('Connecting to session:', SESSION_ID);
    
    try {
        // Connect as client with local config
        await remoteSyncManager.connectAsClient(localStreamConfig);
        
        // Client starts with the right video
        videoPlayer.loadVideo('right-video', localStreamConfig.stream);
        
        // Start synchronization
        playerSynchronizer.startSync();
        
        // Update UI to show we're the client
        document.querySelector('.videoContainer').classList.remove('host');
        document.querySelector('.videoContainer').classList.add('client');
    } catch (error) {
        console.error('Failed to start as client:', error);
        throw error;
    }
}

// Handle remote configuration
function handleRemoteConfig(remoteConfig) {
    console.log('Handling remote config:', remoteConfig);
    
    // Load the other video
    const otherVideoId = videoPlayer.isHost ? 'right-video' : 'left-video';
    videoPlayer.loadVideo(otherVideoId, remoteConfig.stream);
    
    // Calculate and set the time offset
    const localTimestamp = new Date(localStreamConfig.timestamp).getTime();
    const remoteTimestamp = new Date(remoteConfig.timestamp).getTime();
    const timeOffset = (remoteTimestamp - localTimestamp) / 1000; // in seconds
    playerSynchronizer.setRightToLeftOffset(timeOffset);
    
    // Now that we have both configs, initialize the remote sync manager
    remoteSyncManager = new RemoteSyncManager(
        this.pendingSessionId,
        handleRemoteConfig,
        localStreamConfig,
        remoteConfig
    );
    remoteSyncManager.onRemoteState(handleRemoteState);
    
    // Start the connection
    if (this.isHost) {
        remoteSyncManager.connectAsHost();
    } else {
        remoteSyncManager.connectAsClient();
    }
    
    // Update UI to show we're connected
    document.querySelector('.videoContainer').classList.toggle('host', videoPlayer.isHost);
    document.querySelector('.videoContainer').classList.toggle('client', !videoPlayer.isHost);
}

// Handle remote state updates
function handleRemoteState(state) {
    console.log('Handling remote state:', state);
    playerSynchronizer.applySyncState(state);
}

// Show/hide UI elements
function showVideoUI(show) {
    document.querySelector('.menu').classList.toggle('hidden', show);
    document.querySelector('.videoContainer').classList.toggle('hidden', !show);
    document.querySelector('.scrubber').classList.toggle('hidden', !show);
}

// Set up UI event listeners
function setupUIEventListeners() {
    // Get buttons and disable them initially
    const hostButton = document.getElementById('hostButton');
    const joinButton = document.getElementById('joinButton');
    
    hostButton.disabled = true;
    joinButton.disabled = true;
    
    // Host button - create new session
    hostButton.addEventListener('click', async () => {
        if (!localStreamConfig) {
            console.error('Local stream config not loaded');
            return;
        }
        
        // Disable buttons during initialization
        hostButton.disabled = true;
        joinButton.disabled = true;
        
        try {
            await initializeSession(true, SESSION_ID);
        } catch (error) {
            console.error('Error starting as host:', error);
            // Re-enable buttons on error
            hostButton.disabled = false;
            joinButton.disabled = false;
        }
    });
    
    // Join button - join existing session
    joinButton.addEventListener('click', async () => {
        if (!localStreamConfig) {
            console.error('Local stream config not loaded');
            return;
        }
        
        // Get session ID from URL or prompt
        const sessionId = SESSION_ID || prompt('Enter session ID:');
        if (!sessionId) {
            return; // User cancelled
        }
        
        // Update URL with session ID
        if (!SESSION_ID) {
            window.history.pushState({}, '', `?session=${sessionId}`);
        }
        
        // Disable buttons during initialization
        hostButton.disabled = true;
        joinButton.disabled = true;
        
        try {
            await initializeSession(false, sessionId);
        } catch (error) {
            console.error('Error joining session:', error);
            alert(`Failed to join session: ${error.message}`);
            // Re-enable buttons on error
            hostButton.disabled = false;
            joinButton.disabled = false;
        }
    });
    
    // Play/Pause button
    document.getElementById('playPauseButton').addEventListener('click', () => {
        videoPlayer.togglePlayPause();
        syncStateWithRemote();
    });
    
    // Audio channel buttons
    document.getElementById('left-audio-activate').addEventListener('click', () => {
        videoPlayer.switchAudio('left');
        syncStateWithRemote();
    });
    
    document.getElementById('right-audio-activate').addEventListener('click', () => {
        videoPlayer.switchAudio('right');
        syncStateWithRemote();
    });
    
    // Scrubber
    document.querySelector('.scrubber').addEventListener('click', (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const seekPosition = (x / rect.width) * videoPlayer.duration;
        videoPlayer.seek(seekPosition);
        syncStateWithRemote();
    });
    
    // Helper function to sync state with remote if connected
    function syncStateWithRemote() {
        if (remoteSyncManager && remoteSyncManager.isConnected) {
            remoteSyncManager.sendState(videoPlayer.state);
        }
    }
}

// Media Session API handlers - fail fast if not available
function setupMediaSessionHandlers() {
    if (!navigator.mediaSession) {
        throw new Error('Media Session API is not available in this browser');
    }

    // Helper function to sync state with remote if connected
    function syncStateWithRemote() {
        if (remoteSyncManager && remoteSyncManager.isConnected) {
            remoteSyncManager.sendState(videoPlayer.state);
        }
    }

    // Set up media session actions
    const actions = {
        play: () => {
            console.log('Media Key Play pressed');
            videoPlayer.play();
            syncStateWithRemote();
        },
        pause: () => {
            console.log('Media Key Pause pressed');
            videoPlayer.pause();
            syncStateWithRemote();
        },
        seekbackward: (details) => {
            const seekTime = (details && details.seekOffset) || -10; // Default to 10 seconds
            console.log(`Seeking backward by ${Math.abs(seekTime)}s`);
            videoPlayer.seek(videoPlayer.currentTime + seekTime);
            syncStateWithRemote();
        },
        seekforward: (details) => {
            const seekTime = (details && details.seekOffset) || 10; // Default to 10 seconds
            console.log(`Seeking forward by ${Math.abs(seekTime)}s`);
            videoPlayer.seek(videoPlayer.currentTime + seekTime);
            syncStateWithRemote();
        }
    };

    // Set up action handlers
    Object.entries(actions).forEach(([action, handler]) => {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
        } catch (error) {
            console.warn(`The media session action "${action}" is not supported`);
        }
    });
    
    // Additional media session handlers for better browser compatibility
    const additionalHandlers = {
        previoustrack: () => actions.seekbackward({}),
        nexttrack: () => actions.seekforward({})
    };
    
    Object.entries(additionalHandlers).forEach(([action, handler]) => {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
        } catch (error) {
            // Ignore errors for these optional handlers
        }
    });
}

// Load configuration when the page loads
async function initializeApp() {
    try {
        localStreamConfig = await loadConfig();
        console.log('Loaded local stream config:', localStreamConfig);
        
        if (!localStreamConfig.stream) {
            throw new Error('No stream URL found in configuration');
        }
        
        // Enable host/join buttons
        document.getElementById('hostButton').disabled = false;
        document.getElementById('joinButton').disabled = false;
        
    } catch (error) {
        console.error('Failed to initialize app:', error);
        alert('Failed to load configuration. Please check the console for details.');
    }
}

// Start the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    // Set up initial UI event listeners (Host/Join buttons)
    setupUIEventListeners();
    
    // Set up media session handlers
    setupMediaSessionHandlers();
    
    // Show the menu by default
    showVideoUI(false);
    
    // Start loading configuration
    initializeApp();
});
