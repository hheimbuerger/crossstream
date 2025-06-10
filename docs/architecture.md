# CrossStream Architecture

## Overview

CrossStream is a web application that enables synchronized playback of multiple video streams in a single browser view. The primary use case is to display multiple HLS video streams side by side, with precise synchronization capabilities.

Key features include:
- Simultaneous playback of multiple HLS video streams
- Frame-accurate synchronization between all video players
- Centralized playback controls affecting all streams
- Peer-to-peer discovery and coordination between clients
- Support for different stream start times with automatic offset calculation

The system uses a local-first approach where one video (typically the local stream) serves as the baseline, and other streams are synchronized relative to it. Remote streams can have different starting timestamps, which are automatically compensated for during playback.

The user interface provides centralized controls including play/pause, ±30 second seek, and a timeline scrubber with thumbnail previews. All controls affect all synchronized video players simultaneously. Every interaction with the user interface is broadcast to all connected clients, which then apply the same changes to their respective video players.

## Data Classes

### StreamConfig

A data class representing the configuration for a single video stream. This configuration is used to synchronize multiple video streams based on their recording timestamps.

**Fields:**
- `stream` (string, required): A URL to an HLS (HTTP Live Streaming) manifest file (`.m3u8`).
- `thumbnailSprite` (string, required): A URL to an image file containing a series of thumbnails arranged in a grid. Each thumbnail represents a frame from the video at regular intervals.
- `timestamp` (ISO 8601 string, required): The exact time when the video recording started, in ISO 8601 format (e.g., "2025-06-08T12:00:00+02:00"). This is crucial for calculating time offsets between different streams.
- `thumbnailSeconds` (number, required): The interval between thumbnails in seconds.
- `thumbnailPixelWidth` (number, required): The width of each thumbnail in pixels.

**Example:**
```json
{
  "stream": "http://example.com/videos/stream1/playlist.m3u8",
  "thumbnailSprite": "http://example.com/thumbnails/stream1_sprite.jpg",
  "timestamp": "2025-06-08T12:00:00+02:00",
  "thumbnailSeconds": 5.0,
  "thumbnailPixelWidth": 64
}
```

**Usage Notes:**
- The `timestamp` field enables synchronization between multiple streams by allowing the calculation of time offsets between when different streams started recording.
- The `thumbnailSprite` should contain thumbnails at regular intervals (e.g., one thumbnail per second) to enable the timeline scrubber functionality.

## Event Handling

### Overview
The application uses a unidirectional event flow pattern where UI components emit events that are handled by the player controller. This creates a clear separation of concerns and makes the application more maintainable.

### Event Flow

1. **User Interactions**
   - UI components capture user input (clicks, drags, etc.)
   - Events are translated into semantic actions (play, pause, seek, etc.)
   - Actions are passed to the player controller via callbacks

2. **State Updates**
   - Player state changes trigger callbacks to update the UI
   - UI components update their visual state accordingly
   - All state mutations are handled by the player controller

### Key Events

| Event | Source | Payload | Description |
|-------|--------|---------|-------------|
| `onPlayPause` | UI | None | Toggle between play and pause |
| `onSeek` | UI | `position` (0-1) | Seek to absolute position |
| `onSeekRelative` | UI | `seconds` (number) | Seek relative to current time |
| `onTimeUpdate` | Player | `{currentTime, duration}` | Update time display |
| `onStateChange` | Player | `{isPlaying, state}` | Update playback state |

## UI Subsystem

### Overview
The UI subsystem manages all user interface elements and interactions, serving as the view layer of the application. It's responsible for rendering the current state and forwarding user actions to the player controller.

### Key Components

1. **UI Class**
   - Manages all DOM elements and their lifecycle
   - Handles UI state (loading, error states, etc.)
   - Coordinates with the Scrubber component
   - Manages Media Session API integration
   - Handles all user input events

2. **Scrubber Component**
   - Handles timeline scrubbing and preview
   - Manages thumbnail display and hover states
   - Provides seek functionality
   - Handles both mouse and touch interactions

### Data Flow
1. User interactions are captured by UI event listeners
2. Events are translated into semantic actions
3. Actions are passed to the player controller via callbacks
4. Player state changes trigger UI updates through callbacks

### Performance Considerations
- DOM updates are batched where possible
- Event delegation is used for dynamic elements
- Heavy operations are debounced when appropriate
- Event listeners are properly cleaned up on component destruction

## Unified Timeline Concept

### Overview
The unified timeline is a core concept that spans all video streams, providing a single continuous timeline that starts at the earliest frame of the earliest starting video and ends at the last frame of the latest ending video. This timeline is used throughout the application for scrubbing, seeking, and displaying the current position.

### Key Properties

1. **Timeline Start (0%)**:
   - Matches the start time of the video that started recording first
   - This could be either the local or remote video

2. **Timeline End (100%)**:
   - Matches the end time of the video that finishes recording last
   - This could be either the local or remote video

3. **Video Segments**:
   - Each video exists as a segment within the unified timeline
   - Segments may overlap (if videos have overlapping recording times)

### Timeline Calculation

```
// Pseudo-code for timeline calculation
const localStartTime = new Date(localConfig.timestamp);
const remoteStartTime = new Date(remoteConfig.timestamp);
const localEndTime = localStartTime + localVideo.duration;
const remoteEndTime = remoteStartTime + remoteVideo.duration;

const timelineStart = Math.min(localStartTime, remoteStartTime);
const timelineEnd = Math.max(localEndTime, remoteEndTime);
const totalDuration = (timelineEnd - timelineStart) / 1000; // in seconds
```

### Position Conversion

1. **Timeline Position to Video Time**
   - Convert a position on the unified timeline to a specific time in a video:
   ```
   // For local video
   const localVideoTime = (timelinePosition * totalDuration) - ((localStartTime - timelineStart) / 1000);
   
   // For remote video
   const remoteVideoTime = (timelinePosition * totalDuration) - ((remoteStartTime - timelineStart) / 1000);
   ```

2. **Video Time to Timeline Position**
   - Convert a video's current time to the unified timeline position:
   ```
   // For local video
   const timelinePosition = (localVideo.currentTime + ((localStartTime - timelineStart) / 1000)) / totalDuration;
   
   // For remote video
   const timelinePosition = (remoteVideo.currentTime + ((remoteStartTime - timelineStart) / 1000)) / totalDuration;
   ```

### Scrubber Integration
The timeline scrubber represents this unified timeline, allowing users to:
- See the full duration of combined video content
- Seek to any position in the unified timeline
- View thumbnails from the appropriate video for the current position

## Unified Playhead

The unified playhead represents the current playback position across the entire timeline, providing a single point of reference that works seamlessly across all video segments. Both videos are always active and synchronized, with their playback positions determined by their respective start times and the unified timeline.

### Key Properties

1. **Playhead Position (0-1)**:
   - Represents the current position in the unified timeline
   - 0 = start of the timeline (earliest frame)
   - 1 = end of the timeline (latest frame)

2. **Timeline Bounds**:
   - Start time: When the first video starts
   - End time: When the last video ends
   - Total duration: Difference between end and start times

### Playhead Methods

1. **Seek to Position**
   - Seeks both videos to their respective positions based on the unified timeline
   - Handles seeking to positions where only one video has content

2. **Get Current Position**
   - Returns the current playhead position (0-1) in the unified timeline
   - Provides smooth updates during playback

3. **Time Conversion**
   - Convert between unified timeline position and individual video times
   - Used internally for seeking and synchronization

## Subsystems

### Media Session API Integration

The Media Session API integration is handled by the VideoPlayerSynchronizer, which serves as the single source of truth for media state. This includes:

- Media metadata (title, artist, album, artwork)
- Playback state (playing/paused)
- Position state (current time, duration)
- Media key handling (play, pause, seek, etc.)

**Responsibilities:**
- Registering and managing media session action handlers
- Updating media metadata and playback state
- Handling media key events
- Synchronizing media session state with actual player state

**Methods:**
- `setupMediaSessionHandlers()`: Sets up all media session action handlers
- `updateMediaSessionMetadata()`: Updates media session metadata and state
- `handleMediaSessionAction(action, details)`: Handles media session actions

### Scrubber Component

**Methods:**
- `handleScrubberClick(event)`: Process click/tap events on the timeline
- `handleScrubberHover(event)`: Handle hover events for preview
- `updateThumbnails(localThumbnail, remoteThumbnail)`: Update thumbnail sources
- `cleanup()`: Remove event listeners and clean up resources

### VideoPlayerSynchronizer

The VideoPlayerSynchronizer is responsible for maintaining frame-accurate synchronization between multiple video players. An instance is created when multiple video sources are registered, taking local and remote stream configurations as parameters.

**Responsibilities:**
- Calculate and manage time offsets between video streams based on their recording timestamps
- Synchronize playback states (play/pause) across all video instances
- Handle seeking operations while maintaining sync between streams
- Manage audio routing between video sources
- Coordinate buffering states to ensure smooth playback
- Interface with HLS.js for adaptive streaming functionality

**States:**
- `paused`: Both video players are currently paused, with at least one not ready for immediate playback
- `ready`: Both video players are paused but fully buffered and ready for immediate playback
- `playing`: Both video players are actively playing back in sync

**Methods:**
- `constructor(localStreamConfig, remoteStreamConfig)`: Initializes the synchronizer with the given stream configurations
- `play()`: Starts playback of all synchronized videos. Throws an exception if any video is not ready for playback
- `pause()`: Pauses playback of all synchronized videos
- `seekLocal(time)`: Seeks all videos to the appropriate synchronized position based on the local video timeline
- `seekRemote(time)`: Seeks all videos to the appropriate synchronized position based on the remote video timeline
- `switchAudio(source)`: Switches audio between 'local' and 'remote' video sources
- `destroy()`: Cleans up resources including HLS instances and event listeners

**Inputs:**
- Local and remote stream configurations (containing stream URLs and timestamps)
- Playback control commands (play, pause, seek)
- Audio source selection

**Outputs:**
- Synchronized video playback across multiple elements
- Playback state changes
- Error events for synchronization issues

**Assumptions:**
For the entirety of its lifetime, it can assume that both streams are available and valid. It doesn't need to deal with streams being added or removed.


### RemoteSyncManager

The RemoteSyncManager handles peer discovery and communication between different client instances in a peer-to-peer fashion. It uses the Peer.js library to establish WebRTC data channels between clients, enabling real-time synchronization of video playback states.

**Responsibilities:**
- Establish and manage WebRTC peer connections within a session
- Exchange stream configurations between peers
- Relay playback commands (play, pause, seek) between connected clients
- Handle connection lifecycle and error scenarios
- Manage resource cleanup on disconnection

**Connection States:**
- `connecting`: Attempting to establish connection
- `connected`: Active WebRTC connection established
- `disconnected`: No active connection
- `error`: Connection error state

**Core Methods:**
- `constructor(sessionId, localConfig, callbacks)`: Initializes and connects to a peer-to-peer session
  - `sessionId`: Unique identifier for the session to join
  - `localConfig`: The local stream configuration to share with peers
  - `callbacks`: Object containing:
    - `onConnectionEstablished(remoteConfig)`: Triggered when a connection to another peer is established
    - `onCommand(command)`: Triggered when a playback command is received
- `disconnect()`: Closes all connections and cleans up resources
- `sendCommand(command)`: Sends a playback command to the connected peer

**Configuration Exchange Protocol:**
1. Upon instantiation, the manager immediately attempts to connect to the specified session
2. Once connected, it immediately sends its local configuration to the peer
3. When a configuration is received:
   - The `onConnectionEstablished` callback is triggered with the remote configuration
   - The manager automatically responds by sending its local configuration (if not already sent)
4. This exchange ensures both peers have each other's configuration

**Command Protocol:**
- After connection is established, peers exchange playback commands
- Commands include:
  - `{ type: 'play', time: number }`: Start playback at specified time
  - `{ type: 'pause', time: number }`: Pause playback at specified time
  - `{ type: 'seek', time: number }`: Seek to specified time

**Inputs:**
- `localConfig` (object): Local stream configuration to share
- `sessionId` (string): Target session ID to connect to

**Outputs:**
- Connection state changes (connected/disconnected/error)
- Remote configuration updates via `onRemoteConfig`
- Playback state synchronization events
- Error events for connection issues

**Assumptions:**
- PeerJS server is available for initial peer connection establishment
- Both peers have compatible WebRTC support in their browsers
- Network conditions allow for peer-to-peer communication (or TURN servers are available)
- Local configuration is valid and contains required stream information

## Data Flow

### UI Data Flow
1. User interacts with UI controls (play/pause, seek, etc.)
2. UI translates interactions into player commands
3. Commands are executed on the VideoPlayerSynchronizer
4. Player state changes trigger UI updates
5. UI reflects the current state (play/pause button, time display, etc.)

### Scrubber Data Flow
1. User hovers over the timeline
2. Scrubber updates preview thumbnail and position
3. User clicks/drags to seek
4. Scrubber calculates target time and triggers seek
5. VideoPlayerSynchronizer updates playback position
6. UI updates to reflect the new position

### Cross-Component Communication
- UI and Scrubber communicate through the VideoPlayerSynchronizer
- All state changes flow through the VideoPlayerSynchronizer
- UI components observe player state and update accordingly

## Performance Considerations

### UI Performance
- **Throttle/Debounce Inputs**: User input handlers (especially for the scrubber) should be debounced to prevent excessive updates
- **Efficient DOM Updates**: Batch DOM updates and use requestAnimationFrame for smooth animations
- **Event Delegation**: Use event delegation for UI elements that are frequently added/removed

### Scrubber Performance
- **Lazy Loading**: Load thumbnails on demand as the user hovers over the timeline
- **Thumbnail Caching**: Cache loaded thumbnails to avoid redundant network requests
- **Optimized Rendering**: Use CSS transforms for smooth animations of the playhead and preview

### Memory Management
- **Cleanup**: Properly remove event listeners when components are destroyed
- **Resource Release**: Release media resources when not in use (especially important for mobile devices)

## Future Extensions