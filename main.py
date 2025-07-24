import os
# Force CPU-only mode for faster-whisper
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["CT2_FORCE_CPU"] = "1"

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import numpy as np
import asyncio
import json
import base64
import wave
import io
import tempfile
import logging
from datetime import datetime
import uuid
import glob
import threading
import time
from collections import defaultdict
import torch
import soundfile as sf
import librosa

# Configure logging
def setup_logging():
    # Create logs directory if it doesn't exist
    os.makedirs("logs", exist_ok=True)
    
    # Configure logging format
    log_format = '%(asctime)s - %(levelname)s - %(message)s'
    date_format = '%Y-%m-%d %H:%M:%S'
    
    # Configure file handler for all logs
    file_handler = logging.FileHandler('logs/audio_processing.log', encoding='utf-8')
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(logging.Formatter(log_format, date_format))
    
    # Configure console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(logging.Formatter(log_format, date_format))
    
    # Configure root logger
    logging.basicConfig(
        level=logging.INFO,
        handlers=[file_handler, console_handler],
        format=log_format,
        datefmt=date_format
    )

# Setup logging
setup_logging()
logger = logging.getLogger(__name__)

def _cleanup_session_files(session_id: str, session_audio_dir: str):
    """Clean up session files and directories"""
    try:
        import shutil
        if os.path.exists(session_audio_dir):
            shutil.rmtree(session_audio_dir)
            logger.info(f"[SESSION {session_id}] Session directory cleaned up: {session_audio_dir}")
        
        # Also clean up any JSON files in audio_files folder for this session
        audio_files_dir = "audio_files"
        if os.path.exists(audio_files_dir):
            session_json_files = glob.glob(os.path.join(audio_files_dir, f"*_{session_id}_*.json"))
            for json_file in session_json_files:
                try:
                    os.remove(json_file)
                    logger.info(f"[SESSION {session_id}] Cleaned up JSON file: {os.path.basename(json_file)}")
                except Exception as e:
                    logger.warning(f"[SESSION {session_id}] Failed to delete JSON file {json_file}: {str(e)}")
        
    except Exception as cleanup_error:
        logger.error(f"[SESSION {session_id}] Error during cleanup: {str(cleanup_error)}")

app = FastAPI(
    title="Whisper Real-time Transcription API",
    description="WebSocket API for real-time audio transcription using faster-whisper model",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Initialize faster-whisper model
logger.info("Initializing faster-whisper model")
try:
    # Force CPU usage with explicit parameters
    device = "cpu"
    compute_type = "float32"
    
    logger.info(f"Using device: {device}")
    logger.info("GPU disabled - using CPU only")
    logger.info("Environment: CUDA_VISIBLE_DEVICES='', CT2_FORCE_CPU=1")
    
    model = WhisperModel(
        "medium.en",
        device=device,
        compute_type=compute_type,
        download_root="whisper_models",
        cpu_threads=4,  # Use 4 CPU threads for better performance
        num_workers=1   # Single worker for CPU
    )
    logger.info("faster-whisper model loaded successfully")
    logger.info(f"Compute type: {compute_type}")
except Exception as e:
    logger.error(f"Failed to load whisper model: {str(e)}")
    raise


@app.post("/transcribe/audio")
async def transcribe_audio_file(
    audio_file: UploadFile = File(...),
    language: str = Form("en"),
    task: str = Form("transcribe")
):
    """
    Transcribe an uploaded audio file
    
    Args:
        audio_file: Audio file to transcribe (supports: wav, mp3, m4a, flac, etc.)
        language: Language code (default: "en")
        task: Task type - "transcribe" or "translate" (default: "transcribe")
    
    Returns:
        JSON with transcription results
    """
    try:
        logger.info(f"Received audio file: {audio_file.filename} ({audio_file.content_type})")
        
        # Validate file type
        allowed_types = [
            "audio/wav", "audio/mp3", "audio/mpeg", "audio/m4a", 
            "audio/flac", "audio/ogg", "audio/webm", "audio/aac"
        ]
        
        if audio_file.content_type not in allowed_types:
            logger.warning(f"Unsupported file type: {audio_file.content_type}")
            raise HTTPException(
                status_code=400, 
                detail=f"Unsupported file type. Allowed: {', '.join(allowed_types)}"
            )
        
        # Read audio file
        audio_bytes = await audio_file.read()
        logger.info(f"Audio file size: {len(audio_bytes)} bytes")
        
        # Transcribe audio
        result = transcribe_audio_bytes(audio_bytes)
        
        # Add metadata
        result.update({
            "filename": audio_file.filename,
            "file_size": len(audio_bytes),
            "content_type": audio_file.content_type,
            "language": language,
            "task": task,
            "timestamp": datetime.now().isoformat()
        })
        
        # Save transcription to file
        save_transcription_to_file(audio_file.filename, result)
        
        logger.info(f"Transcription completed for {audio_file.filename}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error transcribing audio file: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.post("/transcribe/audio-base64")
async def transcribe_audio_base64(
    audio_data: str = Form(...),
    filename: str = Form("audio.wav"),
    language: str = Form("en"),
    task: str = Form("transcribe")
):
    """
    Transcribe audio from base64 encoded data
    
    Args:
        audio_data: Base64 encoded audio data
        filename: Original filename (for reference)
        language: Language code (default: "en")
        task: Task type - "transcribe" or "translate" (default: "transcribe")
    
    Returns:
        JSON with transcription results
    """
    try:
        logger.info(f"Received base64 audio data for file: {filename}")
        
        # Decode base64 audio data
        try:
            audio_bytes = base64.b64decode(audio_data)
        except Exception as e:
            raise HTTPException(status_code=400, detail="Invalid base64 audio data")
        
        logger.info(f"Decoded audio size: {len(audio_bytes)} bytes")
        
        # Transcribe audio
        result = transcribe_audio_bytes(audio_bytes)
        
        # Add metadata
        result.update({
            "filename": filename,
            "file_size": len(audio_bytes),
            "language": language,
            "task": task,
            "timestamp": datetime.now().isoformat()
        })
        
        # Save transcription to file
        save_transcription_to_file(filename, result)
        
        logger.info(f"Transcription completed for {filename}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error transcribing base64 audio: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.get("/health")
async def health_check():
    """Health check endpoint for the server"""
    try:
        # Test file system access
        transcriptions_dir = "transcriptions"
        os.makedirs(transcriptions_dir, exist_ok=True)
        
        # Test write permission
        test_file = os.path.join(transcriptions_dir, "health_test.txt")
        with open(test_file, 'w') as f:
            f.write("health test")
        
        # Test read permission
        with open(test_file, 'r') as f:
            content = f.read()
        
        # Clean up test file
        os.remove(test_file)
        
        return {
            "status": "running",
            "model_loaded": True,
            "model_name": "small.en (faster-whisper)",
            "file_system": "accessible",
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return {
            "status": "running",
            "model_loaded": True,
            "model_name": "small.en (faster-whisper)",
            "file_system": f"error: {str(e)}",
            "timestamp": datetime.now().isoformat()
        }

@app.get("/test-account-endpoints")
async def test_account_endpoints():
    """Test endpoint to verify account-related endpoints are working"""
    try:
        transcriptions_dir = "transcriptions"
        files_exist = os.path.exists(transcriptions_dir)
        file_count = 0
        
        if files_exist:
            file_count = len([f for f in os.listdir(transcriptions_dir) if f.endswith('.txt')])
        
        return {
            "success": True,
            "transcriptions_dir_exists": files_exist,
            "transcription_files_count": file_count,
            "endpoints": {
                "health": "/health",
                "transcription_files": "/transcription-files",
                "transcription_file": "/transcription-file/{filename}",
                "delete_transcription": "/delete-transcription/{filename}"
            },
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Error in test account endpoints: {str(e)}")
        return {
            "success": False,
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }

@app.get("/sessions/status")
async def get_sessions_status():
    """Get status of all active sessions"""
    try:
        with audio_processor.session_lock:
            sessions_info = []
            for session_id, session_info in audio_processor.sessions.items():
                sessions_info.append({
                    "session_id": session_id,
                    "total_chunks": session_info['total_chunks'],
                    "processed_chunks": session_info['processed_chunks'],
                    "complete": session_info['complete'],
                    "websocket_active": session_info['websocket_active'],
                    "pending_messages": len(session_info.get('pending_messages', [])),
                    "created_at": session_info['created_at'].strftime("%Y-%m-%d %H:%M:%S"),
                    "progress_percentage": round((session_info['processed_chunks'] / max(session_info['total_chunks'], 1)) * 100, 1)
                })
            
            return {
                "success": True,
                "active_sessions": len(sessions_info),
                "processing_queue_size": len(audio_processor.processing_queue),
                "sessions": sessions_info
            }
    except Exception as e:
        logger.error(f"Error getting sessions status: {str(e)}")
        return {
            "success": False,
            "error": str(e)
        }

@app.get("/test-websocket")
async def test_websocket():
    """Test endpoint to send a test message to all connected websockets"""
    try:
        # Send a test message to all active sessions
        test_message = {
            "type": "transcription",
            "chunk_id": 999,
            "text": "This is a test transcription message from the server",
            "confidence": 0.95,
            "language": "en",
            "timestamp": int(datetime.now().timestamp() * 1000)
        }
        
        with audio_processor.session_lock:
            for session_id, session_info in audio_processor.sessions.items():
                if session_info['websocket_active']:
                    try:
                        websocket = session_info['websocket']
                        await websocket.send_json(test_message)
                        logger.info(f"Test message sent to session {session_id}")
                    except Exception as e:
                        logger.error(f"Failed to send test message to session {session_id}: {str(e)}")
        
        return {
            "success": True,
            "message": "Test message sent to all active sessions",
            "active_sessions": len(audio_processor.sessions)
        }
    except Exception as e:
        logger.error(f"Error in test websocket: {str(e)}")
        return {
            "success": False,
            "error": str(e)
        }

class AudioBuffer:
    def __init__(self):
        self.buffer = []
        self.sample_rate = 16000  # Whisper expects 16kHz audio
        self.channels = 1  # Whisper expects mono audio

    def add_audio(self, audio_data):
        self.buffer.extend(audio_data)

    def get_audio(self):
        return np.array(self.buffer)

    def clear(self):
        self.buffer = []

def get_session_audio_files(session_id):
    """Get all audio files for a specific session, sorted by chunk number"""
    session_dir = f"audio/session_{session_id}"
    if not os.path.exists(session_dir):
        return []
    
    # Get all .wav files in the session directory
    audio_files = glob.glob(os.path.join(session_dir, "chunk_*.wav"))
    
    # Sort by chunk number (extract number from filename)
    def extract_chunk_number(filename):
        basename = os.path.basename(filename)
        try:
            return int(basename.split('_')[1])
        except (IndexError, ValueError):
            return 0
    
    audio_files.sort(key=extract_chunk_number)
    return audio_files

def transcribe_audio_bytes(audio_bytes):
    """Transcribe audio bytes using faster-whisper"""
    try:
        # Convert bytes to numpy array audio
        audio_buffer = io.BytesIO(audio_bytes)
        
        # Load audio with soundfile (supports file-like object)
        audio, samplerate = sf.read(audio_buffer)
        
        # Convert audio to mono and 16kHz if needed (Whisper expects 16000 Hz)
        audio = librosa.to_mono(audio.T) if audio.ndim > 1 else audio
        audio = librosa.resample(audio, orig_sr=samplerate, target_sr=16000)
        
        # Whisper expects a numpy float32 array with shape (n_samples,)
        audio = audio.astype(np.float32)
        
        # Run transcription with faster-whisper
        logger.info(f"Transcription started at {datetime.now().strftime('%H:%M:%S')}")
        segments, info = model.transcribe(
            audio,
            beam_size=5,
            best_of=5,
            vad_filter=True,
            vad_parameters=dict(
                threshold=0.5,
                min_speech_duration_ms=250,
                max_speech_duration_s=3600,
                min_silence_duration_ms=2000
            )
        )
        
        # Combine all segments into a single text
        transcription_text = " ".join([segment.text for segment in segments]).strip()
        
        logger.info(f"Transcription completed at {datetime.now().strftime('%H:%M:%S')}")
        logger.info(f"Detected language: {info.language} with probability {info.language_probability}")
        
        return {
            "text": transcription_text,
            "language": info.language,
            "language_probability": info.language_probability,
            "confidence": info.language_probability  # Using language probability as confidence
        }
    except Exception as e:
        logger.error(f"Error in transcription: {str(e)}")
        return {
            "text": "",
            "language": "en",
            "language_probability": 0.0,
            "error": str(e)
        }

def save_transcription_to_file(original_filename: str, result: dict):
    """
    Save transcription result to a text file in the transcriptions directory
    
    Args:
        original_filename: Original audio filename
        result: Transcription result dictionary
    """
    try:
        # Create transcriptions directory if it doesn't exist
        transcriptions_dir = "transcriptions"
        os.makedirs(transcriptions_dir, exist_ok=True)
        
        # Generate filename for transcription
        # Remove extension from original filename and add timestamp
        base_name = os.path.splitext(original_filename)[0]
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        transcription_filename = f"transcription_{base_name}_{timestamp}.txt"
        transcription_filepath = os.path.join(transcriptions_dir, transcription_filename)
        
        # Write only the transcription text
        transcription_text = result.get('text', '')
        if transcription_text:
            with open(transcription_filepath, 'w', encoding='utf-8') as f:
                f.write(transcription_text)
            logger.info(f"Transcription saved to: {transcription_filepath}")
        else:
            logger.info(f"No transcription text to save for {original_filename}")
        
    except Exception as e:
        logger.error(f"Error saving transcription to file: {str(e)}")
        # Don't raise the error to avoid breaking the API response


@app.get("/process_session/{session_id}")
async def process_session_audio(session_id: str):
    """Process all audio files in a session and return transcriptions"""
    logger.info(f"Starting processing for session: {session_id}")
    
    audio_files = get_session_audio_files(session_id)
    if not audio_files:
        logger.warning(f"No audio files found for session: {session_id}")
        return {"error": "No audio files found for this session"}
    
    logger.info(f"Found {len(audio_files)} audio files for session: {session_id}")
    
    transcriptions = []
    total_files = len(audio_files)
    
    for i, audio_file in enumerate(audio_files, 1):
        try:
            chunk_number = int(os.path.basename(audio_file).split('_')[1])
            logger.info(f"[SESSION {session_id}] Processing chunkHHHHHHHHHHHHHHHHHH {chunk_number}/{total_files} - File: {audio_file}")
            
            with open(audio_file, "rb") as f:
                audio_bytes = f.read()

            # Process with Whisper model
            result = transcribe_audio_bytes(audio_bytes)
            transcription_text = result["text"].strip()
            
            transcription_data = {
                "chunk": chunk_number,
                "filename": os.path.basename(audio_file),
                "text": transcription_text,
                "confidence": result.get("confidence", 0.0),
                "language": result.get("language", "en")
            }
            
            transcriptions.append(transcription_data)
            logger.info(f"[SESSION {session_id}] Chunk {chunk_number} processed - Text: '{transcription_text}'")
            
        except Exception as e:
            logger.error(f"[SESSION {session_id}] Error processing chunk {chunk_number}: {str(e)}")
            transcriptions.append({
                "chunk": chunk_number,
                "filename": os.path.basename(audio_file),
                "text": "",
                "error": str(e)
            })
    
    # Sort transcriptions by chunk number
    transcriptions.sort(key=lambda x: x["chunk"])
    
    # Create complete transcription text
    complete_text = " ".join([t["text"] for t in transcriptions if t["text"]])
    
    result = {
        "session_id": session_id,
        "total_chunks": total_files,
        "processed_chunks": len(transcriptions),
        "transcriptions": transcriptions,
        "complete_text": complete_text,
        "processing_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
    
    logger.info(f"[SESSION {session_id}] Processing complete - {len(transcriptions)} chunks processed")
    return result

@app.get("/sessions")
async def list_sessions():
    """List all available sessions"""
    audio_dir = "audio"
    if not os.path.exists(audio_dir):
        return {"sessions": []}
    
    sessions = []
    for session_dir in os.listdir(audio_dir):
        if session_dir.startswith("session_"):
            session_id = session_dir.replace("session_", "")
            session_path = os.path.join(audio_dir, session_dir)
            
            # Count audio files
            audio_files = glob.glob(os.path.join(session_path, "chunk_*.wav"))
            
            # Get creation time
            creation_time = datetime.fromtimestamp(os.path.getctime(session_path))
            
            sessions.append({
                "session_id": session_id,
                "audio_files_count": len(audio_files),
                "created": creation_time.strftime("%Y-%m-%d %H:%M:%S"),
                "processed": False  # You can add logic to track if session was processed
            })
    
    # Sort by creation time (newest first)
    sessions.sort(key=lambda x: x["created"], reverse=True)
    
    return {"sessions": sessions}

@app.get("/transcription-files")
async def get_transcription_files():
    """Get all transcription text files from the transcriptions directory"""
    try:
        transcriptions_dir = "transcriptions"
        if not os.path.exists(transcriptions_dir):
            logger.info(f"Transcriptions directory does not exist: {transcriptions_dir}")
            return {
                "success": True,
                "files": [],
                "total_files": 0,
                "directory": transcriptions_dir
            }
        
        files = []
        for filename in os.listdir(transcriptions_dir):
            if filename.endswith(".txt"):
                filepath = os.path.join(transcriptions_dir, filename)
                try:
                    stat = os.stat(filepath)
                    
                    # Read file content
                    try:
                        with open(filepath, 'r', encoding='utf-8') as f:
                            content = f.read()
                    except Exception as e:
                        logger.warning(f"Could not read file {filename}: {e}")
                        content = ""
                    
                    files.append({
                        "name": filename,
                        "size": f"{stat.st_size / 1024:.1f} KB",
                        "date": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                        "content": content,
                        "content_length": len(content),
                        "filepath": filepath
                    })
                except Exception as e:
                    logger.error(f"Error processing file {filename}: {e}")
                    continue
        
        # Sort by date (newest first)
        files.sort(key=lambda x: x["date"], reverse=True)
        
        logger.info(f"Found {len(files)} transcription files")
        return {
            "success": True,
            "files": files,
            "total_files": len(files),
            "directory": transcriptions_dir
        }
    except Exception as e:
        logger.error(f"Error listing transcription files: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/transcription-file/{filename}")
async def get_transcription_file_content(filename: str):
    """Get content of a specific transcription file"""
    try:
        transcriptions_dir = "transcriptions"
        file_path = os.path.join(transcriptions_dir, filename)
        
        logger.info(f"View request for file: {filename}")
        logger.info(f"Full file path: {file_path}")
        
        # Security check to prevent directory traversal
        if not os.path.abspath(file_path).startswith(os.path.abspath(transcriptions_dir)):
            logger.error(f"Security violation: Invalid filename {filename}")
            raise HTTPException(status_code=400, detail="Invalid filename")
        
        if not os.path.exists(file_path):
            logger.error(f"File not found: {file_path}")
            raise HTTPException(status_code=404, detail="File not found")
            
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        stat = os.stat(file_path)
        lines = len(content.split('\n'))
        
        logger.info(f"Successfully read file: {filename} (size: {stat.st_size} bytes, lines: {lines})")
        
        return {
            "success": True,
            "filename": filename,
            "content": content,
            "size": f"{stat.st_size / 1024:.1f} KB",
            "date": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            "lines": lines,
            "content_length": len(content)
        }
    except Exception as e:
        logger.error(f"Error reading transcription file {filename}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/delete-transcription/{filename}")
async def delete_transcription(filename: str):
    """Delete a specific transcription file"""
    try:
        transcriptions_dir = "transcriptions"
        file_path = os.path.join(transcriptions_dir, filename)
        
        logger.info(f"Delete request for file: {filename}")
        logger.info(f"Full file path: {file_path}")
        
        # Security check to prevent directory traversal
        if not os.path.abspath(file_path).startswith(os.path.abspath(transcriptions_dir)):
            logger.error(f"Security violation: Invalid filename {filename}")
            raise HTTPException(status_code=400, detail="Invalid filename")
        
        if not os.path.exists(file_path):
            logger.error(f"File not found: {file_path}")
            raise HTTPException(status_code=404, detail="File not found")
        
        # Get file info before deletion
        stat = os.stat(file_path)
        file_size = stat.st_size
        
        # Delete the file
        os.remove(file_path)
        logger.info(f"Successfully deleted transcription file: {filename} (size: {file_size} bytes)")
        
        return {
            "success": True,
            "message": f"Transcription file '{filename}' deleted successfully",
            "deleted_file": filename,
            "file_size": file_size
        }
    except Exception as e:
        logger.error(f"Error deleting transcription {filename}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/delete-transcription/{filename}")
async def delete_transcription_post(filename: str):
    """Alternative DELETE endpoint using POST method for hosting providers that don't support DELETE"""
    return await delete_transcription(filename)

@app.delete("/delete-all-transcriptions")
async def delete_all_transcriptions():
    """Delete all transcription files"""
    try:
        transcriptions_dir = "transcriptions"
        
        logger.info("Delete all transcriptions request received")
        
        if not os.path.exists(transcriptions_dir):
            logger.info(f"Transcriptions directory does not exist: {transcriptions_dir}")
            return {
                "success": True,
                "message": "No transcription files to delete",
                "deleted_count": 0
            }
        
        # Get all .txt files in the transcriptions directory
        files_to_delete = []
        for filename in os.listdir(transcriptions_dir):
            if filename.endswith(".txt"):
                file_path = os.path.join(transcriptions_dir, filename)
                # Security check to prevent directory traversal
                if os.path.abspath(file_path).startswith(os.path.abspath(transcriptions_dir)):
                    files_to_delete.append((filename, file_path))
        
        if not files_to_delete:
            logger.info("No transcription files found to delete")
            return {
                "success": True,
                "message": "No transcription files found",
                "deleted_count": 0
            }
        
        # Delete all files
        deleted_count = 0
        total_size = 0
        for filename, file_path in files_to_delete:
            try:
                # Get file size before deletion
                stat = os.stat(file_path)
                file_size = stat.st_size
                total_size += file_size
                
                # Delete the file
                os.remove(file_path)
                deleted_count += 1
                logger.info(f"Successfully deleted transcription file: {filename} (size: {file_size} bytes)")
                
            except Exception as e:
                logger.error(f"Error deleting transcription file {filename}: {str(e)}")
        
        logger.info(f"Successfully deleted {deleted_count} transcription files (total size: {total_size} bytes)")
        
        return {
            "success": True,
            "message": f"Successfully deleted {deleted_count} transcription files",
            "deleted_count": deleted_count,
            "total_size": total_size
        }
        
    except Exception as e:
        logger.error(f"Error deleting all transcriptions: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/delete-all-transcriptions")
async def delete_all_transcriptions_post():
    """Alternative DELETE ALL endpoint using POST method for hosting providers that don't support DELETE"""
    return await delete_all_transcriptions()

@app.websocket("/ws/transcribe")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = str(uuid.uuid4())[:8]
    chunk_counter = 0
    total_messages = 0
    websocket_connection = websocket  # Store reference to websocket
    
    logger.info(f"=== NEW SESSION STARTED: {session_id} ===")
    
    # Create audio directory for this session
    session_audio_dir = f"audio/session_{session_id}"
    os.makedirs(session_audio_dir, exist_ok=True)
    logger.info(f"[SESSION {session_id}] Audio directory created: {session_audio_dir}")
    
    # Register this session with the audio processor
    audio_processor.register_session(session_id, session_audio_dir, websocket_connection)
    
    try:
        while True:
            # Check for pending transcription messages first
            pending_messages = []
            with audio_processor.session_lock:
                if session_id in audio_processor.sessions:
                    session_info = audio_processor.sessions[session_id]
                    if 'pending_messages' in session_info and session_info['pending_messages']:
                        pending_messages = session_info['pending_messages'].copy()
                        session_info['pending_messages'] = []
            
            # Send pending messages outside the lock
            for msg in pending_messages:
                try:
                    await websocket.send_json(msg)
                    logger.info(f"[SESSION {session_id}] Sent pending message: {msg['text']}")
                except Exception as e:
                    logger.error(f"[SESSION {session_id}] Failed to send pending message: {str(e)}")
            
            # Receive new data with timeout
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=1.0)  # Increased timeout
            except asyncio.TimeoutError:
                # No new data, continue to check for pending messages
                continue
                
            total_messages += 1
            message = json.loads(data)
            
            logger.info(f"[SESSION {session_id}] MESSAGE {total_messages} RECEIVED - Type: {message.get('type', 'unknown')}")
            
            if message["type"] == "audio":
                chunk_counter += 1
                # Log audio reception
                audio_bytes = base64.b64decode(message["data"])
                audio_size = len(audio_bytes)
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]  # Include milliseconds
                logger.info(f"[SESSION {session_id}] AUDIO CHUNK {chunk_counter} RECEIVED - Size: {audio_size} bytes, Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

                # Save audio chunk to file immediately
                chunk_filename = f"chunk_{chunk_counter}_{timestamp}.wav"
                # chunk_filepath = os.path.join(session_audio_dir, chunk_filename)
                # logger.warning(f"chunk_filepath________________________ {chunk_filepath}")
                chunk_filepath = os.path.abspath(os.path.normpath(os.path.join(session_audio_dir, chunk_filename)))
                logger.warning(f"chunk_filepath________________________ {chunk_filepath}")

        
                
                try:
                    with open(chunk_filepath, 'wb') as audio_file:
                        audio_file.write(audio_bytes)
                        audio_file.close()

                    
                    logger.info(f"[SESSION {session_id}] AUDIO CHUNK {chunk_counter} SAVED - File: {chunk_filename}")
                    logger.info(f"[SESSION {session_id}] AUDIO CHUNK {chunk_counter} SAVED - Path: {os.path.abspath(chunk_filepath)}")

                    # Send acknowledgment back to client
                    await websocket.send_json({
                        "type": "audio_received",
                        "chunk": chunk_counter,
                        "filename": chunk_filename
                    })
                    
                    # Small delay to ensure file is fully written before processing
                    await asyncio.sleep(0.1)
                    
                    # Add to processing queue (background processing)
                    audio_processor.add_chunk_to_queue(session_id, chunk_filepath, chunk_counter)
                    
                except Exception as save_error:
                    logger.error(f"[SESSION {session_id}] FAILED TO SAVE AUDIO CHUNK {chunk_counter}: {str(save_error)}")
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Failed to save chunk {chunk_counter}",
                        "chunk": chunk_counter
                    })

            elif message["type"] == "end":
                logger.info(f"[SESSION {session_id}] SESSION ENDED - Total messages: {total_messages}, Total chunks: {chunk_counter}, Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
                
                # Send final acknowledgment
                await websocket.send_json({
                    "type": "session_complete",
                    "total_chunks": chunk_counter,
                    "session_id": session_id
                })
                
                # Mark session as complete for background processing
                audio_processor.mark_session_complete(session_id)
                
                break
            elif message["type"] == "ping":
                # Handle ping messages for connection keep-alive
                await websocket.send_json({
                    "type": "pong",
                    "chunk_id": message.get("chunk_id", 0),
                    "timestamp": int(datetime.now().timestamp() * 1000)
                })
            else:
                logger.warning(f"[SESSION {session_id}] UNKNOWN MESSAGE TYPE: {message.get('type', 'unknown')}")

    except WebSocketDisconnect:
        logger.warning(f"[SESSION {session_id}] CLIENT DISCONNECTED - Total messages: {total_messages}, Processed chunks: {chunk_counter}, Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        # Mark websocket as disconnected but continue processing
        audio_processor.mark_websocket_disconnected(session_id)
    except Exception as e:
        logger.error(f"[SESSION {session_id}] ERROR: {str(e)} - Total messages: {total_messages}, Processed chunks: {chunk_counter}, Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        # Mark websocket as disconnected but continue processing
        audio_processor.mark_websocket_disconnected(session_id)
        await websocket.close()

# Global variables for WebSocket connections and processing
active_connections = []
processing_lock = threading.Lock()
processed_files = set()

class AudioProcessor:
    def __init__(self):
        self.running = False
        self.thread = None
        self.processed_files = set()
        self.sessions = {}  # Store session info: {session_id: {dir, websocket, chunks, complete}}
        self.processing_queue = []  # Queue of chunks to process
        self.session_lock = threading.Lock()
        self.queue_lock = threading.Lock()
        
    def start(self):
        """Start the audio processing thread"""
        if not self.running:
            self.running = True
            self.thread = threading.Thread(target=self._process_loop, daemon=True)
            self.thread.start()
            logger.info("Audio processing thread started")
    
    def stop(self):
        """Stop the audio processing thread"""
        self.running = False
        if self.thread:
            self.thread.join()
            logger.info("Audio processing thread stopped")
    
    def register_session(self, session_id: str, session_dir: str, websocket):
        """Register a new session for processing"""
        with self.session_lock:
            self.sessions[session_id] = {
                'dir': session_dir,
                'websocket': websocket,
                'chunks': [],
                'complete': False,
                'websocket_active': True,
                'pending_messages': [],
                'total_chunks': 0,
                'processed_chunks': 0,
                'created_at': datetime.now()
            }
            logger.info(f"[PROCESSOR] Registered session {session_id} - Total active sessions: {len(self.sessions)}")
    
    def add_chunk_to_queue(self, session_id: str, chunk_filepath: str, chunk_number: int):
        """Add a chunk to the processing queue"""
        # Verify file exists before adding to queue (with retry)
        max_retries = 3
        for attempt in range(max_retries):
            if os.path.exists(chunk_filepath):
                break
            if attempt < max_retries - 1:
                logger.warning(f"[PROCESSOR] File not found on attempt {attempt + 1}, retrying in 0.1s: {chunk_filepath}")
                time.sleep(0.1)
            else:
                logger.warning(f"[PROCESSOR] Cannot add chunk {chunk_number} to queue - file does not exist after {max_retries} attempts: {chunk_filepath}")
                return
        
        with self.queue_lock:
            self.processing_queue.append({
                'session_id': session_id,
                'filepath': chunk_filepath,
                'chunk_number': chunk_number,
                'timestamp': datetime.now()
            })
            
            # Update session info
            with self.session_lock:
                if session_id in self.sessions:
                    self.sessions[session_id]['total_chunks'] = max(self.sessions[session_id]['total_chunks'], chunk_number)
            
            logger.info(f"[PROCESSOR] Added chunk {chunk_number} to queue for session {session_id} - Queue size: {len(self.processing_queue)}")
    
    def mark_session_complete(self, session_id: str):
        """Mark a session as complete"""
        with self.session_lock:
            if session_id in self.sessions:
                self.sessions[session_id]['complete'] = True
                total_chunks = self.sessions[session_id]['total_chunks']
                logger.info(f"[PROCESSOR] Marked session {session_id} as complete - Total chunks: {total_chunks}")
    
    def mark_websocket_disconnected(self, session_id: str):
        """Mark websocket as disconnected for a session"""
        with self.session_lock:
            if session_id in self.sessions:
                self.sessions[session_id]['websocket_active'] = False
                logger.info(f"[PROCESSOR] Marked websocket as disconnected for session {session_id}")
    
    def _process_loop(self):
        """Main processing loop that processes queued audio chunks"""
        while self.running:
            try:
                self._process_queue()
                self._cleanup_completed_sessions()
                time.sleep(1.0)  # Check every 1 second to reduce race conditions
            except Exception as e:
                logger.error(f"Error in audio processing loop: {str(e)}")
                time.sleep(5)  # Wait longer on error
    
    def _process_queue(self):
        """Process audio chunks from the queue"""
        with self.queue_lock:
            if not self.processing_queue:
                return
            
            # Get next chunk to process
            chunk_info = self.processing_queue.pop(0)
            logger.warning(f" chunk_info {chunk_info}")
        

        
        session_id = chunk_info['session_id']
        filepath = chunk_info['filepath']
        chunk_number = chunk_info['chunk_number']

        logger.warning(f"filepath {filepath}")
        
        # Check if file still exists before processing
        if not os.path.exists(filepath):
            logger.warning(f"[PROCESSOR] File no longer exists, skipping chunk {chunk_number} for session {session_id}: {filepath}")
            # Mark as processed to avoid retry loops
            file_key = f"{session_id}_{os.path.basename(filepath)}"
            self.processed_files.add(filepath)
            
            # Update session processed count
            with self.session_lock:
                if session_id in self.sessions:
                    self.sessions[session_id]['processed_chunks'] += 1
                    processed = self.sessions[session_id]['processed_chunks']
                    total = self.sessions[session_id]['total_chunks']
                    logger.info(f"[PROCESSOR] Session ___ {session_id} progress: {processed}/{total} chunks processed")
            return
        
        try:
            logger.info(f"[PROCESSOR] Processing chunk {chunk_number} for session {session_id} abbb {filepath}")

            
            filepath = os.path.abspath(filepath)

            with open(filepath, "rb") as f:
               audio_bytes = f.read()

            # Process with Whisper model
            result = transcribe_audio_bytes(audio_bytes)
            transcription_text = result["text"].strip()
            
            # Process with Whisper model
            # result = model.transcribe(filepath)
            # transcription_text = result["text"].strip()
            
            if transcription_text:  # Only process if there's actual text
                # Create output data
                output_data = {
                    "session_id": session_id,
                    "chunk": chunk_number,
                    "filename": filepath,
                    "text": transcription_text,
                    "confidence": result.get("confidence", 0.0),
                    "language": result.get("language", "en"),
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }
                
                # Save transcription to file
                self._save_transcription_output(session_id, chunk_number, output_data)
                
                # Send message directly to websocket
                self._send_websocket_message_immediate(session_id, chunk_number, transcription_text, result)
                
                logger.info(f"[PROCESSOR] Chunk {chunk_number} processed - Text: '{transcription_text}'")
            else:
                logger.info(f"[PROCESSOR] No transcription text for chunk {chunk_number} (likely silence)")
            
            # Mark as processed and update session info
            file_key = f"{session_id}_{os.path.basename(filepath)}"
            self.processed_files.add(filepath)
            
            # Update session processed count
            with self.session_lock:
                if session_id in self.sessions:
                    self.sessions[session_id]['processed_chunks'] += 1
                    processed = self.sessions[session_id]['processed_chunks']
                    total = self.sessions[session_id]['total_chunks']
                    logger.info(f"[PROCESSOR] Session {session_id} progress: {processed}/{total} chunks processed")
            
        except FileNotFoundError as e:
            logger.exception(f"[PROCESSOR] File not found during processing {filepath}: {str(e)}")
            # Mark as processed to avoid retry loops
            file_key = f"{session_id}_{os.path.basename(filepath)}"
            self.processed_files.add(filepath)
            
            # Update session processed count
            with self.session_lock:
                if session_id in self.sessions:
                    self.sessions[session_id]['processed_chunks'] += 1
                    processed = self.sessions[session_id]['processed_chunks']
                    total = self.sessions[session_id]['total_chunks']
                    logger.info(f"[PROCESSOR] Session {session_id} progress: {processed}/{total} chunks processed")
        except Exception as e:
            logger.exception(f"[PROCESSOR] Error processing {filepath}: {str(e)}")
            # Mark as processed to avoid retry loops
            file_key = f"{session_id}_{os.path.basename(filepath)}"
            self.processed_files.add(filepath)
    

    
    def _save_transcription_output(self, session_id, chunk_number, output_data):
        """Save transcription output to audio_files folder"""
        try:
            # Create audio_files directory if it doesn't exist
            output_dir = "audio_files"
            os.makedirs(output_dir, exist_ok=True)
            
            # Save JSON output for individual chunk
            json_filename = f"chunk_{chunk_number}_{session_id}_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:-3]}.json"
            json_filepath = os.path.join(output_dir, json_filename)
            
            with open(json_filepath, 'w', encoding='utf-8') as json_file:
                json.dump(output_data, json_file, indent=2, ensure_ascii=False)
            
            # Save/append to single session transcription file in transcriptions folder
            transcriptions_dir = "transcriptions"
            os.makedirs(transcriptions_dir, exist_ok=True)
            
            # Use single filename per session (no timestamp in filename)
            session_txt_filename = f"transcription_session_{session_id}.txt"
            session_txt_filepath = os.path.join(transcriptions_dir, session_txt_filename)
            
            # Append transcription to session file (only content)
            with open(session_txt_filepath, 'a', encoding='utf-8') as session_file:
                session_file.write(f"{output_data['text']}\n")
            
            logger.info(f"[BACKGROUND] Output saved - JSON: {json_filename}, Transcription appended to: {session_txt_filename}")
            
        except Exception as e:
            logger.error(f"[BACKGROUND] Error saving output: {str(e)}")
    
    def _send_websocket_message_immediate(self, session_id: str, chunk_number: int, transcription_text: str, result):
        """Send transcription result to websocket immediately"""
        with self.session_lock:
            if session_id not in self.sessions:
                logger.warning(f"[PROCESSOR] Session {session_id} not found in sessions")
                return
            
            session_info = self.sessions[session_id]
            if not session_info['websocket_active']:
                logger.info(f"[PROCESSOR] Websocket not active for session {session_id}, skipping send")
                return
            
            websocket = session_info['websocket']
            
            try:
                transcription_message = {
                    "type": "transcription",
                    "chunk_id": chunk_number,
                    "text": transcription_text,
                    "confidence": result.get("confidence", 0.0),
                    "language": result.get("language", "en"),
                    "timestamp": int(datetime.now().timestamp() * 1000)  # Unix timestamp in milliseconds
                }
                
                # Store the message to be sent by the main WebSocket handler
                if 'pending_messages' not in session_info:
                    session_info['pending_messages'] = []
                session_info['pending_messages'].append(transcription_message)
                
                logger.info(f"[PROCESSOR] Message queued for session {session_id}, chunk {chunk_number}")
                    
            except Exception as e:
                logger.warning(f"[PROCESSOR] Failed to queue message for session {session_id}: {str(e)}")
                # Mark websocket as inactive
                session_info['websocket_active'] = False
    
    def _cleanup_completed_sessions(self):
        """Clean up sessions that are complete and all chunks processed"""
        with self.session_lock:
            sessions_to_remove = []
            
            for session_id, session_info in self.sessions.items():
                if session_info['complete']:
                    # Check if all chunks for this session have been processed
                    session_dir = session_info['dir']
                    if os.path.exists(session_dir):
                        audio_files = glob.glob(os.path.join(session_dir, "chunk_*.wav"))
                        all_processed = True
                        
                        for audio_file in audio_files:
                            file_key = f"{session_id}_{os.path.basename(audio_file)}"
                            if file_key not in self.processed_files:
                                all_processed = False
                                break
                        
                        if all_processed:
                            # Add a small delay to ensure all processing is complete
                            # and check if session is still marked as complete
                            if session_info['complete']:
                                logger.info(f"[PROCESSOR] All chunks processed for session {session_id}, cleaning up")
                                #self._cleanup_session_files(session_id, session_dir)
                                sessions_to_remove.append(session_id)
            
            # Remove completed sessions
            for session_id in sessions_to_remove:
                del self.sessions[session_id]
                logger.info(f"[PROCESSOR] Removed completed session {session_id}")
    
    def _cleanup_session_files(self, session_id: str, session_dir: str):
        """Clean up session files and directories"""
        try:
            import shutil
            
            # Double-check that all files are processed before cleanup
            if os.path.exists(session_dir):
                audio_files = glob.glob(os.path.join(session_dir, "chunk_*.wav"))
                unprocessed_files = []
                
                for audio_file in audio_files:
                    file_key = f"{session_id}_{os.path.basename(audio_file)}"
                    if file_key not in self.processed_files:
                        unprocessed_files.append(os.path.basename(audio_file))
                
                if unprocessed_files:
                    logger.warning(f"[PROCESSOR] Skipping cleanup for session {session_id} - unprocessed files: {unprocessed_files}")
                    return
                
                # All files processed, safe to cleanup
                shutil.rmtree(session_dir)
                logger.info(f"[PROCESSOR] Session directory cleaned up: {session_dir}")
            
            # Also clean up any JSON files in audio_files folder for this session
            audio_files_dir = "audio_files"
            if os.path.exists(audio_files_dir):
                session_json_files = glob.glob(os.path.join(audio_files_dir, f"*_{session_id}_*.json"))
                for json_file in session_json_files:
                    try:
                        os.remove(json_file)
                        logger.info(f"[PROCESSOR] Cleaned up JSON file: {os.path.basename(json_file)}")
                    except Exception as e:
                        logger.warning(f"[PROCESSOR] Failed to delete JSON file {json_file}: {str(e)}")
            
        except Exception as cleanup_error:
            logger.error(f"[PROCESSOR] Error during cleanup: {str(cleanup_error)}")
    
    def _notify_ui_clients(self, output_data):
        """Send transcription results to connected UI clients"""
        if not active_connections:
            return
        
        message = {
            "type": "transcription_result",
            "data": output_data
        }
        
        # Send to all connected clients
        disconnected = []
        for websocket in active_connections:
            try:
                asyncio.create_task(websocket.send_json(message))
            except Exception as e:
                logger.warning(f"Failed to send to client: {str(e)}")
                disconnected.append(websocket)
        
        # Remove disconnected clients
        for websocket in disconnected:
            try:
                active_connections.remove(websocket)
            except ValueError:
                pass

# Initialize audio processor
audio_processor = AudioProcessor()

@app.on_event("startup")
async def startup_event():
    """Start the audio processing thread when the app starts"""
    audio_processor.start()

@app.on_event("shutdown")
async def shutdown_event():
    """Stop the audio processing thread when the app shuts down"""
    audio_processor.stop()

@app.websocket("/ws/ui")
async def ui_websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for UI clients to receive real-time transcription results"""
    await websocket.accept()
    active_connections.append(websocket)
    logger.info(f"UI client connected. Total connections: {len(active_connections)}")
    
    try:
        while True:
            # Keep connection alive and handle any UI messages
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
            elif message.get("type") == "get_status":
                await websocket.send_json({
                    "type": "status",
                    "processed_files": len(audio_processor.processed_files),
                    "active_connections": len(active_connections)
                })
                
    except WebSocketDisconnect:
        logger.info("UI client disconnected")
    except Exception as e:
        logger.error(f"Error in UI WebSocket: {str(e)}")
    finally:
        try:
            active_connections.remove(websocket)
        except ValueError:
            pass
        logger.info(f"UI client removed. Total connections: {len(active_connections)}")

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting Faster-Whisper Real-time Transcription API server")
    uvicorn.run(
        app, 
        host="192.168.1.16", 
        port=8000,
        timeout_keep_alive=30,
        timeout_graceful_shutdown=30,
        access_log=True
    )