// --- Imports ---
import { VideoPlayerSynchronizer } from './VideoPlayerSynchronizer.js';
import { RemoteSyncManager } from './RemoteSyncManager.js';
import { UI } from './UI.js';
import bus from './EventBus.js';

// --- Constants ---
const SEEK_STEP = 10; // seconds for forward/backward seek

// --- Constants ---
// const SESSION_ID = 'crossstream-dev'; // Fixed session ID for now
const urlParams = new URLSearchParams(window.location.search);
const SESSION_ID = urlParams.get('session');

// --- State ---
let localStreamConfig = null;
let remoteSyncManager = null;
let videoSynchronizer = null;
let ui = null;

// --- RemoteSyncManager Setup ---
function setupRemoteSyncManager() {
    ui.showLoading('Connecting to peer...');
    
    // Clean up any existing instances
    if (remoteSyncManager) {
        remoteSyncManager.disconnect();
        remoteSyncManager = null;
    }
    
    // Instantiate without callbacks (event bus will be used)
    remoteSyncManager = new RemoteSyncManager(SESSION_ID, localStreamConfig);

    // --- RemoteSyncManager Bus Listeners ---
    const onPeerConfig = (remoteConfig) => {
        console.log('Connection established with remote peer');
        ui.hideLoading();
        setupVideoSynchronizer(remoteConfig);
    };

    const onRemoteCommand = (command) => {
        switch (command.type) {
            case 'play':
                handleReceivedPlay(command);
                break;
            case 'pause':
                handleReceivedPause(command);
                break;
            case 'seek':
                handleReceivedSeek(command);
                break;
            default:
                console.warn('Unknown command type:', command.type);
        }
    };

    const onSyncError = (error) => {
        console.error('RemoteSyncManager error:', error);
        if (!error.message.includes('Could not connect to peer') || remoteSyncManager.peer.id === SESSION_ID) {
            ui.showError('Connection error: ' + error.message);
        }
        ui.hideLoading();
    };

    const onPeerDisconnected = () => {
        console.log('Connection to peer lost');
        ui.showError('Connection to peer lost. Waiting for reconnection...');
        cleanupPlayer();
    };

    bus.on('peerConfig', onPeerConfig);
    bus.on('remoteCommand', onRemoteCommand);
    bus.on('syncError', onSyncError);
    bus.on('peerDisconnected', onPeerDisconnected);

    // Cleanup listeners when remoteSyncManager disconnects / app cleans up
    const cleanupRemoteBus = () => {
        bus.off('peerConfig', onPeerConfig);
        bus.off('remoteCommand', onRemoteCommand);
        bus.off('syncError', onSyncError);
        bus.off('peerDisconnected', onPeerDisconnected);
    };

    // Store cleanup function
    const originalDisconnect = remoteSyncManager.disconnect.bind(remoteSyncManager);
    remoteSyncManager.disconnect = () => {
        cleanupRemoteBus();
        originalDisconnect();
    };
}

// --- VideoSynchronizer Setup ---
function setupVideoSynchronizer(remoteConfig) {
    ui.showLoading('Initializing video player...');
    
    // Clean up existing synchronizer if any
    videoSynchronizer?.destroy();

    try {
        // Initialize the VideoPlayerSynchronizer with video elements and configs
        videoSynchronizer = new VideoPlayerSynchronizer(
            ui.elements.localVideo,
            localStreamConfig,
            ui.elements.remoteVideo,
            remoteConfig
        );
        
        // Set up event handlers
        const onTimeUpdate = (playhead, duration) => {
            ui.updateScrubberTime(playhead, duration);
        };
        
        const onStateChange = (state) => {
            // Update UI elements
            ui.updatePlayPauseButton(state.state === 'playing');
        };
        
        // Register event listeners via central EventBus instead of internal callbacks
        bus.on('timeUpdate', onTimeUpdate);
        bus.on('stateChange', onStateChange);
        
        // Store cleanup function
        const cleanup = () => {
            bus.off('timeUpdate', onTimeUpdate);
            bus.off('stateChange', onStateChange);
        };
        
        // Cleanup on destroy
        const originalDestroy = videoSynchronizer.destroy.bind(videoSynchronizer);
        videoSynchronizer.destroy = () => {
            cleanup();
            originalDestroy();
        };

        // Hide loading indicator now that setup is complete
        ui.hideLoading();
        
        // Initialize UI with initial state
        ui.updatePlayPauseButton(false);
        
    } catch (error) {
        console.error('Failed to initialize video synchronizer:', error);
        ui.showError('Failed to initialize video playback: ' + error.message);
        ui.hideLoading();
    }
}

// --- UI Event Handlers ---
/**
 * Toggle play/pause state of the video player
 */
function handlePlayPause() {
    const state = videoSynchronizer.getState();
    if (state.state === 'ready') {
        videoSynchronizer.play();
    } else {
        videoSynchronizer.pause();
    }
    
    // Notify remote peer
    remoteSyncManager?.sendCommand({
        type: state.state === 'playing' ? 'pause' : 'play',
        timestamp: Date.now(),
        playhead: state.playhead // Include current playhead position
    });
}

/**
 * Handle seek to a specific playhead in seconds
 * @param {number} playhead - Time in seconds to seek to
 */
function handleSeek(playhead) {
    const state = videoSynchronizer.getState();
    const safePlayhead = Math.max(0, Math.min(state.duration, playhead));
    videoSynchronizer.seek(safePlayhead);
    
    // Notify remote peer
    remoteSyncManager?.sendCommand({
        type: 'seek',
        timestamp: Date.now(),
        playhead: safePlayhead
    });
}

/**
 * Handle relative seek from current playhead
 * @param {number} seconds - Number of seconds to seek (positive or negative)
 */
function handleSeekRelative(seconds) {
    const state = videoSynchronizer.getState();
    const newPlayhead = Math.max(0, Math.min(state.duration, state.playhead + seconds));
    videoSynchronizer.seek(newPlayhead);
    
    // Notify remote peer
    remoteSyncManager?.sendCommand({
        type: 'seek',
        timestamp: Date.now(),
        playhead: newPlayhead
    });
}

// --- Remote Command Handlers ---
/**
 * Handle play command from remote peer
 * @param {Object} command - Remote command with optional playhead
 */
function handleReceivedPlay(command) {  
    // Only follow play commands if we're not already playing
    const state = videoSynchronizer.getState();
    if (state.state !== 'playing') {
        videoSynchronizer.play();
    }
    
    // If the command includes a playhead, seek to it
    if (command.playhead !== undefined) {
        const playhead = Math.max(0, Math.min(state.duration, command.playhead));
        videoSynchronizer.seek(playhead);
    }
}

/**
 * Handle pause command from remote peer
 * @param {Object} command - Remote command with optional playhead
 */
function handleReceivedPause(command) {
    // Only follow pause commands if we're playing
    const state = videoSynchronizer.getState();
    if (state.state === 'playing') {
        videoSynchronizer.pause();
    }
    
    // If the command includes a playhead, seek to it
    if (command.playhead !== undefined) {
        const playhead = Math.max(0, Math.min(state.duration, command.playhead));
        videoSynchronizer.seek(playhead);
    }
}

/**
 * Handle seek command from remote peer
 * @param {Object} command - Remote command with playhead (seconds) and timestamp
 */
function handleReceivedSeek(command) {
    // If the command includes a playhead, seek to it
    if (command.playhead !== undefined) {
        const state = videoSynchronizer.getState();
        const diff = Math.abs(state.playhead - command.playhead);
        if (diff > 0.1) { // 100ms threshold
            videoSynchronizer.seek(command.playhead);
        }
    }
    
    // Sync play/pause state if needed
    if (command.isPlaying !== undefined) {
        const currentState = videoSynchronizer.getState();
        if (command.isPlaying && currentState.state === 'paused') {
            videoSynchronizer.play();
        } else if (!command.isPlaying && currentState.state === 'playing') {
            videoSynchronizer.pause();
        }
    }
}

// --- Initialization ---
function loadConfig() {
    // Load configuration from the server or use default
    return fetch('/config')
        .then(response => response.json())
        .catch(error => {
            console.error('Failed to load config:', error);
            ui.showError('Failed to load configuration: ' + error.message);
            throw error;
        });
}

async function initializeApp() {
    try {
        // Initialize UI (event handling uses central EventBus now)
        ui = new UI();
        
        // Wire UI-generated events through EventBus to handlers
        bus.on('playPause', handlePlayPause);
        bus.on('seek', handleSeek);
        bus.on('seekRelative', handleSeekRelative);
        
        // Load configuration
        localStreamConfig = await loadConfig();
        setupRemoteSyncManager();
        
        // Set up beforeunload handler
        window.addEventListener('beforeunload', cleanupPlayer);

    } catch (error) {
        console.error('Failed to initialize app:', error);
        if (ui) {
            ui.showError('Failed to initialize application: ' + error.message);
        }
    }
}

// --- Cleanup Functions ---
function cleanupPlayer() {
    // Clean up video synchronizer
    videoSynchronizer.destroy();
    videoSynchronizer = null;
    
    // Clean up remote sync manager
    remoteSyncManager.disconnect();
    remoteSyncManager = null;
    
    // Clean up UI (includes scrubber cleanup)
    ui.cleanup();
    ui = null;
}

// Start the application
document.addEventListener('DOMContentLoaded', initializeApp);
