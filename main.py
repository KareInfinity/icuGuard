import os
import re
import psutil
# Force CPU-only mode for faster-whisper
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["CT2_FORCE_CPU"] = "1"

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form, BackgroundTasks
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
import logging.config
from datetime import datetime
import uuid
import glob
import threading
import time
from collections import defaultdict
import torch
import soundfile as sf
import librosa

# ICU Care Lite imports
import requests
import urllib3
import xml.etree.ElementTree as ET
import ssl
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

# Disable SSL warnings for ICU Care Lite
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Utility functions
def sanitize_filename(filename):
    """Sanitize filenames to prevent path traversal and special characters"""
    # Normalize path and get basename
    filename = os.path.basename(filename)
    # Replace problematic characters
    filename = re.sub(r'[^\w\-_. ]', '_', filename)
    return filename

def safe_path_join(base_path, filename):
    """Safely join paths and prevent directory traversal"""
    filename = sanitize_filename(filename)
    full_path = os.path.abspath(os.path.join(base_path, filename))
    # Ensure the path is within the base directory
    if not full_path.startswith(os.path.abspath(base_path)):
        raise ValueError(f"Path traversal attempt: {filename}")
    return full_path

# Placeholder for cleanup_session function - will be defined after AudioProcessor

# Configure logging
def setup_logging():
    # Create logs directory if it doesn't exist
    os.makedirs("logs", exist_ok=True)
    
    # Configure logging with rotation
    logging.config.dictConfig({
        'version': 1,
        'disable_existing_loggers': False,
        'formatters': {
            'standard': {
                'format': '%(asctime)s - %(levelname)s - %(name)s - %(message)s'
            },
        },
        'handlers': {
            'file': {
                'level': 'INFO',
                'class': 'logging.handlers.RotatingFileHandler',
                'filename': 'logs/audio_processing.log',
                'maxBytes': 10485760,  # 10MB
                'backupCount': 5,
                'formatter': 'standard',
                'encoding': 'utf-8'
            },
            'console': {
                'level': 'INFO',
                'class': 'logging.StreamHandler',
                'formatter': 'standard'
            },
        },
        'loggers': {
            '': {
                'handlers': ['file', 'console'],
                'level': 'INFO',
                'propagate': True
            }
        }
    })

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

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan events"""
    # Startup
    logger.info("Starting audio processing thread...")
    audio_processor.start()
    yield
    # Shutdown
    logger.info("Stopping audio processing thread...")
    audio_processor.stop()

app = FastAPI(
    title="Whisper Real-time Transcription API",
    description="WebSocket API for real-time audio transcription using faster-whisper model",
    version="1.0.0",
    lifespan=lifespan
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
    # Force CPU usage with optimized parameters
    device = "cpu"
    compute_type = "int8"  # Use int8 for better CPU performance
    
    logger.info(f"Using device: {device}")
    logger.info("GPU disabled - using CPU only")
    logger.info("Environment: CUDA_VISIBLE_DEVICES='', CT2_FORCE_CPU=1")
    
    # Use smaller model for better CPU performance
    model = WhisperModel(
        "small.en",  # Use small model instead of medium for faster processing
        device=device,
        compute_type=compute_type,
        download_root="whisper_models",
        cpu_threads=max(1, os.cpu_count() - 1),  # Use all but one core
        num_workers=1   # Single worker for CPU
    )
    logger.info("faster-whisper model loaded successfully")
    logger.info(f"Compute type: {compute_type}")
    logger.info(f"CPU threads: {max(1, os.cpu_count() - 1)}")
except Exception as e:
    logger.error(f"Failed to load whisper model: {str(e)}")
    raise


@app.post("/transcribe/audio")
async def transcribe_audio_file(
    background_tasks: BackgroundTasks,
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
        JSON with transcription results or task ID for background processing
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
        file_size_mb = len(audio_bytes) / (1024 * 1024)
        logger.info(f"Audio file size: {file_size_mb:.2f} MB")
        
        # Determine if we should process in background (files > 50MB or estimated duration > 10 minutes)
        # Rough estimate: 1MB ≈ 1 minute of audio
        should_process_background = file_size_mb > 50
        
        if should_process_background:
            # Generate task ID
            task_id = str(uuid.uuid4())
            
            # Add to background tasks
            background_tasks.add_task(
                process_audio_background,
                task_id,
                audio_bytes,
                audio_file.filename,
                language,
                task
            )
            
            logger.info(f"Large file {audio_file.filename} ({file_size_mb:.2f}MB) queued for background processing. Task ID: {task_id}")
            
            return {
                "status": "queued",
                "task_id": task_id,
                "message": f"Large audio file ({file_size_mb:.2f}MB) is being processed in background. Use /task-status/{task_id} to check progress.",
                "filename": audio_file.filename,
                "file_size_mb": file_size_mb
            }
        else:
            # Process immediately for smaller files
            logger.info(f"Processing {audio_file.filename} immediately (size: {file_size_mb:.2f}MB)")
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

@app.get("/task-status/{task_id}")
async def get_task_status(task_id: str):
    """
    Get the status of a background transcription task
    
    Args:
        task_id: The task ID returned from /transcribe/audio
    
    Returns:
        JSON with task status and results if completed
    """
    with task_lock:
        if task_id not in background_tasks:
            raise HTTPException(status_code=404, detail="Task not found")
        
        task_info = background_tasks[task_id]
        
        if task_info["status"] == "completed":
            return {
                "task_id": task_id,
                "status": "completed",
                "result": task_info["result"],
                "filename": task_info["filename"],
                "completed_at": task_info["completed_at"]
            }
        elif task_info["status"] == "failed":
            return {
                "task_id": task_id,
                "status": "failed",
                "error": task_info["error"],
                "filename": task_info["filename"],
                "failed_at": task_info["failed_at"]
            }
        else:
            return {
                "task_id": task_id,
                "status": "processing",
                "progress": task_info.get("progress", 0),
                "filename": task_info["filename"],
                "started_at": task_info["started_at"]
            }

@app.get("/background-tasks")
async def list_background_tasks():
    """
    List all background tasks and their status
    """
    with task_lock:
        return {
            "total_tasks": len(background_tasks),
            "tasks": [
                {
                    "task_id": task_id,
                    "status": task_info["status"],
                    "filename": task_info["filename"],
                    "started_at": task_info.get("started_at"),
                    "completed_at": task_info.get("completed_at"),
                    "failed_at": task_info.get("failed_at")
                }
                for task_id, task_info in background_tasks.items()
            ]
        }

@app.delete("/background-tasks/{task_id}")
async def delete_background_task(task_id: str):
    """
    Delete a background task (only if completed or failed)
    """
    with task_lock:
        if task_id not in background_tasks:
            raise HTTPException(status_code=404, detail="Task not found")
        
        task_info = background_tasks[task_id]
        if task_info["status"] == "processing":
            raise HTTPException(status_code=400, detail="Cannot delete a task that is still processing")
        
        del background_tasks[task_id]
        return {"message": f"Task {task_id} deleted successfully"}

@app.delete("/background-tasks")
async def cleanup_old_background_tasks():
    """
    Clean up old completed/failed tasks (older than 24 hours)
    """
    cutoff_time = datetime.now().timestamp() - (24 * 60 * 60)  # 24 hours ago
    deleted_count = 0
    
    with task_lock:
        tasks_to_delete = []
        for task_id, task_info in background_tasks.items():
            if task_info["status"] in ["completed", "failed"]:
                # Check if task is older than 24 hours
                completed_time = task_info.get("completed_at") or task_info.get("failed_at")
                if completed_time:
                    try:
                        task_timestamp = datetime.fromisoformat(completed_time.replace('Z', '+00:00')).timestamp()
                        if task_timestamp < cutoff_time:
                            tasks_to_delete.append(task_id)
                    except:
                        pass
        
        # Delete old tasks
        for task_id in tasks_to_delete:
            del background_tasks[task_id]
            deleted_count += 1
    
    return {"message": f"Cleaned up {deleted_count} old background tasks"}

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

# ICU Care Lite API Endpoints
@app.post("/icu/login")
async def icu_login(
    username: str = Form("tony"),
    password: str = Form("icu@123"),
    code: str = Form("")
):
    """
    Login to ICU Care Lite system and get JWT token
    
    Args:
        username: ICU Care Lite username (default: "tony")
        password: ICU Care Lite password (default: "icu@123")
        code: Additional code if required (default: "")
    
    Returns:
        JSON with login status and JWT token
    """
    try:
        logger.info(f"=== ICU Care Lite POST /icu/login START ===")
        logger.info(f"ICU Care Lite login request for user: {username}")
        logger.info(f"ICU Care Lite login parameters - username: {username}, code: {code}")
        
        # Create ICU client instance
        logger.info("ICU Care Lite - Creating ICU client instance for login")
        icu_client = ICUCareLiteClient()
        logger.info(f"ICU Care Lite - Client created with base URL: {icu_client.base_url}")
        
        # Attempt login
        logger.info("ICU Care Lite - Starting login process")
        login_success = icu_client.login(username, password, code)
        logger.info(f"ICU Care Lite - Login result: {login_success}")
        
        if login_success:
            success_response = {
                "success": True,
                "message": "ICU Care Lite login successful",
                "username": username,
                "jwt_token": icu_client.jwt_token,
                "timestamp": datetime.now().isoformat()
            }
            logger.info(f"ICU Care Lite - Login successful response: {success_response}")
            logger.info(f"=== ICU Care Lite POST /icu/login SUCCESS ===")
            return success_response
        else:
            error_response = {
                "success": False,
                "message": "ICU Care Lite login failed",
                "username": username,
                "timestamp": datetime.now().isoformat()
            }
            logger.error(f"ICU Care Lite - Login failed response: {error_response}")
            logger.info(f"=== ICU Care Lite POST /icu/login FAILED ===")
            return error_response
            
    except Exception as e:
        logger.error(f"ICU Care Lite login error: {str(e)}")
        logger.error(f"ICU Care Lite login error type: {type(e).__name__}")
        import traceback
        logger.error(f"ICU Care Lite login traceback: {traceback.format_exc()}")
        logger.info(f"=== ICU Care Lite POST /icu/login ERROR ===")
        raise HTTPException(status_code=500, detail=f"ICU Care Lite login failed: {str(e)}")

@app.post("/icu/patient-list")
async def icu_get_patient_list(
    username: str = Form("tony"),
    password: str = Form("icu@123"),
    code: str = Form(""),
    shift_start: str = Form("2025-09-26 14:00"),
    shift_end: str = Form("2025-09-26 22:00")
):
    """
    Get ICU Care Lite patient list with wards and users
    
    Args:
        username: ICU Care Lite username (default: "tony")
        password: ICU Care Lite password (default: "icu@123")
        code: Additional code if required (default: "")
        shift_start: Shift start datetime (default: "2025-09-26 14:00")
        shift_end: Shift end datetime (default: "2025-09-26 22:00")
    
    Returns:
        JSON with patient list, ward list, and user list
    """
    try:
        logger.info(f"=== ICU Care Lite POST /icu/patient-list START ===")
        logger.info(f"ICU Care Lite patient list request for user: {username}")
        logger.info(f"ICU Care Lite request parameters - username: {username}, code: {code}")
        logger.info(f"ICU Care Lite request parameters - shift_start: {shift_start}, shift_end: {shift_end}")
        
        # Create ICU client instance
        logger.info("ICU Care Lite - Creating ICU client instance")
        icu_client = ICUCareLiteClient()
        logger.info(f"ICU Care Lite - Client created with base URL: {icu_client.base_url}")
        
        # Login first
        logger.info("ICU Care Lite - Starting login process")
        login_success = icu_client.login(username, password, code)
        logger.info(f"ICU Care Lite - Login result: {login_success}")
        
        if not login_success:
            logger.error("ICU Care Lite - Login failed, returning error response")
            error_response = {
                "success": False,
                "message": "ICU Care Lite login failed",
                "username": username,
                "timestamp": datetime.now().isoformat()
            }
            logger.info(f"ICU Care Lite - Error response: {error_response}")
            return error_response
        
        # Get patient list
        logger.info("ICU Care Lite - Login successful, getting patient list")
        patient_data = icu_client.get_patient_list(shift_start, shift_end)
        logger.info(f"ICU Care Lite - Patient data result: {patient_data is not None}")
        
        if patient_data:
            logger.info(f"ICU Care Lite - Patient data summary: {patient_data.get('summary', 'No summary')}")
            success_response = {
                "success": True,
                "message": "ICU Care Lite data retrieved successfully",
                "username": username,
                "timestamp": patient_data["timestamp"],
                "summary": patient_data["summary"],
                "patient_list": patient_data["patients"],
                "ward_list": patient_data["wards"],
                "user_list": patient_data["users"],
                "jwt_token": patient_data["jwt_token"]
            }
            logger.info(f"ICU Care Lite - Success response prepared with {len(patient_data['patients'])} patients")
            logger.info(f"=== ICU Care Lite POST /icu/patient-list SUCCESS ===")
            return success_response
        else:
            logger.error("ICU Care Lite - Failed to retrieve patient data")
            error_response = {
                "success": False,
                "message": "Failed to retrieve ICU Care Lite data",
                "username": username,
                "timestamp": datetime.now().isoformat()
            }
            logger.info(f"ICU Care Lite - Error response: {error_response}")
            logger.info(f"=== ICU Care Lite POST /icu/patient-list FAILED ===")
            return error_response
            
    except Exception as e:
        logger.error(f"ICU Care Lite patient list error: {str(e)}")
        logger.error(f"ICU Care Lite error type: {type(e).__name__}")
        import traceback
        logger.error(f"ICU Care Lite traceback: {traceback.format_exc()}")
        logger.info(f"=== ICU Care Lite POST /icu/patient-list ERROR ===")
        raise HTTPException(status_code=500, detail=f"ICU Care Lite patient list failed: {str(e)}")

@app.get("/icu/patient-list")
async def icu_get_patient_list_get(
    username: str = "tony",
    password: str = "icu@123",
    code: str = "",
    shift_start: str = "2025-09-26 14:00",
    shift_end: str = "2025-09-26 22:00"
):
    """
    Get ICU Care Lite patient list with wards and users (GET method)
    
    Args:
        username: ICU Care Lite username (default: "tony")
        password: ICU Care Lite password (default: "icu@123")
        code: Additional code if required (default: "")
        shift_start: Shift start datetime (default: "2025-09-26 14:00")
        shift_end: Shift end datetime (default: "2025-09-26 22:00")
    
    Returns:
        JSON with patient list, ward list, and user list
    """
    try:
        logger.info(f"=== ICU Care Lite GET /icu/patient-list START ===")
        logger.info(f"ICU Care Lite patient list GET request for user: {username}")
        logger.info(f"ICU Care Lite GET request parameters - username: {username}, code: {code}")
        logger.info(f"ICU Care Lite GET request parameters - shift_start: {shift_start}, shift_end: {shift_end}")
        
        # Create ICU client instance
        logger.info("ICU Care Lite GET - Creating ICU client instance")
        icu_client = ICUCareLiteClient()
        logger.info(f"ICU Care Lite GET - Client created with base URL: {icu_client.base_url}")
        
        # Login first
        logger.info("ICU Care Lite GET - Starting login process")
        login_success = icu_client.login(username, password, code)
        logger.info(f"ICU Care Lite GET - Login result: {login_success}")
        
        if not login_success:
            logger.error("ICU Care Lite GET - Login failed, returning error response")
            error_response = {
                "success": False,
                "message": "ICU Care Lite login failed",
                "username": username,
                "timestamp": datetime.now().isoformat()
            }
            logger.info(f"ICU Care Lite GET - Error response: {error_response}")
            return error_response
        
        # Get patient list
        logger.info("ICU Care Lite GET - Login successful, getting patient list")
        patient_data = icu_client.get_patient_list(shift_start, shift_end)
        logger.info(f"ICU Care Lite GET - Patient data result: {patient_data is not None}")
        
        if patient_data:
            logger.info(f"ICU Care Lite GET - Patient data summary: {patient_data.get('summary', 'No summary')}")
            success_response = {
                "success": True,
                "message": "ICU Care Lite data retrieved successfully",
                "username": username,
                "timestamp": patient_data["timestamp"],
                "summary": patient_data["summary"],
                "patient_list": patient_data["patients"],
                "ward_list": patient_data["wards"],
                "user_list": patient_data["users"],
                "jwt_token": patient_data["jwt_token"]
            }
            logger.info(f"ICU Care Lite GET - Success response prepared with {len(patient_data['patients'])} patients")
            logger.info(f"=== ICU Care Lite GET /icu/patient-list SUCCESS ===")
            return success_response
        else:
            logger.error("ICU Care Lite GET - Failed to retrieve patient data")
            error_response = {
                "success": False,
                "message": "Failed to retrieve ICU Care Lite data",
                "username": username,
                "timestamp": datetime.now().isoformat()
            }
            logger.info(f"ICU Care Lite GET - Error response: {error_response}")
            logger.info(f"=== ICU Care Lite GET /icu/patient-list FAILED ===")
            return error_response
            
    except Exception as e:
        logger.error(f"ICU Care Lite patient list GET error: {str(e)}")
        logger.error(f"ICU Care Lite GET error type: {type(e).__name__}")
        import traceback
        logger.error(f"ICU Care Lite GET traceback: {traceback.format_exc()}")
        logger.info(f"=== ICU Care Lite GET /icu/patient-list ERROR ===")
        raise HTTPException(status_code=500, detail=f"ICU Care Lite patient list failed: {str(e)}")

@app.get("/")
async def root_endpoint():
    """Root endpoint for health checks and basic server info"""
    return {
        "message": "ICU Guard Server is running",
        "status": "healthy",
        "version": "1.0.0",
        "endpoints": {
            "health": "/health",
            "icu_login": "/icu/login",
            "icu_patient_list": "/icu/patient-list",
            "websocket": "/ws/transcribe",
            "ui_websocket": "/ws/ui"
        },
        "timestamp": datetime.now().isoformat()
    }

@app.get("/favicon.ico")
async def favicon():
    """Handle favicon requests to prevent 404 errors"""
    from fastapi.responses import Response
    return Response(content="", media_type="image/x-icon")

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
            f.flush()             # Force flush buffers
            os.fsync(f.fileno())  # Force flush to disk at OS level
        # File is now fully flushed and closed
        
        # Test read permission
        with open(test_file, 'r') as f:
            content = f.read()
        
        # Clean up test file
        os.remove(test_file)
        
        # Test model with silence
        test_audio = np.zeros((16000,), dtype=np.float32)  # 1 second of silence
        segments, info = model.transcribe(test_audio)
        
        return {
            "status": "healthy",
            "model_loaded": True,
            "model_name": "small.en (faster-whisper)",
            "file_system": "accessible",
            "model_test": "passed",
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return {
            "status": "unhealthy",
            "model_loaded": True,
            "model_name": "small.en (faster-whisper)",
            "file_system": f"error: {str(e)}",
            "model_test": "failed",
            "timestamp": datetime.now().isoformat()
        }

@app.get("/server-status")
async def server_status():
    """Get detailed server status including performance metrics"""
    try:
        # Get system metrics
        cpu_percent = psutil.cpu_percent(interval=1) if hasattr(psutil, 'cpu_percent') else None
        memory = psutil.virtual_memory() if hasattr(psutil, 'virtual_memory') else None
        
        # Get audio processor status
        with audio_processor.session_lock:
            active_sessions = len(audio_processor.sessions)
            sessions_info = []
            for session_id, session_info in audio_processor.sessions.items():
                sessions_info.append({
                    "session_id": session_id,
                    "username": session_info.get('username', 'unknown'),
                    "session_count": session_info.get('session_count', 0),
                    "total_chunks": session_info['total_chunks'],
                    "processed_chunks": session_info['processed_chunks'],
                    "complete": session_info['complete'],
                    "websocket_active": session_info['websocket_active'],
                    "created_at": session_info['created_at'].strftime("%Y-%m-%d %H:%M:%S")
                })
        
        with audio_processor.queue_lock:
            queue_size = len(audio_processor.processing_queue)
        
        return {
            "status": "running",
            "active_sessions": active_sessions,
            "queue_size": queue_size,
            "processed_files": len(audio_processor.processed_files),
            "cpu_usage": cpu_percent,
            "memory_usage": memory.percent if memory else None,
            "memory_available": f"{memory.available / (1024**3):.1f} GB" if memory else None,
            "sessions": sessions_info,
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Server status check failed: {str(e)}")
        return {
            "status": "error",
            "error": str(e),
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
                    "username": session_info.get('username', 'unknown'),
                    "session_count": session_info.get('session_count', 0),
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

def get_session_audio_files(session_id, username=None):
    """Get all audio files for a specific session, sorted by chunk number"""
    if username:
        session_dir = f"audio/{username}/session_{session_id}"
    else:
        # Fallback to old structure for backward compatibility
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

def transcribe_audio_bytes(audio_bytes, task_id: str = None):
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
        
        # Update progress if this is a background task
        if task_id:
            with task_lock:
                if task_id in background_tasks:
                    background_tasks[task_id]["progress"] = 10
        
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
        
        # Update progress if this is a background task
        if task_id:
            with task_lock:
                if task_id in background_tasks:
                    background_tasks[task_id]["progress"] = 90
        
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
                f.flush()             # Force flush buffers
                os.fsync(f.fileno())  # Force flush to disk at OS level
            # File is now fully flushed and closed
            logger.info(f"Transcription saved to: {transcription_filepath}")
        else:
            logger.info(f"No transcription text to save for {original_filename}")
        
    except Exception as e:
        logger.error(f"Error saving transcription to file: {str(e)}")
        # Don't raise the error to avoid breaking the API response


@app.get("/process_session/{session_id}")
async def process_session_audio(session_id: str, username: str = None):
    """Process all audio files in a session and return transcriptions"""
    logger.info(f"Starting processing for session: {session_id} (username: {username})")
    
    audio_files = get_session_audio_files(session_id, username)
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
    
    # Check if we have the new username-based structure
    for username_dir in os.listdir(audio_dir):
        username_path = os.path.join(audio_dir, username_dir)
        if os.path.isdir(username_path):
            # This is a username directory
            for session_dir in os.listdir(username_path):
                if session_dir.startswith("session_"):
                    session_id = session_dir.replace("session_", "")
                    session_path = os.path.join(username_path, session_dir)
                    
                    # Count audio files
                    audio_files = glob.glob(os.path.join(session_path, "chunk_*.wav"))
                    
                    # Get creation time
                    creation_time = datetime.fromtimestamp(os.path.getctime(session_path))
                    
                    sessions.append({
                        "session_id": session_id,
                        "username": username_dir,
                        "audio_files_count": len(audio_files),
                        "created": creation_time.strftime("%Y-%m-%d %H:%M:%S"),
                        "processed": False  # You can add logic to track if session was processed
                    })
        elif username_dir.startswith("session_"):
            # Fallback for old structure (backward compatibility)
            session_id = username_dir.replace("session_", "")
            session_path = os.path.join(audio_dir, username_dir)
            
            # Count audio files
            audio_files = glob.glob(os.path.join(session_path, "chunk_*.wav"))
            
            # Get creation time
            creation_time = datetime.fromtimestamp(os.path.getctime(session_path))
            
            sessions.append({
                "session_id": session_id,
                "username": "unknown",
                "audio_files_count": len(audio_files),
                "created": creation_time.strftime("%Y-%m-%d %H:%M:%S"),
                "processed": False
            })
    
    # Sort by creation time (newest first)
    sessions.sort(key=lambda x: x["created"], reverse=True)
    
    return {"sessions": sessions}

@app.get("/sessions/{username}")
async def list_sessions_by_username(username: str):
    """List all available sessions for a specific username"""
    audio_dir = "audio"
    username_path = os.path.join(audio_dir, username)
    
    if not os.path.exists(username_path):
        return {"sessions": [], "username": username}
    
    sessions = []
    for session_dir in os.listdir(username_path):
        if session_dir.startswith("session_"):
            session_id = session_dir.replace("session_", "")
            session_path = os.path.join(username_path, session_dir)
            
            # Count audio files
            audio_files = glob.glob(os.path.join(session_path, "chunk_*.wav"))
            
            # Get creation time
            creation_time = datetime.fromtimestamp(os.path.getctime(session_path))
            
            sessions.append({
                "session_id": session_id,
                "username": username,
                "audio_files_count": len(audio_files),
                "created": creation_time.strftime("%Y-%m-%d %H:%M:%S"),
                "processed": False
            })
    
    # Sort by creation time (newest first)
    sessions.sort(key=lambda x: x["created"], reverse=True)
    
    return {"sessions": sessions, "username": username}

@app.get("/user-session-counts")
async def get_user_session_counts():
    """Get session counts for all users"""
    with user_session_counts_lock:
        return {
            "user_session_counts": user_session_counts.copy(),
            "total_users": len(user_session_counts)
        }

@app.get("/user-session-counts/{username}")
async def get_user_session_count(username: str):
    """Get session count for a specific user"""
    with user_session_counts_lock:
        count = user_session_counts.get(username, 0)
        return {
            "username": username,
            "session_count": count
        }

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
    username = "unknown"  # Default username - will be updated when "init" message is received
    
    logger.info(f"=== NEW SESSION STARTED: {session_id} ===")
    
    # Create temporary audio directory (will be moved when username is known)
    session_audio_dir = f"audio/session_{session_id}"
    os.makedirs(session_audio_dir, exist_ok=True)
    logger.info(f"[SESSION {session_id}] Temporary audio directory created: {session_audio_dir}")
    
    # Register this session with the audio processor
    # Note: username will be "unknown" initially, will be updated when "init" message is received
    audio_processor.register_session(session_id, session_audio_dir, websocket_connection, username)
    logger.info(f"[SESSION {session_id}] Session registered with initial username: {username}")
    
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
            
            if message["type"] == "init":
                # Handle initialization message with username
                username = message.get("username", "unknown")
                logger.info(f"[SESSION {session_id}] INITIALIZED with username: {username}")
                
                # Increment session count for this user
                session_count = get_next_session_count(username)
                
                # Move audio directory to username-based structure
                old_session_dir = f"audio/session_{session_id}"
                new_session_dir = f"audio/{username}/session_{session_id}"
                
                try:
                    # Create username directory if it doesn't exist
                    os.makedirs(f"audio/{username}", exist_ok=True)
                    
                    # Move the session directory
                    if os.path.exists(old_session_dir):
                        import shutil
                        shutil.move(old_session_dir, new_session_dir)
                        logger.info(f"[SESSION {session_id}] Moved audio directory: {old_session_dir} -> {new_session_dir}")
                    else:
                        # Create new directory if old one doesn't exist
                        os.makedirs(new_session_dir, exist_ok=True)
                        logger.info(f"[SESSION {session_id}] Created new audio directory: {new_session_dir}")
                    
                    # Update the session_audio_dir variable to point to the new location
                    session_audio_dir = new_session_dir
                    
                    # Update session info with username, session count, and new directory
                    audio_processor.update_session_username(session_id, username, session_count)
                    with audio_processor.session_lock:
                        if session_id in audio_processor.sessions:
                            audio_processor.sessions[session_id]['dir'] = new_session_dir
                            logger.info(f"[SESSION {session_id}] Updated session directory: {new_session_dir}")
                    
                except Exception as e:
                    logger.error(f"[SESSION {session_id}] Error moving audio directory: {str(e)}")
                    # Continue with old directory if move fails
                    new_session_dir = old_session_dir
                
                # Send acknowledgment
                await websocket.send_json({
                    "type": "initialized",
                    "username": username,
                    "session_id": session_id,
                    "session_count": session_count
                })
                
            elif message["type"] == "audio":
                chunk_counter += 1
                # Log audio reception
                audio_bytes = base64.b64decode(message["data"])
                audio_size = len(audio_bytes)
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]  # Include milliseconds
                
                # Extract ICU data from message
                icu_data = {
                    "patient": message.get("patient"),
                    "ward": message.get("ward"), 
                    "user": message.get("user"),
                    "username": message.get("username", username)
                }
                
                logger.info(f"[SESSION {session_id}] AUDIO CHUNK {chunk_counter} RECEIVED - Size: {audio_size} bytes, Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
                logger.info(f"[SESSION {session_id}] ICU DATA - Patient: {icu_data['patient']['name'] if icu_data['patient'] else 'None'}, Ward: {icu_data['ward']['desc'] if icu_data['ward'] else 'None'}, User: {icu_data['user']['loginname'] if icu_data['user'] else 'None'}")

                # Save audio chunk to file immediately with safe path handling
                chunk_filename = f"chunk_{chunk_counter}_{timestamp}.wav"
                try:
                    chunk_filepath = safe_path_join(session_audio_dir, chunk_filename)
                except ValueError as e:
                    logger.error(f"[SESSION {session_id}] Invalid filename: {str(e)}")
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Invalid filename for chunk {chunk_counter}",
                        "chunk": chunk_counter
                    })
                    continue
                
                try:
                    with open(chunk_filepath, 'wb') as audio_file:
                        audio_file.write(audio_bytes)
                        audio_file.flush()             # Force flush buffers
                        os.fsync(audio_file.fileno())  # Force flush to disk at OS level
                    # File is now fully flushed and closed
                    
                    logger.info(f"[SESSION {session_id}] AUDIO CHUNK {chunk_counter} SAVED - File: {chunk_filename}")
                    logger.info(f"[SESSION {session_id}] AUDIO CHUNK {chunk_counter} SAVED - Path: {chunk_filepath}")

                    # Send acknowledgment back to client
                    await websocket.send_json({
                        "type": "audio_received",
                        "chunk": chunk_counter,
                        "filename": chunk_filename
                    })
                    
                    # Small delay to ensure file is fully written before processing
                    await asyncio.sleep(0.5)
                    
                    # Add to processing queue (background processing) with ICU data
                    audio_processor.add_chunk_to_queue(session_id, chunk_filepath, chunk_counter, icu_data)
                    
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
        try:
            await websocket.close()
        except:
            pass
    finally:
        # Clean up session resources
        try:
            await cleanup_session(session_id)
        except Exception as cleanup_error:
            logger.error(f"[SESSION {session_id}] Error during cleanup: {str(cleanup_error)}")

# Global variables for WebSocket connections and processing
active_connections = []
processing_lock = threading.Lock()
processed_files = set()

# Global dictionary to track session counts per user
user_session_counts = {}
user_session_counts_lock = threading.Lock()

def get_next_session_count(username: str) -> int:
    """Get the next session count for a user"""
    with user_session_counts_lock:
        if username not in user_session_counts:
            user_session_counts[username] = 0
        user_session_counts[username] += 1
        return user_session_counts[username]

def get_current_session_count(username: str) -> int:
    """Get the current session count for a user without incrementing"""
    with user_session_counts_lock:
        return user_session_counts.get(username, 0)

class AudioProcessor:
    def __init__(self):
        self.running = False
        self.thread = None
        self.processed_files = set()
        self.sessions = {}  # Store session info: {session_id: {dir, websocket, chunks, complete}}
        self.processing_queue = []  # Queue of chunks to process
        self.session_lock = threading.Lock()
        self.queue_lock = threading.Lock()
        self.max_queue_size = 20  # Prevent queue from growing too large
        self.processing_semaphore = threading.Semaphore(2)  # Limit concurrent processing
        self.session_cleanup_interval = 300  # Clean up old sessions every 5 minutes
        self.last_cleanup = time.time()
        
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
    
    def register_session(self, session_id: str, session_dir: str, websocket, username: str = None):
        """Register a new session for processing"""
        with self.session_lock:
            self.sessions[session_id] = {
                'dir': session_dir,
                'websocket': websocket,
                'username': username,
                'session_count': 0,  # Will be set when session is initialized
                'chunks': [],
                'complete': False,
                'websocket_active': True,
                'pending_messages': [],
                'total_chunks': 0,
                'processed_chunks': 0,
                'created_at': datetime.now()
            }
            logger.info(f"[PROCESSOR] Registered session {session_id} for user {username} - Total active sessions: {len(self.sessions)}")
    
    def add_chunk_to_queue(self, session_id: str, chunk_filepath: str, chunk_number: int, icu_data: dict = None):
        """Add a chunk to the processing queue with size limits and ICU data"""
        # Check queue size limit
        with self.queue_lock:
            if len(self.processing_queue) >= self.max_queue_size:
                logger.warning(f"[PROCESSOR] Queue full ({self.max_queue_size}), dropping chunk {chunk_number} for session {session_id}")
                return
        
        # Get username from session info
        username = "unknown"
        session_count = 1
        with self.session_lock:
            if session_id in self.sessions:
                session_username = self.sessions[session_id].get('username')
                session_count = self.sessions[session_id].get('session_count', 1)
                if session_username and session_username != "unknown":
                    username = session_username
                else:
                    # Try to extract username from session directory path as fallback
                    session_dir = self.sessions[session_id].get('dir', '')
                    if session_dir and '/audio/' in session_dir:
                        path_parts = session_dir.split('/')
                        if len(path_parts) >= 3 and path_parts[0] == 'audio':
                            potential_username = path_parts[1]
                            if potential_username and potential_username != 'session_' + session_id:
                                username = potential_username
        
        # Verify file exists before adding to queue (with retry)
        max_retries = 5
        for attempt in range(max_retries):
            if os.path.exists(chunk_filepath):
                logger.info(f"[PROCESSOR] File found on attempt {attempt + 1}: {chunk_filepath}")
                break
            if attempt < max_retries - 1:
                logger.warning(f"[PROCESSOR] File not found on attempt {attempt + 1}, retrying in 0.5s: {chunk_filepath}")
                time.sleep(0.5)
            else:
                logger.error(f"[PROCESSOR] Cannot add chunk {chunk_number} to queue - file does not exist after {max_retries} attempts: {chunk_filepath}")
                # Log directory contents for debugging
                dir_path = os.path.dirname(chunk_filepath)
                if os.path.exists(dir_path):
                    files = os.listdir(dir_path)
                    logger.error(f"[PROCESSOR] Directory contents of {dir_path}: {files}")
                else:
                    logger.error(f"[PROCESSOR] Directory does not exist: {dir_path}")
                return
        
        with self.queue_lock:
            self.processing_queue.append({
                'session_id': session_id,
                'username': username,
                'session_count': session_count,
                'filepath': chunk_filepath,
                'chunk_number': chunk_number,
                'icu_data': icu_data,
                'timestamp': datetime.now()
            })
            
            # Update session info
            with self.session_lock:
                if session_id in self.sessions:
                    self.sessions[session_id]['total_chunks'] = max(self.sessions[session_id]['total_chunks'], chunk_number)
            
            logger.info(f"[PROCESSOR] Added chunk {chunk_number} to queue for session {session_id} (user: {username}) - Queue size: {len(self.processing_queue)}")
    
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
    
    def update_session_username(self, session_id: str, username: str, session_count: int = None):
        """Update the username for an existing session"""
        with self.session_lock:
            if session_id in self.sessions:
                old_username = self.sessions[session_id].get('username', 'unknown')
                self.sessions[session_id]['username'] = username
                if session_count is not None:
                    self.sessions[session_id]['session_count'] = session_count
                logger.info(f"[PROCESSOR] Updated session {session_id} username: {old_username} -> {username}")
                return True
            else:
                logger.warning(f"[PROCESSOR] Cannot update username - session {session_id} not found")
                return False
    
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
        """Process audio chunks from the queue with concurrency control"""
        with self.queue_lock:
            if not self.processing_queue:
                return
            
            # Get next chunk to process
            chunk_info = self.processing_queue.pop(0)
        
        # Use semaphore to limit concurrent processing
        with self.processing_semaphore:
            session_id = chunk_info['session_id']
            username = chunk_info.get('username', 'unknown')
            session_count = chunk_info.get('session_count', 1)
            filepath = chunk_info['filepath']
            chunk_number = chunk_info['chunk_number']
            icu_data = chunk_info.get('icu_data', {})
        
        # Check if file still exists before processing
        if not os.path.exists(filepath):
            logger.warning(f"[PROCESSOR] File no longer exists, skipping chunk {chunk_number} for session {session_id}: {filepath}")
            
            # Try to find the file in the session directory (in case it was moved)
            with self.session_lock:
                if session_id in self.sessions:
                    session_dir = self.sessions[session_id].get('dir', '')
                    if session_dir and os.path.exists(session_dir):
                        # Look for the file in the session directory
                        filename = os.path.basename(filepath)
                        possible_path = os.path.join(session_dir, filename)
                        if os.path.exists(possible_path):
                            logger.info(f"[PROCESSOR] Found file at new location: {possible_path}")
                            filepath = possible_path
                        else:
                            # List all files in the directory for debugging
                            files = os.listdir(session_dir)
                            logger.warning(f"[PROCESSOR] Files in session directory {session_dir}: {files}")
            
            # If we still can't find the file, mark as processed and skip
            if not os.path.exists(filepath):
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
                return
        
        try:
            # Log ICU context for this chunk
            patient_name = icu_data.get('patient', {}).get('name', 'Unknown') if icu_data.get('patient') else 'Unknown'
            ward_name = icu_data.get('ward', {}).get('desc', 'Unknown') if icu_data.get('ward') else 'Unknown'
            user_name = icu_data.get('user', {}).get('loginname', 'Unknown') if icu_data.get('user') else 'Unknown'
            
            logger.info(f"[PROCESSOR] Processing chunk {chunk_number} for session {session_id} - Patient: {patient_name}, Ward: {ward_name}, User: {user_name}")
            logger.info(f"[PROCESSOR] File: {filepath}")

            
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
                # Create output data with ICU context
                output_data = {
                    "session_id": session_id,
                    "chunk": chunk_number,
                    "filename": filepath,
                    "text": transcription_text,
                    "confidence": result.get("confidence", 0.0),
                    "language": result.get("language", "en"),
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "icu_context": {
                        "patient": icu_data.get('patient'),
                        "ward": icu_data.get('ward'),
                        "user": icu_data.get('user'),
                        "username": icu_data.get('username', username)
                    }
                }
                
                # Save transcription to file
                self._save_transcription_output(session_id, chunk_number, output_data, username, session_count)
                
                # Send message directly to websocket with ICU context
                self._send_websocket_message_immediate(session_id, chunk_number, transcription_text, result, icu_data)
                
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
    

    
    def _save_transcription_output(self, session_id, chunk_number, output_data, username=None, session_count=None):
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
                json_file.flush()             # Force flush buffers
                os.fsync(json_file.fileno())  # Force flush to disk at OS level
            # File is now fully flushed and closed
            
            # Save/append to single session transcription file in transcriptions folder
            transcriptions_dir = "transcriptions"
            os.makedirs(transcriptions_dir, exist_ok=True)
            
            # Use provided username and session_count, or get from session info as fallback
            if username is None or username == "unknown":
                with self.session_lock:
                    if session_id in self.sessions:
                        session_username = self.sessions[session_id].get('username')
                        if session_username and session_username != "unknown":
                            username = session_username
                        else:
                            # Try to extract username from session directory path as fallback
                            session_dir = self.sessions[session_id].get('dir', '')
                            if session_dir and '/audio/' in session_dir:
                                path_parts = session_dir.split('/')
                                if len(path_parts) >= 3 and path_parts[0] == 'audio':
                                    potential_username = path_parts[1]
                                    if potential_username and potential_username != 'session_' + session_id:
                                        username = potential_username
                                        logger.info(f"[BACKGROUND] Extracted username '{username}' from session directory path")
            
            if session_count is None:
                with self.session_lock:
                    if session_id in self.sessions:
                        session_count = self.sessions[session_id].get('session_count', 1)
            
            # If username is still "unknown", log a warning
            if username == "unknown":
                logger.warning(f"[BACKGROUND] Username is 'unknown' for session {session_id}, transcription file may have incorrect name")
            
            # Create descriptive filename with ICU context: {session_count}_{username}_{patient}_{ward}_{date}_{time}.txt
            date_str = datetime.now().strftime('%Y%m%d')
            time_str = datetime.now().strftime('%H%M%S')
            
            # Extract ICU context for filename
            patient_name = "Unknown"
            ward_name = "Unknown"
            if output_data.get('icu_context'):
                patient_name = output_data['icu_context'].get('patient', {}).get('name', 'Unknown') if output_data['icu_context'].get('patient') else 'Unknown'
                ward_name = output_data['icu_context'].get('ward', {}).get('desc', 'Unknown') if output_data['icu_context'].get('ward') else 'Unknown'
                # Clean names for filename
                patient_name = re.sub(r'[^\w\-_. ]', '_', patient_name)[:20]  # Limit length and clean
                ward_name = re.sub(r'[^\w\-_. ]', '_', ward_name)[:20]  # Limit length and clean
            
            session_txt_filename = f"{session_count}_{username}_{patient_name}_{ward_name}_{date_str}_{time_str}.txt"
            session_txt_filepath = os.path.join(transcriptions_dir, session_txt_filename)
            
            # Log the filename being created for debugging
            logger.info(f"[BACKGROUND] Creating transcription file: {session_txt_filename} for session {session_id} with username: {username}")
            
            # Append transcription to session file (only content)
            with open(session_txt_filepath, 'a', encoding='utf-8') as session_file:
                session_file.write(f"{output_data['text']}\n")
                session_file.flush()             # Force flush buffers
                os.fsync(session_file.fileno())  # Force flush to disk at OS level
            # File is now fully flushed and closed
            
            logger.info(f"[BACKGROUND] Output saved - JSON: {json_filename}, Transcription appended to: {session_txt_filename}")
            
        except Exception as e:
            logger.error(f"[BACKGROUND] Error saving output: {str(e)}")
    
    def _send_websocket_message_immediate(self, session_id: str, chunk_number: int, transcription_text: str, result, icu_data: dict = None):
        """Send transcription result to websocket immediately with ICU context"""
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
                    "timestamp": int(datetime.now().timestamp() * 1000),  # Unix timestamp in milliseconds
                    "icu_context": {
                        "patient": icu_data.get('patient') if icu_data else None,
                        "ward": icu_data.get('ward') if icu_data else None,
                        "user": icu_data.get('user') if icu_data else None,
                        "username": icu_data.get('username') if icu_data else None
                    }
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
        current_time = time.time()
        
        # Only run cleanup periodically to avoid performance impact
        if current_time - self.last_cleanup < self.session_cleanup_interval:
            return
        
        self.last_cleanup = current_time
        
        with self.session_lock:
            sessions_to_remove = []
            
            for session_id, session_info in self.sessions.items():
                # Check for old sessions (older than 1 hour)
                session_age = current_time - session_info['created_at'].timestamp()
                if session_age > 3600:  # 1 hour
                    logger.info(f"[PROCESSOR] Removing old session {session_id} (age: {session_age/3600:.1f} hours)")
                    sessions_to_remove.append(session_id)
                    continue
                
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
                                sessions_to_remove.append(session_id)
            
            # Remove completed/old sessions
            for session_id in sessions_to_remove:
                session_info = self.sessions[session_id]
                session_dir = session_info.get('dir', '')
                del self.sessions[session_id]
                logger.info(f"[PROCESSOR] Removed session {session_id}")
                
                # Clean up files in background
                if session_dir:
                    self._cleanup_session_files(session_id, session_dir)
    
    def _cleanup_session_files(self, session_id: str, session_dir: str):
        """Clean up session files and directories"""
        try:
            import shutil
            import time
            
            # Wait a bit to ensure all files are processed
            time.sleep(2)
            
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

# ICU Care Lite Client Class
class ICUCareLiteClient:
    def __init__(self, base_url="https://icucarelite_demo.aixelink.com"):
        self.base_url = base_url
        self.session = None
        self.jwt_token = None
        self.setup_session()
    
    def setup_session(self):
        """Setup session with SSL bypass"""
        self.session = requests.Session()
        self.session.verify = False
        
        # SSL bypass for demo server
        class SSLAdapter(HTTPAdapter):
            def init_poolmanager(self, *args, **kwargs):
                context = create_urllib3_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                kwargs['ssl_context'] = context
                return super().init_poolmanager(*args, **kwargs)
        
        self.session.mount('https://', SSLAdapter())
    
    def login(self, username="tony", password="icu@123", code=""):
        """Login to ICU system and get JWT token"""
        logger.info(f"ICU Care Lite Login attempt for user: {username}")
        logger.info(f"ICU Care Lite Base URL: {self.base_url}")
        
        login_url = f"{self.base_url}/api/users/login"
        logger.info(f"ICU Care Lite Login URL: {login_url}")
        
        headers = {
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
            "Referer": f"{self.base_url}/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
        }
        logger.info(f"ICU Care Lite Request headers: {headers}")
        
        login_data = {
            "username": username,
            "password": password,
            "code": code
        }
        logger.info(f"ICU Care Lite Request data: {login_data}")
        
        try:
            logger.info(f"ICU Care Lite - Sending POST request to: {login_url}")
            response = self.session.post(login_url, json=login_data, headers=headers, timeout=30)
            
            logger.info(f"ICU Care Lite Response status code: {response.status_code}")
            logger.info(f"ICU Care Lite Response headers: {dict(response.headers)}")
            
            if response.status_code == 200:
                try:
                    response_data = response.json()
                    logger.info(f"ICU Care Lite Response data: {response_data}")
                    
                    if 'data' in response_data and 'accessToken' in response_data['data']:
                        self.jwt_token = response_data['data']['accessToken']
                        logger.info(f"ICU Care Lite login successful for user: {username}")
                        logger.info(f"ICU Care Lite JWT token obtained: {self.jwt_token[:20]}...")
                        return True
                    else:
                        logger.error(f"No access token in ICU Care Lite response. Full response: {response_data}")
                        return False
                except Exception as json_error:
                    logger.error(f"ICU Care Lite JSON parsing error: {json_error}")
                    logger.error(f"ICU Care Lite Raw response text: {response.text}")
                    return False
            else:
                logger.error(f"ICU Care Lite login failed with status {response.status_code}")
                try:
                    error_response = response.text
                    logger.error(f"ICU Care Lite Error response: {error_response}")
                except Exception as text_error:
                    logger.error(f"ICU Care Lite Error reading response text: {text_error}")
                return False
                
        except Exception as e:
            logger.error(f"ICU Care Lite login error: {e}")
            logger.error(f"ICU Care Lite error type: {type(e).__name__}")
            import traceback
            logger.error(f"ICU Care Lite traceback: {traceback.format_exc()}")
            return False
    
    def get_patient_list(self, shift_start="2025-09-26 14:00", shift_end="2025-09-26 22:00"):
        """Get patient list using JWT token"""
        if not self.jwt_token:
            logger.error("No JWT token available for ICU Care Lite. Please login first.")
            return None
        
        logger.info("ICU Care Lite - Getting patient list")
        logger.info(f"ICU Care Lite - Shift start: {shift_start}, Shift end: {shift_end}")
        logger.info(f"ICU Care Lite - JWT token available: {self.jwt_token[:20] if self.jwt_token else 'None'}...")
        
        api_url = f"{self.base_url}/api/dataplus"
        logger.info(f"ICU Care Lite - API URL: {api_url}")
        
        headers = {
            "Cache-Control": "no-cache",
            "Content-Type": "application/xml",
            "Referer": f"{self.base_url}/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
        }
        logger.info(f"ICU Care Lite - Request headers: {headers}")
        
        # XML request body
        xml_body = f"""<bd OrgUnitID="" ShiftStartDateTime="{shift_start}" ShiftEndDateTime="{shift_end}" jwt="{self.jwt_token}">
<wards>
    <ward conceptID="preceptward">
        <unitid conceptID="unitid"/>
        <desc conceptID="unitdescription"/>
        <code conceptID="unitcode"/>
        <capacity conceptID="unitcapacity"/>
    </ward>
</wards>

<securityrights conceptID="securityrights">
    <userid conceptID="userid"/>
    <loginname conceptID="loginname"/>
    <groupname conceptID="groupname"/>
    <rights conceptID="rights"/>
    <status conceptID="status"/>
    <wards conceptID="wards"/>
</securityrights>

<whiteboard>
    <entry conceptID="loadcurrentpatients">
        <patientid conceptID="patientid"/>
        <eventid conceptID="eventid"/>
        <name conceptID="name"/>
        <bed conceptID="bed"/>
        <bedid conceptID="bedid"/>
        <room conceptID="room"/>
        <ward conceptID="ward"/>
        <wardid conceptID="wardid"/>
        <hr conceptID="hr"/>
        <bo conceptID="sp02"/>
        <bp conceptID="bp"/>
        <adm conceptID="admission"/>
        <age conceptID="age"/>
        <gen conceptID="gender"/>
        <weight conceptID="weight"/>
        <diagnosis conceptID="diagnosis" />
        <nhino conceptID="nhino"/>
        <dischargedate conceptID="dischargedate"/>
        <ic conceptID="ic"/>
        <drname conceptID="drname"/>
    </entry>
</whiteboard>
</bd>"""
        
        logger.info(f"ICU Care Lite - XML request body length: {len(xml_body)} characters")
        logger.info(f"ICU Care Lite - XML request body preview: {xml_body[:200]}...")
        
        try:
            logger.info(f"ICU Care Lite - Sending POST request to: {api_url}")
            response = self.session.post(api_url, data=xml_body, headers=headers, timeout=30)
            
            logger.info(f"ICU Care Lite - Response status code: {response.status_code}")
            logger.info(f"ICU Care Lite - Response headers: {dict(response.headers)}")
            logger.info(f"ICU Care Lite - Response content length: {len(response.text)} characters")
            logger.info(f"ICU Care Lite - Response content preview: {response.text[:500]}...")
            
            if response.status_code == 200:
                logger.info("ICU Care Lite - Parsing patient data from XML response")
                result = self.parse_patient_data(response.text)
                if result:
                    logger.info(f"ICU Care Lite - Successfully parsed patient data: {result['summary']}")
                else:
                    logger.error("ICU Care Lite - Failed to parse patient data from XML response")
                return result
            else:
                logger.error(f"ICU Care Lite patient list request failed: {response.status_code}")
                logger.error(f"ICU Care Lite Error response: {response.text}")
                return None
                
        except Exception as e:
            logger.error(f"ICU Care Lite patient list error: {e}")
            logger.error(f"ICU Care Lite error type: {type(e).__name__}")
            import traceback
            logger.error(f"ICU Care Lite traceback: {traceback.format_exc()}")
            return None
    
    def parse_patient_data(self, xml_response):
        """Parse XML response and extract patient data"""
        logger.info(f"ICU Care Lite - Starting XML parsing, response length: {len(xml_response)} characters")
        logger.info(f"ICU Care Lite - XML response preview: {xml_response[:300]}...")
        
        try:
            logger.info("ICU Care Lite - Parsing XML with ElementTree")
            root = ET.fromstring(xml_response)
            logger.info(f"ICU Care Lite - XML root tag: {root.tag}")
            logger.info(f"ICU Care Lite - XML root attributes: {root.attrib}")
            
            # Extract data
            logger.info("ICU Care Lite - Extracting wards from XML")
            wards = root.findall(".//ward")
            logger.info(f"ICU Care Lite - Found {len(wards)} wards")
            
            logger.info("ICU Care Lite - Extracting users from XML")
            users = root.findall(".//securityrights")
            logger.info(f"ICU Care Lite - Found {len(users)} users")
            
            logger.info("ICU Care Lite - Extracting patients from XML")
            patients = root.findall(".//entry")
            logger.info(f"ICU Care Lite - Found {len(patients)} patients")
            
            logger.info(f"ICU Care Lite data retrieved - Wards: {len(wards)}, Users: {len(users)}, Patients: {len(patients)}")
            
            # Create structured data
            data = {
                "timestamp": datetime.now().isoformat(),
                "jwt_token": self.jwt_token,
                "summary": {
                    "total_wards": len(wards),
                    "total_users": len(users),
                    "total_patients": len(patients)
                },
                "wards": [],
                "users": [],
                "patients": []
            }
            
            # Extract wards
            logger.info("ICU Care Lite - Processing wards data")
            for i, ward in enumerate(wards):
                ward_data = {
                    "unitid": ward.findtext("unitid", ""),
                    "desc": ward.findtext("desc", ""),
                    "code": ward.findtext("code", ""),
                    "capacity": ward.findtext("capacity", "")
                }
                data["wards"].append(ward_data)
                if i < 3:  # Log first 3 wards for debugging
                    logger.info(f"ICU Care Lite - Ward {i+1}: {ward_data}")
            
            # Extract users
            logger.info("ICU Care Lite - Processing users data")
            for i, user in enumerate(users):
                user_data = {
                    "userid": user.findtext("userid", ""),
                    "loginname": user.findtext("loginname", ""),
                    "groupname": user.findtext("groupname", ""),
                    "rights": user.findtext("rights", ""),
                    "status": user.findtext("status", ""),
                    "wards": user.findtext("wards", "")
                }
                data["users"].append(user_data)
                if i < 3:  # Log first 3 users for debugging
                    logger.info(f"ICU Care Lite - User {i+1}: {user_data}")
            
            # Extract patients
            logger.info("ICU Care Lite - Processing patients data")
            for i, patient in enumerate(patients):
                patient_data = {
                    "patientid": patient.findtext("patientid", ""),
                    "eventid": patient.findtext("eventid", ""),
                    "name": patient.findtext("name", ""),
                    "bed": patient.findtext("bed", ""),
                    "bedid": patient.findtext("bedid", ""),
                    "room": patient.findtext("room", ""),
                    "ward": patient.findtext("ward", ""),
                    "wardid": patient.findtext("wardid", ""),
                    "hr": patient.findtext("hr", ""),
                    "sp02": patient.findtext("bo", ""),
                    "bp": patient.findtext("bp", ""),
                    "admission": patient.findtext("adm", ""),
                    "age": patient.findtext("age", ""),
                    "gender": patient.findtext("gen", ""),
                    "weight": patient.findtext("weight", ""),
                    "diagnosis": patient.findtext("diagnosis", ""),
                    "nhino": patient.findtext("nhino", ""),
                    "dischargedate": patient.findtext("dischargedate", ""),
                    "ic": patient.findtext("ic", ""),
                    "drname": patient.findtext("drname", "")
                }
                data["patients"].append(patient_data)
                if i < 3:  # Log first 3 patients for debugging
                    logger.info(f"ICU Care Lite - Patient {i+1}: {patient_data}")
            
            logger.info(f"ICU Care Lite - Successfully parsed all data: {data['summary']}")
            return data
            
        except ET.ParseError as e:
            logger.error(f"ICU Care Lite XML parsing error: {e}")
            logger.error(f"ICU Care Lite XML content that failed to parse: {xml_response[:1000]}...")
            return None
        except Exception as e:
            logger.error(f"ICU Care Lite unexpected error during XML parsing: {e}")
            logger.error(f"ICU Care Lite error type: {type(e).__name__}")
            import traceback
            logger.error(f"ICU Care Lite traceback: {traceback.format_exc()}")
            return None

# Configuration
ENABLE_AUTO_CLEANUP = False  # Set to False to disable automatic cleanup for debugging

# Initialize audio processor
audio_processor = AudioProcessor()

# Background task storage for long audio processing
background_tasks = {}
task_lock = threading.Lock()

async def process_audio_background(task_id: str, audio_bytes: bytes, filename: str, language: str, task_type: str):
    """Process audio in background and store results"""
    try:
        logger.info(f"Background task {task_id}: Starting transcription of {filename}")
        
        # Update task status
        with task_lock:
            background_tasks[task_id] = {
                "status": "processing",
                "progress": 0,
                "started_at": datetime.now().isoformat(),
                "filename": filename
            }
        
        # Process audio
        result = transcribe_audio_bytes(audio_bytes, task_id)
        
        # Add metadata
        result.update({
            "filename": filename,
            "file_size": len(audio_bytes),
            "language": language,
            "task": task_type,
            "timestamp": datetime.now().isoformat(),
            "task_id": task_id
        })
        
        # Save transcription to file
        save_transcription_to_file(filename, result)
        
        # Update task status to completed
        with task_lock:
            background_tasks[task_id] = {
                "status": "completed",
                "progress": 100,
                "completed_at": datetime.now().isoformat(),
                "result": result,
                "filename": filename
            }
        
        logger.info(f"Background task {task_id}: Transcription completed for {filename}")
        
    except Exception as e:
        logger.error(f"Background task {task_id}: Error processing {filename}: {str(e)}")
        with task_lock:
            background_tasks[task_id] = {
                "status": "failed",
                "error": str(e),
                "failed_at": datetime.now().isoformat(),
                "filename": filename
            }

async def cleanup_session(session_id):
    """Clean up session resources"""
    with audio_processor.session_lock:
        if session_id in audio_processor.sessions:
            session_info = audio_processor.sessions[session_id]
            session_dir = session_info.get('dir', '')
            
            # Close websocket if still open
            if 'websocket' in session_info:
                try:
                    await session_info['websocket'].close()
                except:
                    pass
            
            # Remove session from processor
            del audio_processor.sessions[session_id]
            
            # Clean up files in background (if enabled)
            if session_dir and ENABLE_AUTO_CLEANUP:
                _cleanup_session_files(session_id, session_dir)
            elif session_dir and not ENABLE_AUTO_CLEANUP:
                logger.info(f"[SESSION {session_id}] Auto-cleanup disabled - session directory preserved: {session_dir}")


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
        host="192.168.1.21",  # Listen on all interfaces for server deployment
        port=8111,
        timeout_keep_alive=3600,  # 1 hour keep-alive timeout
        timeout_graceful_shutdown=60,  # 1 minute graceful shutdown
        access_log=True,
        # Performance optimizations
        workers=1,  # Single worker for better memory usage
        loop="asyncio",  # Use asyncio event loop
        # Response time optimizations
        limit_concurrency=1000,  # Limit concurrent connections
        limit_max_requests=10000,  # Restart worker after 10k requests
        backlog=2048,  # Increase backlog for better connection handling
    )
