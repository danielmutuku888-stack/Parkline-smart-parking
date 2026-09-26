@echo off
cd /d "%~dp0"
echo Starting Parkline Smart Parking at http://localhost:8765/
python server.py
pause