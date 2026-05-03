#!/bin/bash
pkill -f "electron.*claude" 2>/dev/null
pkill -f "claude-desktop" 2>/dev/null
echo "Claude Desktop stopped."
