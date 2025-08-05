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

The user interface provides centralized controls including play/pause, seek controls, and a timeline scrubber with thumbnail previews. All controls affect all synchronized video players simultaneously. Every interaction with the user interface is broadcast to all connected clients, which then apply the same changes to their respective video players.

## Data Classes

### StreamConfig

A data class representing the configuration for a single video stream. This configuration is used to synchronize multiple video streams based on their recording timestamps.

**Fields:**
- `stream` (string, required): A URL to an HLS (HTTP Live Streaming) manifest file (`.m3u8`).
- `thumbnailSprite` (string, required): A URL to an image file containing a series of thumbnails arranged in a grid. Each thumbnail represents a frame from the video at regular intervals.
- `timestamp` (ISO 8601 string, required): The exact time when the video recording started, in ISO 8601 format (e.g., "2025-06-08T12:00:00+02:00"). This is crucial for calculating time offsets between different streams.
- `thumbnailSeconds` (number, required): The interval between thumbnails in seconds.
- `thumbnailPixelWidth` (number, required): The width of each thumbnail in pixels.
- `thumbnailPixelHeight` (number, required): The height of each thumbnail in pixels.

**Example:**
```json
{
  "stream": "http://example.com/videos/stream1/playlist.m3u8",
  "thumbnailSprite": "http://example.com/thumbnails/stream1_sprite.jpg",
  "timestamp": "2025-06-08T12:00:00+02:00",
  "thumbnailSeconds": 5.0,
  "thumbnailPixelWidth": 160,
  "thumbnailPixelHeight": 90
}
```

**Usage Notes:**
- The `timestamp` field enables synchronization between multiple streams by allowing the calculation of time offsets between when different streams started recording.
- The `thumbnailSprite` should contain thumbnails at regular intervals arranged horizontally in a single row, with each thumbnail exactly `thumbnailPixelWidth` pixels wide.
- The scrubber uses these timestamps to calculate video offsets and display the correct thumbnail from each video's timeline when hovering over the unified timeline.
- Thumbnail dimensions can vary between local and remote videos, allowing for different quality/size configurations per stream.

## Event Handling

### Overview
CrossStream uses a **single, centralized event bus** powered by the `mitt` library. All components publish and subscribe to events exclusively through this `EventBus` instance. There are **no direct callback props** or bespoke event arrays inside components anymore.

### Event Flow

1. **User Interactions**
   - UI elements capture user input (clicks, drags, etc.).
   - Handlers in `UI.js` emit semantic events on the **EventBus** such as `localPlay`, `localPause`, `localSeek`, and `localSeekRelative`.

2. **Player Commands**
   - `DualVideoPlayer` listens for these command events and invokes the appropriate actions (`play`, `pause`, `seek*`).

3. **State Updates**
   - `DualVideoPlayer` emits playback state and timeline updates (`stateChange`, `timeUpdate`) on the **EventBus**. `playhead` is always expressed in seconds.
   - UI components and any other interested module subscribe to these events to keep the interface in sync.

### Core Bus Events

#### Remote Commands (sent between peers)
These commands are sent via the WebRTC data channel and trigger corresponding events on the remote peer.

| Event | Emitted By | Payload | Purpose |
|-------|------------|---------|---------|
| `playIntent` | SynchronizationEngine | `{ type: 'playIntent', playhead: number }` | Request to start playback at specific position |
| `playReady` | SynchronizationEngine | `{ type: 'playReady', playhead: number }` | Response to `playIntent` when ready to play |
| `playNotReady` | SynchronizationEngine | `{ type: 'playNotReady', playhead: number }` | Response to `playIntent` when not ready to play |
| `pauseIntent` | SynchronizationEngine | `{ type: 'pauseIntent', playhead: number }` | Request to pause playback |
| `seekIntent` | SynchronizationEngine | `{ type: 'seekIntent', playhead: number }` | Request to seek to specific position |
| `seekComplete` | SynchronizationEngine | `{ type: 'seekComplete', playhead: number }` | Sent after completing a seek operation, indicates the final playhead position |
| `bufferingStarted` | SynchronizationEngine | `{ type: 'bufferingStarted' }` | Notification that buffering started |
| `bufferingComplete` | SynchronizationEngine | `{ type: 'bufferingComplete' }` | Notification that buffering completed |
| `audioChange` | SynchronizationEngine | `{ type: 'audioChange', track: 'local'\|'remote'\|'none' }` | Audio source changed |

#### Command Flow Examples

1. **Playback Start**
   - Peer A: `playIntent @10.5s` → Peer B
   - Peer B: `playReady @10.5s` → Peer A
   - Both peers start playback

2. **Seek Operation**
   - Peer A: `seekIntent @30.0s` → Peer B
   - Peer B seeks to 30.0s
   - Peer B: `seekComplete @30.0s` → Peer A
   - Both peers are now paused at 30.0s

3. **Buffering**
   - Peer A: `bufferingStarted` → Peer B
   - Peer B pauses playback
   - Peer A: `bufferingComplete` → Peer B
   - Playback resumes when both peers are ready

#### Internal Bus Events
These events are used for communication within the same browser context.

| Event | Emitted By | Payload | Purpose |
|-------|------------|---------|---------|
| `localPlay` | UI | *none* | User pressed play |
| `localPause` | UI | *none* | User pressed pause |
| `localSeek` | UI/Scrubber | `playhead` (seconds) | Absolute seek |
| `localSeekRelative` | UI | `delta` (seconds) | Relative seek (± seconds) |
| `localAudioChange` | UI | `track` ('local'\|'remote'\|'none') | Audio track change |
| `stateChange` | DualVideoPlayer | `{ state: string, playhead: number, duration: number, audioSource: string }` | Playback state changed |
| `syncStateChanged` | SynchronizationEngine | `{ state: 'paused'\|'buffering'\|'pendingPlay'\|'playing'\|'pendingSeek', playhead?: number, bufferingVideos?: string[] }` | Sync state changed |
| `timeUpdate` | DualVideoPlayer | `{ playhead: number, duration: number }` | Playhead position update |
| `playersInitialized` | DualVideoPlayer | `{ playhead: number, duration: number, localConfig: Object, remoteConfig: Object }` | Both players ready |
| `uiPulse` | Various | `{ elementId: string }` | Highlight UI element |
| `bufferingStarted` | DualVideoPlayer | `{ videos: string[] }` | Video buffering started |
| `bufferingComplete` | DualVideoPlayer | *none* | Buffering completed |
| `peerDisconnected` | PeerConnection | *none* | Graceful peer disconnect |
| `peerTerminated` | PeerConnection | `Error` | Unexpected peer disconnect |

### State Change Flow

#### `stateChange` vs `syncStateChanged`

- **stateChange** (DualVideoPlayer):
  - Tracks actual video element states (playing/paused)
  - Used for UI updates and local state management
  - More frequent updates during playback
  - Example: `{ state: 'playing', playhead: 123, duration: 3600, audioSource: 'local' }`

- **syncStateChanged** (SynchronizationEngine):
  - Tracks synchronization state between peers
  - Used for coordination and handshaking
  - Changes only on state transitions
  - Example: `{ state: 'pendingPlay', playhead: 123 }`

#### Typical Flow:
1. User clicks play → `localPlay` event
2. If buffering needed → `syncState` becomes 'buffering'
3. When ready → `syncState` becomes 'pendingPlay', send `playIntent`
4. Remote responds → `syncState` becomes 'playing', send `playReady`
5. Both peers → `stateChange` to 'playing'

All new functionality must use these bus events; legacy callback fields have been removed.

## UI Subsystem

### Overview
The UI subsystem manages all user interface elements and interactions, serving as the view layer of the application. It's responsible for rendering the current state and forwarding user actions to the player controller.

### Key Components

1. **UI Class**
   - Manages all DOM elements and their lifecycle
   - Handles UI state (loading, error states, etc.)
   - Coordinates with the Scrubber component
   - Handles all user input events

2. **Scrubber Component**
   - Handles timeline scrubbing and preview with unified timeline support
   - Manages dual thumbnail display with video offset compensation
   - Provides click-to-seek functionality (no dragging)
   - Displays timeline markers with magnetic hover labels
   - Constructed with `(domElement, localConfig, remoteConfig, markerTimes)`
   - Automatically calculates video offsets based on timestamps
   - Shows thumbnails from both videos at correct timeline positions
   - Handles edge cases (before/after video content) with grayed thumbnails
   - Prevents thumbnail viewport overflow with intelligent repositioning
   - All interactions emit `localPause` followed by `localSeek` events
   
   **Key Features:**
   - **Video Offset Handling**: Calculates time offsets between local and remote videos based on their timestamps, ensuring thumbnails show the correct frame from each video's timeline
   - **Stepped Thumbnail Selection**: Snaps to complete thumbnail frames (no partial thumbnails) for crisp preview images
   - **Dual Thumbnail Preview**: Shows both local and remote video thumbnails simultaneously on hover, positioned diagonally from the mouse cursor
   - **Edge Case Management**: When hovering before a video starts or after it ends, displays the first/last thumbnail with reduced opacity (0.3) for visual feedback
   - **Timeline Markers**: Supports configurable timeline markers with magnetic hover detection (20px range) and formatted time labels
   - **Viewport Protection**: Automatically repositions thumbnails to prevent overflow at screen edges while maintaining relative spacing
   - **Config-Driven Sizing**: Uses individual thumbnail dimensions from each video's configuration for proper aspect ratios

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

Audio toggle controls are provided:

| Element | ID | Event Emitted |
|---------|----|---------------|
| Local audio button | `audioLocalButton` | `localAudioChange` `'local'` |
| Remote audio button | `audioRemoteButton` | `localAudioChange` `'remote'` |

Mute behaviour: Deselecting the currently active audio button emits `localAudioChange` with `'none'`, effectively muting all audio.

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

## DualVideoPlayer

### Buffer Monitoring
The DualVideoPlayer implements comprehensive buffer monitoring to support synchronized buffering between peers:

**Enhanced Readiness Detection:**
- Monitors video `readyState` and buffered ranges for both local and remote videos
- Emits `localVideoBuffered`/`localVideoUnbuffered` and `remoteVideoBuffered`/`remoteVideoUnbuffered` events when buffer state changes
- Listens to additional video events: `waiting`, `canplaythrough`, `stalled` for more responsive buffer detection

**Playback Buffer Monitoring:**
- During `playing` state, continuously monitors buffer health every 500ms
- Detects when videos run out of buffer during playback (insufficient lookahead)
- Emits `bufferingStarted` events when buffer depletion occurs
- Emits `bufferingComplete` events when buffer is restored
- Uses 2-second lookahead buffer requirement for smooth playback

**Buffer State Tracking:**
- Maintains `#lastBufferCheck` state to detect buffer state transitions
- Only emits events when buffer state actually changes (avoids spam)
- Provides granular per-video buffer status for coordination logic

**Integration with Synchronization:**
These buffer events enable the SynchronizationEngine to:
- Coordinate play intent handshakes based on actual buffer readiness
- Pause both peers when either runs out of buffer during playback
- Resume synchronized playback once buffering is complete
- Provide accurate UI feedback about buffering state

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

### PeerConnection

#### Host/Client Role Negotiation & Reconnection Algorithm

- On startup, a peer attempts to connect as a **client** (random ID) to the session ID.
- If connection fails (no host found), it attempts to become the **host** (using the session ID as its own ID).
- If hosting fails due to 'ID is taken', it retries as a client.
- If a connection is gracefully closed (`peerDisconnected`), the peer re-enters the connection establishment flow (tries to reconnect or self-host).
- All terminology uses 'host' and 'client'.
- Concise logging is performed for all connection attempts, role changes, and disconnects (using `[Peer] ...` prefix).
- Event emission (`peerDisconnected`, `peerTerminated`, etc.) reflects connection lifecycle and is used by the UI/Core for cleanup and user feedback.

The PeerConnection handles peer discovery and communication between different client instances in a peer-to-peer fashion. It uses the Peer.js library to establish WebRTC data channels between clients, enabling real-time synchronization of video playback states.

**Responsibilities:**
- Establish and manage WebRTC peer connections within a session
- Exchange stream configurations between peers
- Relay playback commands (play, pause, seek, audioChange) between connected clients
- Handle connection lifecycle and error scenarios
- Manage resource cleanup on disconnection

**Connection States:**
- `connecting`: Attempting to establish connection
- `connected`: Active WebRTC connection established
- `disconnected`: No active connection
- `error`: Connection error state

**Core Methods:**
- `constructor(sessionId, localConfig)`: Initializes and connects to a peer-to-peer session using the given session ID and local stream configuration.
  - All communication between PeerConnection and other modules is handled via EventBus events (see Event Handling section), not via callbacks or direct function references.
- `disconnect()`: Closes all connections and cleans up resources.
- `sendCommand(command)`: Sends a playback command to the connected peer.

**Command Payload:**
```jsonc
{
  "type": "command",
  "command": {
    "type": "play" | "pause" | "seek" | "audioChange",   // operation
    "playhead": number,               // current playhead position
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


### DualVideoPlayer

The DualVideoPlayer is responsible for maintaining frame-accurate synchronization between a set of video players on the local peer. An instance is created when multiple video sources are registered, taking local and remote stream configurations as parameters.

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
- `play()`: Starts playback of all synchronized players. Throws if any player is not ready
- `pause()`: Pauses playback of all synchronized players
- `seek(playhead)`: Seeks the set of players to a unified timeline position (seconds)
- `switchAudio(source)`: Switches audio between 'local' and 'remote' players, or mutes audio
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


### Synchronization Engine

The **Synchronization Engine** is the top-level component that ensures two *sets* of video players—one local set on each peer—remain in **rough synchronization** across a peer-to-peer connection.

**Responsibilities**

* Maintain unified playback state (play/pause, unified playhead) across peers while tolerating small timing skew.
* Propagate all user actions (play, pause, seek, rewind/fast-forward, audioChange) to the remote peer via `PeerConnection`.
* Resolve conflicting concurrent commands deterministically using vector clocks (implemented in `PeerConnection`).
* Delegate *in-browser* frame-accurate sync to `DualVideoPlayer` on each peer.

**Design Principles**

* *Peer Equality*: Both peers are equal—no master/slave. Any peer can initiate playback operations, and both must respond to incoming commands.
* *Event Propagation*: All playback-affecting user actions (play, pause, seek, audio change, rewind/fast-forward) are immediately propagated to the other peer.
* *Loose Consistency*: The goal is not perfect frame-accurate sync, but to keep both sides in the same logical state (playing/paused/position), tolerating minor network delays and conflicts.
* *Conflict Resolution*: When conflicting commands occur (e.g., both pause and play at the same time), the system resolves to a single, shared state. Which state is chosen is less important than both peers ending up in the same state.

## Synchronization Engine

### Overview
The SynchronizationEngine coordinates playback between local and remote video players by translating user interactions into synchronized commands and handling incoming remote commands. Each peer maintains its own local state and reacts to remote events to achieve synchronized playback.

### Local Synchronization States
Each peer maintains its own local state. States describe only the local situation and drive local behavior based on local conditions and remote events:

* **`paused`**: Local videos are stopped. No play intent exists. This is the initial state.
* **`buffering`**: Local videos are loading/buffering content and are not ready for playback (readyState < 3).
* **`pendingPlay`**: Local user wants to play, local videos are buffered and ready, but waiting for remote peer confirmation before starting playback.
* **`playing`**: Local videos are actively playing. Playback was started after both local readiness and remote confirmation.
* **`pendingSeek`**: Local user initiated a seek, local videos are seeking to target position, waiting for remote peer to confirm seek completion.

### State Transitions
State transitions are triggered by local events (user actions, video readiness changes) and remote events:

**From `paused`:**
- User presses play → `pendingPlay` (if local videos ready) or `buffering` (if not ready)
- User seeks → `pendingSeek`
- Remote `playIntent` received → remain `paused`, send `playNotReady` if not buffered, or `playReady` if buffered

**From `buffering`:**
- Local videos become ready → `pendingPlay` (if play was intended) or `paused`
- Remote `playIntent` received → send `playNotReady`

**From `pendingPlay`:**
- Remote `playReady` received → `playing` (start local playback)
- Remote `playNotReady` received → remain `pendingPlay`
- User cancels (pause) → `paused`, send `pauseIntent`
- Local videos lose buffer → `buffering`, send `bufferingStarted`

**From `playing`:**
- User pauses → `paused`, send `pauseIntent`
- User seeks → `pendingSeek`, send `seekIntent`
- Local videos run out of buffer → `buffering`, send `bufferingStarted`
- Remote `pauseIntent` received → `paused`
- Remote `seekIntent` received → `pendingSeek`
- Remote `bufferingStarted` received → `paused` (wait for remote to be ready)

**From `pendingSeek`:**
- Local seek complete and videos ready → `pendingPlay`, send `seekComplete`
- Remote `seekComplete` received → `playing` (if local also ready)

### Remote Events
The following remote events enable coordination between peers:

* **`playIntent`**: Remote peer wants to start playing at specified playhead position
* **`playReady`**: Remote peer is buffered and ready to start playing at specified position
* **`playNotReady`**: Remote peer is not ready (still buffering) for playback at specified position
* **`pauseIntent`**: Remote peer user explicitly paused playback
* **`seekIntent`**: Remote peer user wants to seek to specified position
* **`seekComplete`**: Remote peer has completed seeking and is ready at new position
* **`bufferingStarted`**: Remote peer ran out of buffer during playback
* **`bufferingComplete`**: Remote peer finished buffering and is ready to resume
* **`audioChange`**: Remote peer changed audio track selection

### Command Flow Examples

**Play Intent Handshake:**
1. Local user presses play → Local state: `pendingPlay`, send `playIntent` with target playhead
2. Remote peer receives `playIntent`:
   - If remote videos ready → send `playReady`, remote state: `playing`
   - If remote videos not ready → send `playNotReady`, remote state: `buffering`
3. Local peer receives `playReady` → Local state: `playing` (start playback)

**Buffering During Playback:**
1. During `playing`, local videos run out of buffer → Local state: `buffering`, send `bufferingStarted`
2. Remote peer receives `bufferingStarted` → Remote state: `paused` (pause playback)
3. Local buffering completes → Local state: `pendingPlay`, send `bufferingComplete`
4. Remote peer receives `bufferingComplete` → Remote state: `playing` (resume playback)

**Explicit Pause vs Seek:**
- User pause → send `pauseIntent`, both peers go to `paused`
- User seek → send `seekIntent` with target position, both peers go to `pendingSeek`, then coordinate resumption

### UI State Mapping
Synchronization states are reflected in the UI to provide clear feedback to users:

**Play/Pause Button States:**
- **`paused`**: Shows play symbol (▶️)
- **`playing`**: Shows pause symbol (⏸️) 
- **`buffering`**, **`pendingPlay`**, **`pendingSeek`**: Shows loading spinner

**Remote Readiness Indicator:**
- When local state is `pendingPlay` (local ready, waiting for remote): Show subtle indicator that remote peer is not ready
- When both peers are ready: No special indicator needed
- When local is not ready (`buffering`): No need to show remote status

**Remote Event Feedback:**
Incoming remote events trigger brief UI animations to indicate peer activity:
- **Remote pause/play**: Play/pause button pulses/flashes
- **Remote seek**: Playhead time display and scrubber pulse/flash
- **Remote audio change**: Corresponding audio button pulses
- **Remote buffering**: Loading indicator appears briefly

These animations help users understand when their peer is taking actions vs. when they are taking actions themselves.

### Unified Playhead Edge Cases
The unified timeline may contain positions where only one video has content:

**Single Video Active Playback:**
- When unified playhead is positioned where only one video has frames, playback continues with just that video
- The inactive video remains paused/hidden at its boundary position
- Synchronization states and peer coordination continue normally

**Automatic Second Video Join:**
- During `playing` state, when playhead reaches the start time of the previously inactive video:
  - Second video automatically starts playing in sync
  - No additional peer coordination needed (both peers calculate this transition locally)
  - Smooth transition maintains synchronized playback

**State Sufficiency:**
The current state model supports these edge cases:
- `playing` state handles both single-video and dual-video playback
- Local timeline calculations determine when videos should be active
- Peer coordination remains consistent regardless of video activity
- Buffering states apply independently to each video as needed

**Handling Simultaneous Commands**:

* If both peers send conflicting commands at nearly the same time, each peer uses the **vector clock** comparison; if the clocks are concurrent, the command with the lexicographically smaller `senderId` wins (deterministic tie-break).

**UX Considerations**

* Always prioritize a smooth experience over perfect sync. Minor delays or differences are acceptable if they avoid jarring jumps or freezes.
* Allow for leeway in sync (e.g., up to a few hundred milliseconds) to absorb network jitter.

**Causal Ordering with Vector Clocks**

`PeerConnection` now stamps every outgoing command with an incremented vector clock (`clock`) and `senderId`. On receipt, the remote side compares the incoming clock with the last-applied clock:

* **happens-before** → apply newer command
* **concurrent** → tie-break via `senderId`

The winning command is emitted on the global `EventBus` with event names prefixed by `remote` (e.g., `remotePlay`, `remotePauseSeek`, `remoteAudioChange`). The **Synchronization Engine** listens to these events to update local playback state accordingly.


## Backend Architecture

The backend provides HLS video streaming, transcoding services, and a TUI for monitoring. The architecture follows a clean separation of concerns with centralized error handling and minimal exception catching.

### Core Components

#### host.py - Application Orchestrator
**Responsibilities:**
- Application entry point and argument parsing
- Central exception handling for the entire application
- Stream redirection management using `StreamRedirection` context manager
- ServiceOrchestrator lifecycle management
- TUI initialization and error display

**Key Features:**
- **Central Error Handling**: Single point for catching and displaying fatal errors
- **Stream Redirection**: Captures stdout/stderr to queues for TUI display while preserving original streams for error output
- **Clean Shutdown**: Ensures proper cleanup of all services and stream restoration
- **Terminal Reset**: Automatic terminal state restoration on exit

#### service_orchestrator.py - Backend Service Manager
**Responsibilities:**
- Backend service lifecycle management (Flask server, transcoder)
- Thread coordination and management
- Log processing and UI widget updates
- Business logic for status parsing and segment map rendering

**Key Components:**
- **ServiceOrchestrator Class**: Main orchestration class
- **parse_status_update_log()**: Parses transcoder status updates for segment map display
- **render_segment_map()**: Renders colored segment maps using Rich markup

**Service Management:**
- Flask server thread with logging capture
- Transcoder output capture thread
- VideoManager initialization with output redirection
- Log draining and UI widget updates

**Design Principles:**
- **Minimal Exception Handling**: Exceptions bubble up to host.py for central handling
- **Clean Thread Management**: Proper thread lifecycle and cleanup
- **UI Separation**: No UI logic, only provides data to TUI widgets

#### tui.py - Terminal User Interface
**Responsibilities:**
- Pure UI layer for displaying logs and segment maps
- Widget management and layout
- User interaction handling (quit command)

**Key Features:**
- **Pure UI Focus**: No business logic, error handling, or service management
- **Widget Configuration**: Proper RichLog setup with markup support for colored segments
- **Minimal Codebase**: Reduced from 400+ lines to ~140 lines
- **Clean Imports**: Only imports what it actually uses (Textual components)

**UI Layout:**
- Backend Log: Flask server and application logs
- Transcoder Log: FFmpeg transcoder output
- Segment Map: Colored visualization of video segments
- Stats Line: Real-time transcoding statistics

#### web.py - Flask Application
**Responsibilities:**
- HTTP server for video streaming
- API endpoints for video access
- Static file serving

**Separation from Host:**
- Moved from host.py for better modularity
- Independent Flask app configuration
- Clean separation of web concerns from orchestration

### Data Flow

#### Backend Service Startup
1. `host.py` parses arguments and creates ServiceOrchestrator
2. ServiceOrchestrator initializes VideoManager with output capture
3. Flask server starts in background thread with logging capture
4. Transcoder starts with output capture to internal queue
5. TUI initializes and connects to ServiceOrchestrator for log draining

#### Log Processing Flow
1. Backend services (Flask, transcoder, print statements) output to queues
2. ServiceOrchestrator drains queues periodically (100ms intervals)
3. Flask logs: ANSI colors stripped, formatted, sent to Backend Log widget
4. Transcoder logs: Status updates parsed for segment map, regular logs sent to Transcoder Log widget
5. Segment map updates: Colored segments rendered and displayed
6. Stats updates: Real-time statistics displayed in stats line

#### Error Handling Flow
1. Exceptions in backend services bubble up (no broad catching)
2. Fatal errors caught in host.py main function
3. Stream redirection ensures error output goes to real console
4. TUI shutdown displays errors after terminal restoration
5. Clean application exit with proper resource cleanup

### Queue Management

#### output_log_queue
- **Purpose**: Unified log collection from all backend sources
- **Sources**: Flask logs, print statements, VideoManager output, error messages
- **Processing**: ANSI color stripping, formatting, display in Backend Log
- **Thread Safety**: Queue-based communication between threads

#### _transcoder_queue (Internal)
- **Purpose**: Transcoder-specific output processing
- **Sources**: FFmpeg stdout/stderr
- **Processing**: Status update detection, segment map parsing, regular log display
- **Special Handling**: Status updates trigger segment map and stats updates

### Architecture Principles

#### Clean Separation of Concerns
- **host.py**: Orchestration and error handling only
- **service_orchestrator.py**: Backend service management and business logic
- **tui.py**: Pure UI with no business logic or error handling
- **web.py**: HTTP server concerns only

#### Minimal Exception Handling
- Exceptions bubble up to central handler in host.py
- No broad `except Exception` blocks in service layers
- Clean error propagation and visibility
- Fatal errors cause clean application exit

#### Thread Safety
- Queue-based communication between threads
- Proper thread lifecycle management
- Clean shutdown coordination
- No shared mutable state between threads

## Data Flow

### UI Data Flow
1. User interacts with UI controls (play/pause, seek, etc.)
2. UI translates interactions into player commands
3. Commands are executed on the DualVideoPlayer
4. Player state changes trigger UI updates
5. UI reflects the current state (play/pause button, time display, etc.)

### Scrubber Data Flow
1. User hovers over the timeline
2. Scrubber updates preview thumbnail and position
3. User clicks/drags to seek
4. Scrubber calculates target time and triggers seek
5. DualVideoPlayer updates playback position
6. UI updates to reflect the new position

### Cross-Component Communication
- UI and Scrubber communicate through the DualVideoPlayer
- All state changes flow through the DualVideoPlayer
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

## Developer Logging Tips

* Filter the browser console for the text `"SYNC"` to see concise peer-connection messages (`[SYNC IN]`, `[SYNC OUT]`, `[SYNC WARN]`).
* Enable the **Verbose** log level (console filter dropdown) to view all EventBus traffic; each bus emission is prefixed with `[EventBus]`.
* Use console search (`Ctrl+F`) with terms like `remotePauseSeek` or `vector clock` to inspect specific synchronisation events.