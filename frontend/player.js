// --- Imports ---
import { VideoPlayerSynchronizer } from './VideoPlayerSynchronizer.js';
import { RemoteSyncManager } from './RemoteSyncManager.js';
import { SynchronizationEngine } from './SynchronizationEngine.js';
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
let syncEngine = new SynchronizationEngine(() => videoSynchronizer, () => remoteSyncManager);

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
    bus.on('syncError', onSyncError);
    bus.on('peerDisconnected', onPeerDisconnected);

    // Remote commands are now emitted with 'remote' prefix and consumed by
    // SynchronizationEngine directly via EventBus registration, so no
    // explicit handler wiring is required here.

    // Cleanup listeners when remoteSyncManager disconnects / app cleans up
    const cleanupRemoteBus = () => {
        bus.off('peerConfig', onPeerConfig);
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
        
        // SynchronizationEngine already registered its handlers on the EventBus
        // during instantiation, so no additional wiring is necessary here.

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
