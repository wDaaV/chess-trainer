// ============================================================================
// Chess Trainer — logica dell'applicazione
// Librerie usate: chess.js (regole/stato partita) + chessboard.js (interfaccia)
// Motore: Stockfish 18 (build lite-single) eseguito in un Web Worker
// ============================================================================

import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

// ---------------------------------------------------------------------------
// Stato dell'applicazione
// ---------------------------------------------------------------------------
const chess = new Chess();
let board = null;
let boardLocked = true;      // true finché il motore non è pronto o sta analizzando
let analysisDepth = 14;      // profondità di ricerca UCI (modificabile dal menu)
let currentAnalysis = null;  // cache dell'analisi della posizione corrente (evita richieste doppie)
let plyCount = 0;

// ---------------------------------------------------------------------------
// Riferimenti al DOM
// ---------------------------------------------------------------------------
const engineStatusEl = document.getElementById('engineStatus');
const moveListEl = document.getElementById('moveList');
const evalFillEl = document.getElementById('evalFill');
const evalScoreEl = document.getElementById('evalScore');

function setEngineStatus(text) {
  engineStatusEl.textContent = text;
}

// ---------------------------------------------------------------------------
// Motore Stockfish (Web Worker + protocollo UCI)
// ---------------------------------------------------------------------------
const engine = new Worker('engine/stockfish-18-lite-single.js');

let engineReady = false;
let resolveEngineReady;
const engineReadyPromise = new Promise((res) => { resolveEngineReady = res; });

let pendingAnalysis = null; // { resolve, lastScore }

function sendToEngine(cmd) {
  engine.postMessage(cmd);
}

engine.onmessage = (event) => {
  const line = event.data;
  if (typeof line !== 'string') return;

  if (line === 'uciok') {
    sendToEngine('isready');
  } else if (line === 'readyok') {
    engineReady = true;
    resolveEngineReady();
  } else if (pendingAnalysis) {
    if (line.startsWith('info') && line.indexOf(' score ') !== -1) {
      const parsed = parseInfoLine(line);
      if (parsed) pendingAnalysis.lastScore = parsed;
    } else if (line.startsWith('bestmove')) {
      const bestMoveUci = line.split(' ')[1];
      const finished = pendingAnalysis;
      pendingAnalysis = null;
      finished.resolve({ bestMoveUci, score: finished.lastScore });
    }
  }
};

engine.onerror = (err) => {
  console.error('Errore nel Web Worker di Stockfish:', err);
  setEngineStatus('Errore nel caricamento del motore. Controlla la console (F12) e verifica i percorsi dei file in engine/.');
};

sendToEngine('uci');

// Estrae "score cp X" o "score mate X" da una riga "info ..." del motore
function parseInfoLine(line) {
  const mateMatch = line.match(/score mate (-?\d+)/);
  if (mateMatch) return { mate: parseInt(mateMatch[1], 10) };

  const cpMatch = line.match(/score cp (-?\d+)/);
  if (cpMatch) return { cp: parseInt(cpMatch[1], 10) };

  return null;
}

// Avvia un'analisi sulla posizione data (FEN) e restituisce una Promise
// con la mossa migliore (notazione UCI) e la valutazione trovata.
function analyzePosition(fen, depth) {
  return new Promise((resolve) => {
    pendingAnalysis = { resolve, lastScore: null };
    sendToEngine('position fen ' + fen);
    sendToEngine('go depth ' + depth);
  });
}

// Converte un punteggio { cp } oppure { mate } in un valore numerico in centipedoni
function scoreToCp(score) {
  if (!score) return 0;
  if (score.mate !== undefined) {
    const sign = score.mate > 0 ? 1 : -1;
    return sign * (100000 - Math.abs(score.mate) * 100);
  }
  return score.cp;
}

// Formatta un punteggio per la visualizzazione (es. "+0.35" oppure "#+3")
// sideToMove: 'w' o 'b', il colore a cui è riferito lo score (chi deve muovere in quella posizione)
function formatScore(score, sideToMove) {
  if (!score) return '0.00';
  if (score.mate !== undefined) {
    const mateForWhite = sideToMove === 'w' ? score.mate : -score.mate;
    return (mateForWhite > 0 ? '#+' : '#-') + Math.abs(mateForWhite);
  }
  const whiteCp = sideToMove === 'w' ? score.cp : -score.cp;
  const pawns = (whiteCp / 100).toFixed(2);
  return (whiteCp > 0 ? '+' : '') + pawns;
}

function updateEvalBar(score, sideToMove) {
  const cp = scoreToCp(score);
  const whiteCp = sideToMove === 'w' ? cp : -cp;
  const clamped = Math.max(-1000, Math.min(1000, whiteCp));
  const pct = 50 + (clamped / 1000) * 50;
  evalFillEl.style.width = pct + '%';
  evalScoreEl.textContent = formatScore(score, sideToMove);
}

// Converte una mossa in notazione UCI (es. "e2e4") in SAN (es. "e4"),
// usando una copia temporanea della partita nella posizione data.
function uciToSan(fen, uciMove) {
  if (!uciMove || uciMove.length < 4) return '—';
  const temp = new Chess(fen);
  const from = uciMove.slice(0, 2);
  const to = uciMove.slice(2, 4);
  const promotion = uciMove.length > 4 ? uciMove.slice(4) : undefined;
  try {
    const move = temp.move({ from, to, promotion });
    return move.san;
  } catch (e) {
    return uciMove;
  }
}

// Classifica la mossa in base alla perdita in centipedoni rispetto alla mossa migliore
function classifyMove(centipawnLoss, isBestMove) {
  if (isBestMove || centipawnLoss < 10) return { label: 'Ottima mossa', css: 'best' };
  if (centipawnLoss < 25) return { label: 'Buona mossa', css: 'good' };
  if (centipawnLoss < 50) return { label: 'Imprecisione', css: 'inaccuracy' };
  if (centipawnLoss < 100) return { label: 'Errore', css: 'mistake' };
  return { label: 'Errore grave', css: 'blunder' };
}

// ---------------------------------------------------------------------------
// Pipeline di analisi eseguita dopo ogni mossa dell'utente
// ---------------------------------------------------------------------------
async function ensureInitialAnalysis() {
  if (!currentAnalysis) {
    currentAnalysis = await analyzePosition(chess.fen(), analysisDepth);
  }
}

async function processMove(moveObj, fenBefore, fenAfter) {
  boardLocked = true;
  setEngineStatus('Stockfish sta analizzando la mossa…');

  // Analisi "prima" della mossa (di solito già in cache dalla mossa precedente)
  if (!currentAnalysis) {
    currentAnalysis = await analyzePosition(fenBefore, analysisDepth);
  }
  const beforeAnalysis = currentAnalysis;

  // Analisi "dopo" la mossa: diventerà la cache per la prossima mossa
  const afterAnalysis = await analyzePosition(fenAfter, analysisDepth);
  currentAnalysis = afterAnalysis;

  // Valutazioni, entrambe riportate al punto di vista di chi ha mosso
  const cpBeforeFromMover = scoreToCp(beforeAnalysis.score);
  const cpAfterFromMover = -scoreToCp(afterAnalysis.score);
  const centipawnLoss = Math.max(0, cpBeforeFromMover - cpAfterFromMover);

  const bestSan = uciToSan(fenBefore, beforeAnalysis.bestMoveUci);
  const playedUci = moveObj.from + moveObj.to + (moveObj.promotion || '');
  const isBestMove = playedUci === beforeAnalysis.bestMoveUci;

  const classification = classifyMove(centipawnLoss, isBestMove);

  addMoveToList(moveObj, bestSan, classification, isBestMove);
  updateEvalBar(afterAnalysis.score, chess.turn());

  if (chess.isGameOver()) {
    setEngineStatus(getGameOverText());
  } else {
    setEngineStatus('Tocca a te: muove il ' + (chess.turn() === 'w' ? 'bianco' : 'nero') + '.');
  }

  boardLocked = false;
}

function getGameOverText() {
  if (chess.isCheckmate()) return 'Scacco matto! Partita terminata.';
  if (chess.isStalemate()) return 'Stallo: partita patta.';
  if (chess.isThreefoldRepetition()) return 'Patta per tripla ripetizione.';
  if (chess.isInsufficientMaterial()) return 'Patta per materiale insufficiente.';
  if (chess.isDraw()) return 'Partita patta.';
  return 'Partita terminata.';
}

// ---------------------------------------------------------------------------
// Pannello elenco mosse
// ---------------------------------------------------------------------------
function addMoveToList(moveObj, bestSan, classification, isBestMove) {
  plyCount++;
  const moveNumber = Math.ceil(plyCount / 2);
  const isWhiteMove = moveObj.color === 'w';

  const item = document.createElement('div');
  item.className = 'move-item ' + classification.css;

  const header = document.createElement('div');
  header.className = 'move-item-header';
  header.textContent = (isWhiteMove ? moveNumber + '. ' : moveNumber + '… ') + moveObj.san;

  const badge = document.createElement('span');
  badge.className = 'badge ' + classification.css;
  badge.textContent = classification.label;
  header.appendChild(badge);

  const detail = document.createElement('div');
  detail.className = 'move-item-detail';
  detail.textContent = isBestMove
    ? 'Hai giocato la mossa migliore secondo Stockfish.'
    : 'Mossa migliore secondo Stockfish: ' + bestSan;

  item.appendChild(header);
  item.appendChild(detail);
  moveListEl.appendChild(item);
  moveListEl.scrollTop = moveListEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Scacchiera (chessboard.js) e gestione delle mosse dell'utente
// ---------------------------------------------------------------------------
function onDragStart(source, piece) {
  if (boardLocked) return false;
  if (chess.isGameOver()) return false;
  const isWhitePiece = piece.startsWith('w');
  if ((chess.turn() === 'w' && !isWhitePiece) || (chess.turn() === 'b' && isWhitePiece)) {
    return false;
  }
}

function onDrop(source, target) {
  const fenBefore = chess.fen();
  let moveObj;
  try {
    // La promozione viene sempre effettuata a Donna per semplicità
    moveObj = chess.move({ from: source, to: target, promotion: 'q' });
  } catch (err) {
    return 'snapback';
  }
  const fenAfter = chess.fen();
  processMove(moveObj, fenBefore, fenAfter);
}

function onSnapEnd() {
  board.position(chess.fen());
}

function newGame() {
  chess.reset();
  board.start();
  currentAnalysis = null;
  plyCount = 0;
  moveListEl.innerHTML = '';
  updateEvalBar({ cp: 0 }, 'w');
  boardLocked = true;
  setEngineStatus('Nuova partita. Calcolo la posizione iniziale…');
  ensureInitialAnalysis().then(() => {
    boardLocked = false;
    setEngineStatus('Muove il bianco.');
  });
}

function undoMove() {
  const undone = chess.undo();
  if (!undone) return;
  board.position(chess.fen());
  currentAnalysis = null; // la cache non è più valida: verrà ricalcolata alla prossima mossa
  plyCount = Math.max(0, plyCount - 1);
  if (moveListEl.lastElementChild) moveListEl.lastElementChild.remove();
  setEngineStatus('Mossa annullata. Tocca al ' + (chess.turn() === 'w' ? 'bianco' : 'nero') + '.');
}

function flipBoard() {
  board.flip();
}

// ---------------------------------------------------------------------------
// Inizializzazione
// ---------------------------------------------------------------------------
board = Chessboard('board', {
  draggable: true,
  position: 'start',
  pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png',
  onDragStart,
  onDrop,
  onSnapEnd
});

window.addEventListener('resize', () => board.resize());

document.getElementById('newGameBtn').addEventListener('click', newGame);
document.getElementById('undoBtn').addEventListener('click', undoMove);
document.getElementById('flipBtn').addEventListener('click', flipBoard);
document.getElementById('depthSelect').addEventListener('change', (e) => {
  analysisDepth = parseInt(e.target.value, 10);
  currentAnalysis = null; // ricalcola con la nuova profondità dalla prossima mossa
});

engineReadyPromise.then(async () => {
  setEngineStatus('Motore pronto. Calcolo la posizione iniziale…');
  await ensureInitialAnalysis();
  boardLocked = false;
  setEngineStatus('Muove il bianco.');
});