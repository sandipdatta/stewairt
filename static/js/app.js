/**
 * app.js: Integrates the ADK streaming logic with the Purecode AI Avatar.
 * This version uses WebSockets for real-time, bidirectional communication.
 */

// Import audio worklet starters
import { startAudioPlayerWorklet } from "./audio-player.js";
import { startAudioRecorderWorklet, stopMicrophone } from "./audio-recorder.js";

// --- Global State ---
let currentSessionId = null; // This will hold the unique ID for the current active session
// Use ws:// for WebSocket. If deploying to HTTPS, use wss://

// MODIFIED: Dynamically determine WebSocket protocol based on page protocol
let wsProtocol = 'ws://';
if (window.location.protocol === 'https:') {
    wsProtocol = 'wss://';
}
// IMPORTANT: Ensure this line is exactly as shown, no extra HTML/Markdown tags.
const WS_BASE_URL = `${wsProtocol}${window.location.host}/ws/`;
let websocket = null; // The WebSocket instance
let isAudioMode = false; // True when connected and expecting audio interactions
let currentAgentSubtitle = "";
let isNewAgentResponse = true; // Flag to track a new response from the agent.

// Audio state
let audioPlayerNode;
let audioRecorderNode;
let micStream; // To store the MediaStream object for stopping the microphone
let audioBuffer = [];
let bufferTimer = null;
let isRecording = false; // Indicates if microphone is actively recording
let isConnected = false; // Overall connection state of the app

// --- DOM Element References ---
const audioButton = document.getElementById("audioButton");
const subtitle = document.getElementById("subtitle");

// --- Avatar State Management --
const avatarElements = {
    listeningRings: document.getElementById('listening-rings'),
    mouthIdle: document.getElementById('mouth-idle'),
    voiceWaves: document.getElementById('voice-waves'),
    thinkingDots: document.getElementById('thinking-dots'),
};

function setAvatarState(newState) {
    avatarElements.listeningRings.classList.add('hidden');
    avatarElements.mouthIdle.classList.remove('hidden');
    avatarElements.voiceWaves.classList.add('hidden');
    avatarElements.thinkingDots.classList.add('hidden');

    switch (newState) {
        case 'idle': break;
        case 'listening': avatarElements.listeningRings.classList.remove('hidden'); break;
        case 'thinking':
            avatarElements.mouthIdle.classList.add('hidden');
            avatarElements.thinkingDots.classList.remove('hidden');
            break;
        case 'speaking':
            avatarElements.mouthIdle.classList.add('hidden');
            avatarElements.voiceWaves.classList.remove('hidden');
            break;
    }
}

// --- Main Initialization ---
window.onload = () => {
    // Initial state: disconnected
    setAvatarState('idle');
    showSubtitle("Click the microphone to connect.");
    // Ensure button is in 'disconnected' visual state initially
    audioButton.classList.remove('bg-red-600', 'hover:bg-red-500');
    audioButton.classList.add('bg-gray-600', 'hover:bg-gray-700');
    audioButton.addEventListener('click', handleAudioButtonClick);

    // Diagnostic: Add a console log to confirm window.onload and button listener setup
    console.log("App initialized. Audio button listener attached.");
};

function showSubtitle(text) {
    subtitle.textContent = text;
    subtitle.classList.toggle('opacity-0', !text);
}

// --- WebSocket Handling ---
function connectWebSocket() {
    // Diagnostic: Log when connectWebSocket is actually called
    console.log("Attempting to connect WebSocket...");

    // Generate a new session ID for each new connection
    currentSessionId = Math.random().toString(36).substring(2, 12);
    console.log("New session ID generated:", currentSessionId);

    // Determine the WebSocket URL based on audio mode
    const wsUrl = `${WS_BASE_URL}${currentSessionId}?is_audio=${isAudioMode}`;

    // Close any existing WebSocket connection before opening a new one
    if (websocket) {
        websocket.close();
        websocket = null;
    }

    websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
        console.log(`WebSocket connection opened for session ${currentSessionId}. Audio mode: ${isAudioMode}`);
        isConnected = true;
        setAvatarState('listening'); // Go directly to listening once connected
        showSubtitle("I am StewAIrt, your AI Innovation & Risk Strategist. How can I help?");
        isNewAgentResponse = true; // Reset for the welcome message
    };

    websocket.onmessage = handleServerMessage;

    websocket.onclose = () => {
        console.log(`WebSocket connection closed for session ${currentSessionId}.`);
        if (isConnected) { // Only attempt to reset UI if it was previously connected
            handleDisconnect(); // Treat close as a disconnect
        }
    };

    websocket.onerror = (error) => {
        console.error("WebSocket error:", error);
        if (isConnected) { // If an error occurs, ensure disconnect state
            handleDisconnect();
        }
    };
}

function handleServerMessage(event) {
    const message = JSON.parse(event.data);
    console.log("[AGENT TO CLIENT]", message);

    if (!isConnected) return; // Ignore messages if already disconnected

    setAvatarState("speaking");

    if (message.turn_complete) {
        isNewAgentResponse = true; // Mark the end of a response.
        setTimeout(() => {
            showSubtitle("");
            setAvatarState(isAudioMode ? "listening" : "idle"); // If in audio mode, go to listening, else idle
        }, 2500);
        return;
    }

    if (message.interrupted && audioPlayerNode) {
        audioPlayerNode.port.postMessage({ command: "endOfAudio" });
        setAvatarState(isAudioMode ? "listening" : "idle"); // If in audio mode, go to listening, else idle
        isNewAgentResponse = true; // Mark the end of an interrupted response.
        return;
    }

    if (message.mime_type === "audio/pcm" && audioPlayerNode) {
        audioPlayerNode.port.postMessage(base64ToArray(message.data));
    }

    if (message.mime_type === "text/plain") {
        if (isNewAgentResponse) {
            currentAgentSubtitle = "";
            isNewAgentResponse = false;
        }
        currentAgentSubtitle += message.data;
        showSubtitle(currentAgentSubtitle);
    }
}

// --- User Interaction Handlers ---
function handleAudioButtonClick() {
    // Diagnostic: Log when handleAudioButtonClick is called
    console.log("Audio button clicked.");

    if (!isConnected) {
        // CONNECT
        isAudioMode = true; // Always connect in audio mode for this app
        connectWebSocket(); // Establish WebSocket connection
        startAudio(); // Start audio player and recorder (will only activate mic once connected)

        audioButton.classList.remove('bg-gray-600', 'hover:bg-gray-700');
        audioButton.classList.add('bg-red-600', 'hover:bg-red-500'); // Change button to red
    } else {
        // DISCONNECT
        handleDisconnect();
    }
}

function handleDisconnect() {
    isConnected = false;
    isAudioMode = false; // Disable audio mode
    stopAudio(); // Stop audio (microphone, player)
    if (websocket) {
        websocket.close(); // Explicitly close WebSocket
        websocket = null;
    }
    currentSessionId = null; // Clear the session ID
    audioButton.classList.remove('bg-red-600', 'hover:bg-red-500');
    audioButton.classList.add('bg-gray-600', 'hover:bg-gray-700'); // Change button back to gray
    setAvatarState('idle'); // Set avatar to idle
    showSubtitle("Click the microphone to connect.");
    console.log("Disconnected from StewAIrt.");
}

// --- Network Communication (uses WebSocket now) ---
function sendMessage(message) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify(message));
    } else {
        console.warn("WebSocket not open. Message not sent:", message);
        // If websocket is not open, it implies a disconnection.
        // It's good practice to ensure the UI reflects this.
        if (isConnected) {
            handleDisconnect();
        }
    }
}

// --- Audio Handling Logic ---
function startAudio() {
    if (!isRecording) {
        startAudioPlayerWorklet().then(([node]) => audioPlayerNode = node);
        startAudioRecorderWorklet(audioRecorderHandler).then(([node, audioContext, stream]) => {
            audioRecorderNode = node;
            micStream = stream; // Store the mic stream for later stopping
            isRecording = true;
            console.log("Audio recording started.");
        }).catch(error => {
            console.error("Failed to start audio recorder:", error);
            handleDisconnect(); // Fallback to disconnected state on error
        });
    }
}

function stopAudio() {
    if(isRecording) {
        if(audioRecorderNode) {
            audioRecorderNode.disconnect();
            audioRecorderNode = null;
        }
        if (micStream) {
            stopMicrophone(micStream); // Stop the microphone tracks
            micStream = null;
        }
        if (audioPlayerNode) {
            audioPlayerNode.port.postMessage({ command: "endOfAudio" }); // Clear audio player buffer
            audioPlayerNode.disconnect(); // Disconnect player node
            audioPlayerNode = null;
        }
        stopAudioRecording(); // Clears any buffered audio and interval
        isRecording = false;
        console.log("Audio recording and playback stopped.");
    }
}

function audioRecorderHandler(pcmData) {
    if (!isConnected) return; // Only buffer and send if connected
    audioBuffer.push(new Uint8Array(pcmData));
    if (!bufferTimer) {
        bufferTimer = setInterval(sendBufferedAudio, 200);
    }
}

function sendBufferedAudio() {
    if (!isConnected || audioBuffer.length === 0) { // Only send if connected and there's data
        audioBuffer = []; // Clear buffer if not connected
        return;
    }
    let totalLength = audioBuffer.reduce((acc, chunk) => acc + chunk.length, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of audioBuffer) combinedBuffer.set(chunk, offset), offset += chunk.length;
    
    // Use WebSocket to send audio data
    sendMessage({ mime_type: "audio/pcm", data: arrayBufferToBase64(combinedBuffer.buffer) });
    console.log(`[CLIENT TO AGENT] Sent ${combinedBuffer.byteLength} audio bytes.`);
    audioBuffer = [];
}

function stopAudioRecording() {
    if (bufferTimer) clearInterval(bufferTimer), bufferTimer = null;
    if (audioBuffer.length > 0) sendBufferedAudio(); // Send any remaining audio
    audioBuffer = []; // Ensure buffer is cleared
}

// --- Utility Functions ---
function base64ToArray(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
}
