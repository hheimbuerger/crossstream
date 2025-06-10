// --- Imports ---
import { VideoPlayerSynchronizer } from './VideoPlayerSynchronizer.js';
import { RemoteSyncManager } from './RemoteSyncManager.js';
import { UI } from './UI.js';

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
    
    remoteSyncManager = new RemoteSyncManager(SESSION_ID, localStreamConfig, {
        onConnectionEstablished: (remoteConfig) => {
            console.log('Connection established with remote peer');
            ui.hideLoading();
            setupVideoSynchronizer(remoteConfig);
            // Initialize scrubber through UI module
            ui.setupScrubber(localStreamConfig, remoteConfig);
        },
        onCommand: (command) => {
            // Route commands to appropriate handlers
            switch (command.type) {
                case 'play':
                    handleReceivedPlay(command);
                    break;
                case 'pause':
                    handleReceivedPause(command);
                    break;
                case 'seekTo':
                    handleReceivedSeekTo(command);
                    break;
                default:
                    console.warn('Unknown command type:', command.type);
            }
        },
        onError: (error) => {
            console.error('RemoteSyncManager error:', error);
            // Don't show error for the first peer that's waiting for connections
            if (!error.message.includes('Could not connect to peer') || 
                remoteSyncManager.peer.id === SESSION_ID) {
                ui.showError('Connection error: ' + error.message);
            }
            ui.hideLoading();
        },
        onConnectionLost: () => {
            console.log('Connection to peer lost');
            ui.showError('Connection to peer lost. Waiting for reconnection...');
            cleanupPlayer();
        }
    });
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
        
        // Register event listeners
        videoSynchronizer.addEventListener('timeUpdate', onTimeUpdate);
        videoSynchronizer.addEventListener('stateChange', onStateChange);
        
        // Store cleanup function
        const cleanup = () => {
            videoSynchronizer.removeEventListener('timeUpdate', onTimeUpdate);
            videoSynchronizer.removeEventListener('stateChange', onStateChange);
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
    if (!videoSynchronizer) return;
    
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
        position: state.playhead // Include current playhead position
    });
}

/**
 * Handle seek to a specific time in the unified timeline
 * @param {number} time - Time in seconds to seek to
 */
function handleSeek(time) {
    if (!videoSynchronizer) return;
    
    const state = videoSynchronizer.getState();
    if (state.duration > 0) {
        // Convert absolute time to playhead position (0-1)
        const playhead = Math.max(0, Math.min(1, time / state.duration));
        videoSynchronizer.seekToPosition(playhead);
        
        // Notify remote peer
        remoteSyncManager?.sendCommand({
            type: 'seekTo',
            timestamp: Date.now(),
            position: playhead
        });
    }
}

/**
 * Handle relative seek from current position
 * @param {number} seconds - Number of seconds to seek (positive or negative)
 */
function handleSeekRelative(seconds) {
    if (!videoSynchronizer) return;
    
    const state = videoSynchronizer.getState();
    const currentTime = state.playhead * state.duration;
    const newTime = Math.max(0, Math.min(state.duration, currentTime + seconds));
    const newPlayhead = state.duration > 0 ? newTime / state.duration : 0;
    
    videoSynchronizer.seekToPosition(newPlayhead);
    
    // Notify remote peer
    remoteSyncManager?.sendCommand({
        type: 'seekTo',
        timestamp: Date.now(),
        position: newPlayhead
    });
}

// --- Remote Command Handlers ---
/**
 * Handle play command from remote peer
 * @param {Object} command - Remote command with optional position
 */
function handleReceivedPlay(command) {
    if (!videoSynchronizer) return;
    
    // Only follow play commands if we're not already playing
    const state = videoSynchronizer.getState();
    if (state.state !== 'playing') {
        videoSynchronizer.play();
    }
    
    // If the command includes a position, seek to it
    if (command.position !== undefined) {
        // Ensure position is within valid range
        const position = Math.max(0, Math.min(1, command.position));
        videoSynchronizer.seekToPosition(position);
    }
}

/**
 * Handle pause command from remote peer
 * @param {Object} command - Remote command with optional position
 */
function handleReceivedPause(command) {
    if (!videoSynchronizer) return;
    
    // Only follow pause commands if we're playing
    const state = videoSynchronizer.getState();
    if (state.state === 'playing') {
        videoSynchronizer.pause();
    }
    
    // If the command includes a position, seek to it
    if (command.position !== undefined) {
        // Ensure position is within valid range
        const position = Math.max(0, Math.min(1, command.position));
        videoSynchronizer.seekToPosition(position);
    }
}

/**
 * Handle seek command from remote peer
 * @param {Object} command - Remote command with position (0-1) and timestamp
 */
function handleReceivedSeekTo(command) {
    if (!videoSynchronizer) return;
    
    // Only process if the command is recent (within 2 seconds)
    const commandAge = Date.now() - command.timestamp;
    if (commandAge > 2000) {
        console.log('Ignoring stale seek command');
        return;
    }
    
    // Ensure position is within valid range
    if (command.position !== undefined) {
        const position = Math.max(0, Math.min(1, command.position));
        const state = videoSynchronizer.getState();
        
        // Only seek if we're not already close to the target position
        const positionDiff = Math.abs(state.playhead - position);
        if (positionDiff > 0.01) { // Only seek if difference is more than 1%
            videoSynchronizer.seekToPosition(position);
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
        // Initialize UI with event handlers
        ui = new UI({
            onPlayPause: handlePlayPause,
            onSeek: handleSeek,
            onSeekRelative: handleSeekRelative
        });
        
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
