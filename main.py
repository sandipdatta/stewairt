# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import os
import json
import asyncio
import base64
import warnings

from pathlib import Path
from dotenv import load_dotenv

from google.genai.types import (
    Part,
    Content,
    Blob,
)

from google.adk.runners import InMemoryRunner
from google.adk.agents import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from stewAIrt.agent import root_agent

warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

#
# ADK Streaming (WebSocket)
#

# Load Gemini API Key / Vertex AI configuration
load_dotenv()

APP_NAME = "ADK Streaming example"

global_runner = InMemoryRunner(
    app_name=APP_NAME,
    agent=root_agent,
)

async def start_agent_session(user_id: str, is_audio: bool = False):
    """Starts an agent session using the globally persistent runner."""

    session = await global_runner.session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
    )

    # >>> MODIFIED LINE HERE <<<
    # Set response modalities:
    # If audio is requested, include ONLY AUDIO.
    # Otherwise, ONLY TEXT.
    # This is a diagnostic step to resolve "invalid argument" error.
    response_modalities = []
    if is_audio:
        response_modalities.append("AUDIO")
    else: # If not audio mode (e.g., if we were to introduce text input again)
        response_modalities.append("TEXT")
    # >>> END MODIFIED LINE <<<

    run_config = RunConfig(
        response_modalities=response_modalities,
        streaming_mode=StreamingMode.SSE, # Still use SSE internally for Live API streaming
    )

    live_request_queue = LiveRequestQueue()

    live_events = global_runner.run_live(
        session=session,
        live_request_queue=live_request_queue,
        run_config=run_config,
    )
    return live_events, live_request_queue

async def agent_to_client_messaging(websocket: WebSocket, live_events):
    """Agent to client communication via WebSocket"""
    try:
        async for event in live_events:
            if event.turn_complete or event.interrupted:
                message = {
                    "turn_complete": event.turn_complete,
                    "interrupted": event.interrupted,
                }
                await websocket.send_text(json.dumps(message))
                print(f"[AGENT TO CLIENT]: {message}")

            if event.content and event.content.parts:
                for part_index, part in enumerate(event.content.parts):
                    if part.inline_data and part.inline_data.mime_type.startswith("audio/pcm"):
                        audio_data = part.inline_data and part.inline_data.data
                        if audio_data:
                            message = {
                                "mime_type": "audio/pcm",
                                "data": base64.b64encode(audio_data).decode("ascii")
                            }
                            await websocket.send_text(json.dumps(message))
                            print(f"[AGENT TO CLIENT]: audio/pcm: {len(audio_data)} bytes. Event partial: {event.partial}")
                    elif part.text: # Changed from 'part.text and event.partial' to just 'part.text'
                        # We are sending TEXT if it exists, regardless of partial for subtitles.
                        # However, for this diagnostic step, response_modalities will exclude TEXT
                        # when is_audio is true. So this block should not be hit.
                        message = {
                            "mime_type": "text/plain",
                            "data": part.text
                        }
                        await websocket.send_text(json.dumps(message))
                        print(f"[AGENT TO CLIENT]: text/plain: '{part.text}'. Event partial: {event.partial}")
                    elif part.inline_data:
                        print(f"[AGENT TO CLIENT]: Unexpected inline_data mime_type: {part.inline_data.mime_type} in event {event.event_id}. Part Index: {part_index}")
                    elif part.function_call:
                        print(f"[AGENT TO CLIENT]: Function call part found: {part.function_call} in event {event.event_id}. Part Index: {part_index}")
                    elif part.function_response:
                        print(f"[AGENT TO CLIENT]: Function response part found: {part.function_response} in event {event.event_id}. Part Index: {part_index}")
                    else:
                        print(f"[AGENT TO CLIENT]: Unhandled part type in event {event.event_id}. Part Index: {part_index}. Part: {part}")
            elif event.content:
                print(f"[AGENT TO CLIENT]: Event content has no discernible parts: {event.content} in event {event.event_id}")
    except Exception as e:
        print(f"Error in agent_to_client_messaging: {e}")
        raise WebSocketDisconnect(code=1011, reason=f"Server-side error: {e}")

async def client_to_agent_messaging(websocket: WebSocket, live_request_queue: LiveRequestQueue):
    """Client to agent communication via WebSocket"""
    try:
        while True:
            message_json = await websocket.receive_text()
            message = json.loads(message_json)
            mime_type = message.get("mime_type")
            data = message.get("data")

            if mime_type == "text/plain":
                content = Content(role="user", parts=[Part.from_text(text=data)])
                live_request_queue.send_content(content=content)
                print(f"[CLIENT TO AGENT]: {data}")
            elif mime_type == "audio/pcm":
                decoded_data = base64.b64decode(data)
                live_request_queue.send_realtime(Blob(data=decoded_data, mime_type=mime_type))
                print(f"[CLIENT TO AGENT]: audio/pcm: {len(decoded_data)} bytes")
            else:
                print(f"[CLIENT TO AGENT]: Mime type not supported: {mime_type}")
                await websocket.send_text(json.dumps({"error": f"Mime type not supported: {mime_type}"}))

    except WebSocketDisconnect:
        print("Client disconnected from websocket.")
    except Exception as e:
        print(f"Error in client_to_agent_messaging: {e}")
        raise WebSocketDisconnect(code=1011, reason=f"Client-side processing error: {e}")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path("static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def root():
    """Serves the index.html"""
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str, is_audio: str = "false"):
    """Client websocket endpoint for real-time communication"""
    live_request_queue: LiveRequestQueue = None

    try:
        await websocket.accept()
        print(f"Client #{user_id} connected, audio mode: {is_audio}")

        live_events, live_request_queue = await start_agent_session(user_id, is_audio == "true")

        agent_to_client_task = asyncio.create_task(
            agent_to_client_messaging(websocket, live_events)
        )
        client_to_agent_task = asyncio.create_task(
            client_to_agent_messaging(websocket, live_request_queue)
        )

        done, pending = await asyncio.wait(
            [agent_to_client_task, client_to_agent_task],
            return_when=asyncio.FIRST_COMPLETED
        )

        for task in done:
            if task.exception():
                print(f"Task completed with exception: {task.exception()}")
                raise task.exception()

    except WebSocketDisconnect:
        print(f"Client #{user_id} disconnected from websocket.")
    except Exception as e:
        print(f"An unexpected error occurred for client #{user_id}: {e}")
    finally:
        if live_request_queue:
            live_request_queue.close()
            print(f"LiveRequestQueue for client #{user_id} closed.")

        if 'agent_to_client_task' in locals() and not agent_to_client_task.done():
            agent_to_client_task.cancel()
            await asyncio.sleep(0.1)
        if 'client_to_agent_task' in locals() and not client_to_agent_task.done():
            client_to_agent_task.cancel()
            await asyncio.sleep(0.1)

        print(f"Client #{user_id} connection fully closed.")
