const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const path = require('path');
const questions = require('./questions');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── ゲーム状態 ───────────────────────────────────────────
const QUESTION_TIME = 20; // 秒
const MAX_POINTS = 1000;
const MIN_POINTS = 100;

let gameState = {
  phase: 'waiting',      // waiting | question | answer | ranking | finished
  currentQ: -1,
  questionStart: null,
  answers: {},           // playerId -> { choice, timeMs, points }
  players: {},           // playerId -> { name, score, connected }
  hostId: null,
};

// ─── ユーティリティ ────────────────────────────────────────
function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.playerId !== excludeId) {
      ws.send(msg);
    }
  });
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getRanking() {
  return Object.entries(gameState.players)
    .filter(([, p]) => !p.isHost)
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function calcPoints(timeMs) {
  const ratio = Math.max(0, 1 - timeMs / (QUESTION_TIME * 1000));
  return Math.round(MIN_POINTS + (MAX_POINTS - MIN_POINTS) * ratio);
}

function getQuestionForClient(idx) {
  const q = questions[idx];
  return {
    index: idx,
    total: questions.length,
    question: q.question,
    choices: q.choices,
    hint: q.hint,
    timeLimit: QUESTION_TIME,
  };
}

// ─── WebSocket ────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.playerId = Math.random().toString(36).slice(2, 10);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // 幹事が接続
      case 'host_join': {
        ws.isHost = true;
        ws.playerId = 'host_' + ws.playerId;
        gameState.hostId = ws.playerId;
        gameState.players[ws.playerId] = { name: 'HOST', score: 0, isHost: true, connected: true };
        sendTo(ws, {
          type: 'host_joined',
          playerId: ws.playerId,
          playerCount: Object.values(gameState.players).filter(p => !p.isHost).length,
          ranking: getRanking(),
          phase: gameState.phase,
          currentQ: gameState.currentQ,
          totalQ: questions.length,
        });
        break;
      }

      // 参加者が名前登録
      case 'player_join': {
        const name = (msg.name || '').trim().slice(0, 12) || '名無し';
        ws.playerName = name;
        gameState.players[ws.playerId] = { name, score: 0, isHost: false, connected: true };
        sendTo(ws, {
          type: 'joined',
          playerId: ws.playerId,
          name,
          phase: gameState.phase,
          ...(gameState.phase === 'question' ? {
            question: getQuestionForClient(gameState.currentQ),
            elapsed: Date.now() - gameState.questionStart,
          } : {}),
        });
        // 幹事に人数通知
        broadcast({ type: 'player_count', count: Object.values(gameState.players).filter(p => !p.isHost).length });
        break;
      }

      // 幹事：次の問題へ
      case 'next_question': {
        if (!ws.isHost) break;
        const nextIdx = gameState.currentQ + 1;
        if (nextIdx >= questions.length) {
          gameState.phase = 'finished';
          broadcast({ type: 'game_finished', ranking: getRanking() });
          break;
        }
        gameState.currentQ = nextIdx;
        gameState.phase = 'question';
        gameState.questionStart = Date.now();
        gameState.answers = {};

        broadcast({
          type: 'question_start',
          question: getQuestionForClient(nextIdx),
        });

        // タイムアップ自動処理
        setTimeout(() => {
          if (gameState.currentQ === nextIdx && gameState.phase === 'question') {
            revealAnswer(nextIdx);
          }
        }, QUESTION_TIME * 1000 + 500);
        break;
      }

      // 幹事：正解を手動で発表
      case 'reveal_answer': {
        if (!ws.isHost) break;
        revealAnswer(gameState.currentQ);
        break;
      }

      // 幹事：ランキング表示
      case 'show_ranking': {
        if (!ws.isHost) break;
        gameState.phase = 'ranking';
        broadcast({ type: 'ranking', ranking: getRanking() });
        break;
      }

      // 参加者：回答送信
      case 'answer': {
        if (gameState.phase !== 'question') break;
        if (gameState.answers[ws.playerId]) break; // 二重回答防止
        const timeMs = Date.now() - gameState.questionStart;
        if (timeMs > QUESTION_TIME * 1000) break;
        gameState.answers[ws.playerId] = {
          choice: msg.choice,
          timeMs,
        };
        sendTo(ws, { type: 'answer_received', choice: msg.choice });
        // 幹事に回答数通知
        const answerCount = Object.keys(gameState.answers).length;
        const playerCount = Object.values(gameState.players).filter(p => !p.isHost).length;
        broadcast({ type: 'answer_progress', answered: answerCount, total: playerCount });
        break;
      }

      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (gameState.players[ws.playerId]) {
      gameState.players[ws.playerId].connected = false;
    }
  });
});

function revealAnswer(qIdx) {
  if (gameState.phase !== 'question' && gameState.phase !== 'answer') return;
  gameState.phase = 'answer';
  const correct = questions[qIdx].correct;

  // ポイント加算
  Object.entries(gameState.answers).forEach(([pid, ans]) => {
    if (ans.choice === correct) {
      const pts = calcPoints(ans.timeMs);
      if (gameState.players[pid]) {
        gameState.players[pid].score += pts;
        ans.points = pts;
      }
    }
  });

  broadcast({
    type: 'answer_reveal',
    correct,
    answers: gameState.answers,
    ranking: getRanking(),
  });
}

// ─── HTTP API ─────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const host = req.headers.host;
  const url = `http://${host}/play`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ qr: dataUrl, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/state', (req, res) => {
  res.json({
    phase: gameState.phase,
    currentQ: gameState.currentQ,
    totalQ: questions.length,
    playerCount: Object.values(gameState.players).filter(p => !p.isHost).length,
    ranking: getRanking(),
  });
});

// ─── 起動 ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎉 Wedding Quiz Server running!`);
  console.log(`   幹事画面: http://localhost:${PORT}/host`);
  console.log(`   参加者画面: http://localhost:${PORT}/play\n`);
});
