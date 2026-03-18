const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── 問題読み込み ─────────────────────────────────────────
function loadQuestions() {
  try {
    delete require.cache[require.resolve('./questions')];
    return require('./questions');
  } catch (e) {
    console.error('questions.js 読み込みエラー:', e.message);
    return [];
  }
}
let questions = loadQuestions();

// ─── 設定 ─────────────────────────────────────────────────
const QUESTION_TIME = 20;
const MAX_POINTS = 1000;
const MIN_POINTS = 100;

// ─── ゲーム状態 ───────────────────────────────────────────
let gameState = {
  phase: 'waiting',
  currentQ: -1,
  questionStart: null,
  answers: {},
  players: {},
  hostId: null,
  fastestAnswer: null,
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

function makeSessionKey() {
  return Math.random().toString(36).slice(2, 12);
}

// ─── WebSocket ────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.playerId = Math.random().toString(36).slice(2, 10);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

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

      case 'player_join': {
        const name = (msg.name || '').trim().slice(0, 12) || '名無し';
        const sessionKey = makeSessionKey();
        ws.playerName = name;
        ws.sessionKey = sessionKey;
        gameState.players[ws.playerId] = { name, score: 0, isHost: false, connected: true, sessionKey };
        sendTo(ws, {
          type: 'joined',
          playerId: ws.playerId,
          sessionKey,
          name,
          score: 0,
          phase: gameState.phase,
          ...(gameState.phase === 'question' ? {
            question: getQuestionForClient(gameState.currentQ),
            elapsed: Date.now() - gameState.questionStart,
          } : {}),
          ...(gameState.phase === 'answer' || gameState.phase === 'ranking' ? {
            ranking: getRanking(),
          } : {}),
        });
        broadcast({ type: 'player_count', count: Object.values(gameState.players).filter(p => !p.isHost).length });
        break;
      }

      // 再接続（点数復元）
      case 'player_reconnect': {
        const { sessionKey, name } = msg;
        const existing = Object.entries(gameState.players).find(
          ([, p]) => p.sessionKey === sessionKey && !p.isHost
        );
        if (existing) {
          const [oldId, player] = existing;
          delete gameState.players[oldId];
          player.connected = true;
          gameState.players[ws.playerId] = player;
          ws.playerName = player.name;
          ws.sessionKey = sessionKey;
          // 回答済みデータも新IDに移行
          if (gameState.answers[oldId]) {
            gameState.answers[ws.playerId] = gameState.answers[oldId];
            delete gameState.answers[oldId];
          }
          sendTo(ws, {
            type: 'reconnected',
            playerId: ws.playerId,
            sessionKey,
            name: player.name,
            score: player.score,
            phase: gameState.phase,
            ranking: getRanking(),
            ...(gameState.phase === 'question' ? {
              question: getQuestionForClient(gameState.currentQ),
              elapsed: Date.now() - gameState.questionStart,
              alreadyAnswered: !!gameState.answers[ws.playerId],
            } : {}),
          });
        } else {
          const newName = (name || '').trim().slice(0, 12) || '名無し';
          const newKey = makeSessionKey();
          ws.playerName = newName;
          ws.sessionKey = newKey;
          gameState.players[ws.playerId] = { name: newName, score: 0, isHost: false, connected: true, sessionKey: newKey };
          sendTo(ws, { type: 'joined', playerId: ws.playerId, sessionKey: newKey, name: newName, score: 0, phase: gameState.phase });
        }
        broadcast({ type: 'player_count', count: Object.values(gameState.players).filter(p => !p.isHost).length });
        break;
      }

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
        gameState.fastestAnswer = null;
        broadcast({ type: 'question_start', question: getQuestionForClient(nextIdx) });
        setTimeout(() => {
          if (gameState.currentQ === nextIdx && gameState.phase === 'question') {
            revealAnswer(nextIdx);
          }
        }, QUESTION_TIME * 1000 + 500);
        break;
      }

      case 'reveal_answer': {
        if (!ws.isHost) break;
        revealAnswer(gameState.currentQ);
        break;
      }

      case 'show_ranking': {
        if (!ws.isHost) break;
        gameState.phase = 'ranking';
        broadcast({ type: 'ranking', ranking: getRanking() });
        break;
      }

      case 'answer': {
        if (gameState.phase !== 'question') break;
        if (gameState.answers[ws.playerId]) break;
        const timeMs = Date.now() - gameState.questionStart;
        if (timeMs > QUESTION_TIME * 1000) break;
        gameState.answers[ws.playerId] = { choice: msg.choice, timeMs };
        sendTo(ws, { type: 'answer_received', choice: msg.choice });
        const answerCount = Object.keys(gameState.answers).length;
        const playerCount = Object.values(gameState.players).filter(p => !p.isHost).length;
        broadcast({ type: 'answer_progress', answered: answerCount, total: playerCount });
        break;
      }

      case 'update_questions': {
        if (!ws.isHost) break;
        questions = msg.questions;
        sendTo(ws, { type: 'questions_updated', count: questions.length });
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
  let fastest = null;

  Object.entries(gameState.answers).forEach(([pid, ans]) => {
    if (ans.choice === correct) {
      const pts = calcPoints(ans.timeMs);
      if (gameState.players[pid]) {
        gameState.players[pid].score += pts;
        ans.points = pts;
      }
      if (!fastest || ans.timeMs < fastest.timeMs) {
        fastest = { name: gameState.players[pid]?.name || '?', timeMs: ans.timeMs };
      }
    }
  });

  gameState.fastestAnswer = fastest;

  broadcast({
    type: 'answer_reveal',
    correct,
    answers: gameState.answers,
    ranking: getRanking(),
    fastest,
  });
}

// ─── HTTP API ─────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const url = `${proto}://${host}/play`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ qr: dataUrl, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/questions', (req, res) => res.json(questions));
app.get('/api/state', (req, res) => res.json({
  phase: gameState.phase, currentQ: gameState.currentQ,
  totalQ: questions.length,
  playerCount: Object.values(gameState.players).filter(p => !p.isHost).length,
  ranking: getRanking(),
}));

app.get('/host',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎉 Wedding Quiz Server running on port ${PORT}`);
  console.log(`   幹事画面:   http://localhost:${PORT}/host`);
  console.log(`   参加者画面: http://localhost:${PORT}/play`);
  console.log(`   管理画面:   http://localhost:${PORT}/admin\n`);
});
