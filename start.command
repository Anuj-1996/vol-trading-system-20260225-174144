#!/bin/zsh
cd "$(dirname "$0")"

echo "🔄 Stopping any existing processes..."
pkill -f uvicorn 2>/dev/null || true
pkill -f 'vite' 2>/dev/null || true
lsof -nP -iTCP:8000 -sTCP:LISTEN -t | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -nP -iTCP:5173 -sTCP:LISTEN -t | xargs -I{} kill -9 {} 2>/dev/null || true
sleep 1

echo "🚀 Starting backend on port 8000..."
source .venv/bin/activate
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 > backend.log 2>&1 &
BACKEND_PID=$!

echo "🚀 Starting frontend on port 5173..."
cd frontend
npm run dev -- --host 0.0.0.0 --port 5173 > ../frontend.log 2>&1 &
FRONTEND_PID=$!
cd ..

sleep 3

echo ""
echo "✅ Full stack started!"
echo "   Backend:  http://localhost:8000"
echo "   Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both servers."
echo ""

cleanup() {
    echo ""
    echo "🛑 Shutting down..."
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    wait $BACKEND_PID 2>/dev/null
    wait $FRONTEND_PID 2>/dev/null
    echo "Done."
    exit 0
}

trap cleanup INT TERM

wait
