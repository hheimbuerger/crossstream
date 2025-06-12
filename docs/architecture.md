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
CrossStream now uses a **single, centralized event bus** powered by the `mitt` library. All components publish and subscribe to events exclusively through this `EventBus` instance. There are **no direct callback props** or bespoke event arrays inside components anymore.

### Event Flow

1. **User Interactions**
   - UI elements capture user input (clicks, drags, etc.).
   - Handlers in `UI.js` emit semantic events on the **EventBus** such as `localPlay`, `localPause`, `localSeek`, and `localSeekRelative`.

2. **Player Commands**
   - `VideoPlayerSynchronizer` listens for these command events and invokes the appropriate actions (`play`, `pause`, `seek*`).

3. **State Updates**
   - `VideoPlayerSynchronizer` emits playback state and timeline updates (`stateChange`, `timeUpdate`) on the **EventBus**. `playhead` is always expressed in seconds.
   - UI components and any other interested module subscribe to these events to keep the interface in sync.

### Core Bus Events

| Event | Emitted By | Payload | Purpose |
|-------|------------|---------|---------|
| `localPlay` | UI | *none* | User pressed play |
| `localPause` | UI | *none* | User pressed pause (also emitted before a scrubber seek) |
| `localSeek` | UI/Scrubber | `playhead` (seconds) | Absolute seek while paused |
| `localSeekRelative` | UI | `delta` (seconds) | ± seek buttons while paused |
| `localAudioChange` | UI | `track` ('local'\|'remote'\|'none') | Switch active audio track (local / remote / mute) |
| `remotePlay` | RemoteSyncManager | `{ playhead }` | Remote peer play |
| `remotePauseSeek` | RemoteSyncManager | `{ playhead }` | Remote peer paused & sought (single message) |
| `remoteAudioChange` | RemoteSyncManager | `{ track }` | Remote peer audio change (values: 'local'|'remote'|'none') |
| `timeUpdate` | VideoPlayerSynchronizer | `playhead` (seconds), `duration` (s) | Continuous timeline updates |
| `stateChange` | VideoPlayerSynchronizer | `{ state, playhead, duration }` | Changes in playback state |

All new functionality must use these bus events; legacy callback fields have been removed.

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
   - Constructed with `{ duration, onSeek }` where `duration` is unified timeline length in seconds.
   - All user interactions (drag, click) emit seconds directly.
   - Hover moves the thumb without seeking via `handleHover(clientX)`.
   - No internal concept of 0-1 ratios is exposed outside the component.

### Data Flow
1. User interactions are captured by UI event listeners
2. Events are translated into semantic actions
3. Actions are passed to the player controller via the EventBus
4. Player state changes trigger UI updates through the EventBus
5. UI reflects the current state (play/pause button, time display, etc.)

### Performance Considerations
- DOM updates are batched where possible
- Event delegation is used for dynamic elements
- Heavy operations are debounced when appropriate
- Event listeners are properly cleaned up on component destruction

### Additional Audio Toggle Controls

Additional audio toggle controls have been added:

| Element | ID | Event Emitted |
|---------|----|---------------|
| Local audio button | `audioLocalButton` | `localAudioChange` `'local'` |
| Remote audio button | `audioRemoteButton` | `localAudioChange` `'remote'` |
| Mute button | `audioMuteButton` | `localAudioChange` `'none'` |

The UI reflects current audio state via `stateChange` events by toggling an `.active` class on the buttons.

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

1. **Playhead Position (seconds)**:
   - Represents the current position in the unified timeline
   - 0 = start of the timeline (earliest frame)
   - `totalDuration` = end of the timeline (latest frame)

2. **Timeline Bounds**:
   - Start time: When the first video starts
   - End time: When the last video ends
   - Total duration: Difference between end and start times

### Playhead Methods

1. **Seek to Position**
   - Seeks both videos to their respective positions based on the unified timeline
   - Handles seeking to positions where only one video has content

2. **Get Current Position**
   - Returns the current playhead position (seconds) in the unified timeline
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

**Command & Vector Clock Protocol:**
After connection is established, peers exchange **vector-clocked** playback commands to ensure causal ordering and deterministic conflict resolution.

Each command payload is augmented as follows:

```jsonc
{
  "type": "command",
  "command": {
    "type": "play" | "pause" | "seek" | "audioChange",   // operation
    "position": number,               // unified playhead (for pause/seek)
    "clock": { "<peerId>": number }, // vector clock map
    "senderId": string                // peerId of originator
  }
}
```

Conflict resolution rules:
1. If `clockA` **happens-before** `clockB`, apply `B`.
2. If concurrent, apply the command whose `senderId` is lexicographically smaller (tie-break).

Minimal examples:
* **Play**: `{ type: 'play', position: 12.3, … }`
* **Pause**: `{ type: 'pause', position: 18.0, … }`
* **Seek**: `{ type: 'seek', position: 45.7, … }`
* **Audio Change**: `{ type: 'audioChange', track: 'remote' | 'local' | 'none', … }`

### Synchronization Engine

The **Synchronization Engine** is the top-level component that ensures two *sets* of video players—one local set on each peer—remain in **rough synchronization** across a peer-to-peer connection.

**Responsibilities**

* Maintain unified playback state (play/pause, unified playhead) across peers while tolerating small timing skew.
* Propagate all user actions (play, pause, seek, rewind/fast-forward, audioChange) to the remote peer via `RemoteSyncManager`.
* Resolve conflicting concurrent commands deterministically using vector clocks (implemented in `RemoteSyncManager`).
* Delegate *in-browser* frame-accurate sync to `VideoPlayerSynchronizer` on each peer.

**Design Principles**

* *Peer Equality*: Both peers are equal—no master/slave. Any peer can initiate playback operations, and both must respond to incoming commands.
* *Event Propagation*: All playback-affecting user actions (play, pause, seek, audio change, rewind/fast-forward) are immediately propagated to the other peer.
* *Loose Consistency*: The goal is not perfect frame-accurate sync, but to keep both sides in the same logical state (playing/paused/position), tolerating minor network delays and conflicts.
* *Conflict Resolution*: When conflicting commands occur (e.g., both pause and play at the same time), the system resolves to a single, shared state. Which state is chosen is less important than both peers ending up in the same state.
* *Essential vs. Non-Essential Sync*: Only core playback state (play/pause/seek position) must be strictly synchronized. Non-essential controls (audio track selection, volume) can be loosely synchronized or even independent if needed for UX.
* *Graceful Handling of Rapid Actions*: The engine must handle rapid, repeated commands (e.g., multiple rewinds) without causing desynchronization or erratic jumps.

**Protocol Sketch**

* **Play**: When a peer initiates play, it sends a play command with the current playhead position and timestamp. Both peers wait for their local video players to be ready (using the existing playWhenReady), then start playback together.
* **Pause+Seek**: Any user pause, scrub, jump, or ± seek action results in a *single* `pauseSeek` command that carries the target unified playhead. Peers pause (if playing) and seek to the position.
* **Audio Change**: Send an `audioChange` command with the new audio track (`'local'`, `'remote'`, or `'none'`). Receiving peer flips `'local'` ↔ `'remote'`; `'none'` mutes both.
* **Command Batching**: If multiple commands are issued in rapid succession, batch or coalesce them before sending to avoid excessive network chatter.

**Handling Simultaneous Commands**:

* If both peers send conflicting commands at nearly the same time, each peer uses the **vector clock** comparison; if the clocks are concurrent, the command with the lexicographically smaller `senderId` wins (deterministic tie-break).

**UX Considerations**

* Always prioritize a smooth experience over perfect sync. Minor delays or differences are acceptable if they avoid jarring jumps or freezes.
* Allow for leeway in sync (e.g., up to a few hundred milliseconds) to absorb network jitter.

**Causal Ordering with Vector Clocks**

`RemoteSyncManager` now stamps every outgoing command with an incremented vector clock (`clock`) and `senderId`. On receipt, the remote side compares the incoming clock with the last-applied clock:

* **happens-before** → apply newer command
* **concurrent** → tie-break via `senderId`

The winning command is emitted on the global `EventBus` with event names prefixed by `remote` (e.g., `remotePlay`, `remotePauseSeek`, `remoteAudioChange`). The **Synchronization Engine** listens to these events to update local playback state accordingly.

**Sequence Diagram**

```
Peer A UI  --> EventBus --> VideoPlayerSynchronizer --> RemoteSyncManager.sendCommand()
                                                             | (vector-clocked cmd)
Peer B RemoteSyncManager.handleIncomingCommand() -- EventBus.remoteCommand --> VideoPlayerSynchronizer --> UI
```

**Leeway & Skew Handling**

If the unified playhead difference after any command is ≤ 250 ms, no corrective seek is issued to avoid jank. Larger deviations trigger an automatic seek before playback resumes.

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