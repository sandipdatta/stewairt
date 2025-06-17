/**
 * app.js: Integrates the ADK streaming logic with the Purecode AI Avatar.
 * This version includes the fix for displaying subtitles in audio mode.
 */

// Import audio worklet starters
import { startAudioPlayerWorklet } from "./audio-player.js";
import { startAudioRecorderWorklet, stopMicrophone } from "./audio-recorder.js";

// --- Global State ---
let currentSessionId = null; // This will hold the unique ID for the current active session
const SSE_BASE_URL = `http://${window.location.host}/events/`; // Base URL for SSE
const SEND_BASE_URL = `http://${window.location.host}/send/`; // Base URL for sending messages
let eventSource = null;
let isAudioMode = false; // This will be true only when connected and expecting audio interactions
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

// --- Avatar State Management ---
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
};


function showSubtitle(text) {
    subtitle.textContent = text;
    subtitle.classList.toggle('opacity-0', !text);
}

// --- SSE (Server-Sent Events) Handling ---
function connectSSE() {
    if (eventSource) eventSource.close(); // Close existing connection if any

    // Use the newly generated currentSessionId for the SSE URL
    eventSource = new EventSource(`${SSE_BASE_URL}${currentSessionId}?is_audio=${isAudioMode}`);

    eventSource.onopen = () => {
        console.log(`SSE connection opened for session ${currentSessionId}. Audio mode: ${isAudioMode}`);
        isNewAgentResponse = true; // Reset for the welcome message
    };

    eventSource.onmessage = handleServerMessage;

    eventSource.onerror = () => {
        console.error("SSE connection error or closed.");
        // If an error occurs, and we were connected, try to reset to disconnected state.
        if (isConnected) {
            handleDisconnect(); // Treat error as an unplanned disconnect
        }
    };
}

function handleServerMessage(event) {
    const message = JSON.parse(event.data);
    console.log("[AGENT TO CLIENT]", message);
    if (isConnected) { // Only process if still connected
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
            // Check if this is the start of a new response and clear old text.
            if (isNewAgentResponse) {
                currentAgentSubtitle = "";
                isNewAgentResponse = false;
            }
            currentAgentSubtitle += message.data;
            showSubtitle(currentAgentSubtitle);
        }
    }
}

// --- User Interaction Handlers ---
function handleAudioButtonClick() {
    if (!isConnected) {
        // CONNECT logic (restored)
        currentSessionId = Math.random().toString(36).substring(2, 12); // Generate a new, unique session ID
        console.log("New session ID generated:", currentSessionId);

        isConnected = true;
        isAudioMode = true; // Enable audio mode for SSE and audio streams
        startAudio(); // Start audio player and recorder
        connectSSE(); // Establish SSE connection using the new ID

        audioButton.classList.remove('bg-gray-600', 'hover:bg-gray-700');
        audioButton.classList.add('bg-red-600', 'hover:bg-red-500'); // Change button to red
        setAvatarState('listening'); // Go directly to listening once connected
        showSubtitle("I am StewAIrt, your AI Innovation & Risk Strategist. How can I help?");
    } else {
        // DISCONNECT logic (existing)
        handleDisconnect();
    }
}

function handleDisconnect() {
    isConnected = false;
    isAudioMode = false; // Disable audio mode
    stopAudio(); // Stop audio (microphone, player)
    if (eventSource) {
        eventSource.close(); // Close SSE connection
        eventSource = null;
    }
    currentSessionId = null; // Clear the session ID
    audioButton.classList.remove('bg-red-600', 'hover:bg-red-500');
    audioButton.classList.add('bg-gray-600', 'hover:bg-gray-700'); // Change button back to gray
    setAvatarState('idle'); // Set avatar to idle
    showSubtitle("Click the microphone to connect.");
    console.log("Disconnected from StewAIrt.");
}

// --- Network Communication ---
async function sendMessage(message) {
    // Ensure we have a currentSessionId before attempting to send
    if (!isConnected || !currentSessionId) {
        console.warn("Attempted to send message while disconnected or no session ID.");
        return;
    }
    try {
        // Use the currentSessionId in the SEND URL
        const response = await fetch(`${SEND_BASE_URL}${currentSessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
        });
        if (!response.ok) console.error('Failed to send message:', response.statusText);
    } catch (error) {
        console.error('Error sending message:', error);
        handleDisconnect(); // If sending fails, assume disconnection
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
    if (!isConnected) return; // Only buffer if connected
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
    
    // Use currentSessionId for sending audio data
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