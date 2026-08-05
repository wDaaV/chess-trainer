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
let boardFlipped = false;    // tiene traccia dell'orientamento corrente della scacchiera
let selectedSquare = null;   // casella del pezzo selezionato per il "click-to-move"
let wasAlreadySelected = false; // vedi onDragStart/onDrop: distingue un "click" di nuova selezione da un "click" di deselezione sullo stesso pezzo già selezionato
let lastEvalScore = { cp: 0 };   // ultimo punteggio ricevuto dal motore (per ricalcolo al flip)
let lastEvalSideToMove = 'w';    // lato a cui era riferito l'ultimo punteggio
let plyHistory = [];       // pila con un record per ogni mossa giocata
let currentRowEl = null;   // riga (bianco+nero) attualmente in costruzione

// ---------------------------------------------------------------------------
// Riferimenti al DOM
// ---------------------------------------------------------------------------
const engineStatusEl = document.getElementById('engineStatus');
const moveListEl = document.getElementById('moveList');
const evalFillEl = document.getElementById('evalFill');
const evalScoreEl = document.getElementById('evalScore');
const evalBarWrapEl = document.getElementById('evalBarWrap');
const moveListInnerEl = document.getElementById('moveListInner');

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

// Formatta un punteggio per la visualizzazione (es. "+0.35" oppure "#+3").
// sideToMove: 'w' o 'b', il colore a cui è riferito lo score (chi deve muovere in quella posizione).
// flipped: se true, il punteggio viene riferito al lato in basso sulla scacchiera
// (che dopo un "gira scacchiera" è il nero) invece che sempre al bianco:
// basta invertire il segno del valore altrimenti calcolato per il bianco.
function formatScore(score, sideToMove, flipped) {
  if (!score) return '0.00';
  if (score.mate !== undefined) {
    let mateValue = sideToMove === 'w' ? score.mate : -score.mate; // riferito al bianco
    if (flipped) mateValue = -mateValue;                           // riferito al lato in basso
    return (mateValue > 0 ? '#+' : '#-') + Math.abs(mateValue);
  }
  let cpValue = sideToMove === 'w' ? score.cp : -score.cp; // riferito al bianco
  if (flipped) cpValue = -cpValue;                          // riferito al lato in basso
  const pawns = (cpValue / 100).toFixed(2);
  return (cpValue > 0 ? '+' : '') + pawns;
}

// Aggiorna la barra di valutazione verticale.
// Il riempimento resta sempre calcolato rispetto al bianco (il ribaltamento
// visivo è affidato allo scaleY(-1) via CSS sulla classe "flipped"), mentre
// il testo del punteggio, mostrato sotto la barra, viene ricalcolato rispetto
// al lato attualmente in basso sulla scacchiera tramite formatScore().
function updateEvalBar(score, sideToMove) {
  lastEvalScore = score;
  lastEvalSideToMove = sideToMove;

  const cp = scoreToCp(score);
  const whiteCp = sideToMove === 'w' ? cp : -cp;
  const clamped = Math.max(-1000, Math.min(1000, whiteCp));
  const pct = 50 + (clamped / 1000) * 50;
  evalFillEl.style.height = pct + '%';
  evalScoreEl.textContent = formatScore(score, sideToMove, boardFlipped);
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

  const listRefs = addMoveToList(moveObj, bestSan, classification, isBestMove);
  plyHistory.push({
    rowEl: listRefs.rowEl,
    itemEl: listRefs.itemEl,
    createdRow: listRefs.createdRow,
    evalScoreBefore: beforeAnalysis.score,
    evalSideBefore: moveObj.color
  });
  updateEvalBar(afterAnalysis.score, chess.turn());

  if (chess.isGameOver()) {
    setEngineStatus(getGameOverText());
  } else {
    setEngineStatus('Tocca al ' + (chess.turn() === 'w' ? 'bianco' : 'nero') + '.');
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
// Pannello elenco mosse (due colonne: bianco / nero)
// ---------------------------------------------------------------------------
function addMoveToList(moveObj, bestSan, classification, isBestMove) {
  plyCount++;
  const moveNumber = Math.ceil(plyCount / 2);
  const isWhiteMove = moveObj.color === 'w';

  const item = document.createElement('div');
  item.className = 'move-item ' + classification.css;

  const header = document.createElement('div');
  header.className = 'move-item-header';
  header.textContent = (isWhiteMove ? moveNumber + '. ' : moveNumber + '. ') + moveObj.san;

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

  let createdRow = false;
  if (isWhiteMove || !currentRowEl) {
    currentRowEl = document.createElement('div');
    currentRowEl.className = 'move-row';
    moveListInnerEl.prepend(currentRowEl);   // in cima, non in coda: è la "pila"
    createdRow = true;
  }
  currentRowEl.appendChild(item);
  moveListEl.scrollTop = 0;

  return { rowEl: currentRowEl, itemEl: item, createdRow };
}

// ---------------------------------------------------------------------------
// Evidenziazione delle mosse possibili (usata sia dal drag sia dal click)
// ---------------------------------------------------------------------------

// Restituisce il selettore jQuery della casella data, sfruttando la classe
// "square-<casella>" che chessboard.js applica a ogni div-casella.
function squareSelector(square) {
  return '#board .square-' + square;
}

// Estrae il nome della casella (es. "e4") dall'elemento DOM cliccato,
// usando l'attributo data-square se presente, altrimenti la classe CSS.
function squareFromElement(el) {
  const fromAttr = el.getAttribute && el.getAttribute('data-square');
  if (fromAttr) return fromAttr;
  const match = (el.className || '').match(/\bsquare-([a-h][1-8])\b/);
  return match ? match[1] : null;
}

function clearHighlights() {
  $('#board .square-55d63').removeClass('move-hint move-hint-capture move-hint-selected');
}

function clearSelection() {
  clearHighlights();
  selectedSquare = null;
}

// Mostra i puntini/anelli sulle caselle raggiungibili dal pezzo in "square"
// ed evidenzia la casella di partenza. Usata sia all'inizio di un trascinamento
// sia al click su un proprio pezzo.
function selectSquare(square) {
  clearHighlights();
  selectedSquare = square;
  $(squareSelector(square)).addClass('move-hint-selected');

  const moves = chess.moves({ square, verbose: true });
  moves.forEach((m) => {
    const isCapture = !!m.captured; // include anche la presa en passant
    $(squareSelector(m.to)).addClass(isCapture ? 'move-hint-capture' : 'move-hint');
  });
}

function pieceColorAt(square) {
  const piece = chess.get(square);
  return piece ? piece.color : null;
}

// Esegue la mossa (usata dal click-to-move; il drag-and-drop usa invece
// direttamente chess.move dentro onDrop, dato che l'aggiornamento visivo
// della scacchiera è già gestito dall'animazione di chessboard.js).
function attemptMove(from, to) {
  const fenBefore = chess.fen();
  let moveObj;
  try {
    // La promozione viene sempre effettuata a Donna per semplicità
    moveObj = chess.move({ from, to, promotion: 'q' });
  } catch (err) {
    return false;
  }
  const fenAfter = chess.fen();
  clearSelection();
  board.position(chess.fen());
  processMove(moveObj, fenBefore, fenAfter);
  return true;
}

// Gestisce il click su una casella: primo click seleziona un proprio pezzo
// (mostrando le mosse possibili), secondo click su una casella di destinazione
// valida esegue la mossa; click sulla stessa casella deseleziona; click su
// un altro proprio pezzo sposta la selezione.
// NOTA: la selezione vera e propria di un pezzo avviene già in onDragStart
// (vedi sotto), perché chessboard.js non genera un evento "click" affidabile
// sui pezzi. Questa funzione gestisce quindi soprattutto il click sulla
// casella di destinazione (vuota o con pezzo avversario catturabile) e il
// caso di click su una casella "non valida" per deselezionare.
function handleSquareClick(square) {
  if (boardLocked || chess.isGameOver()) return;

  if (selectedSquare) {
    if (square === selectedSquare) {
      // Gestito già da onDrop per il caso "click sullo stesso pezzo selezionato";
      // qui copriamo solo il caso di un click reale (non originato da un pezzo,
      // quindi senza passare da onDragStart/onDrop) sulla stessa casella.
      clearSelection();
      return;
    }

    const legalMoves = chess.moves({ square: selectedSquare, verbose: true });
    const isLegalTarget = legalMoves.some((m) => m.to === square);
    if (isLegalTarget) {
      attemptMove(selectedSquare, square);
      return;
    }

    const color = pieceColorAt(square);
    if (color === chess.turn()) {
      selectSquare(square);
    } else {
      clearSelection();
    }
    return;
  }

  const color = pieceColorAt(square);
  if (color === chess.turn()) {
    selectSquare(square);
  }
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
  // chessboard.js intercetta il mousedown sui pezzi per gestire il proprio
  // drag interno (ricrea/riposiziona gli elementi DOM del pezzo), perciò un
  // semplice "click" su un pezzo NON genera un evento "click" affidabile:
  // la selezione del pezzo per il click-to-move va quindi fatta qui, che è
  // l'unico callback invocato in modo affidabile sia per il click sia per
  // il trascinamento.
  //
  // Se il pezzo cliccato è già quello selezionato, un click senza movimento
  // dovrà DESELEZIONARLO: lo ricordiamo prima di chiamare selectSquare(),
  // che sovrascrive subito selectedSquare, così onDrop potrà distinguere
  // questo caso da quello di una nuova selezione.
  wasAlreadySelected = (source === selectedSquare);
  selectSquare(source);
}

function onDrop(source, target) {
  if (source === target) {
    // Nessun trascinamento reale avvenuto: si tratta di un semplice click sul
    // pezzo. Se era già selezionato lo deselezioniamo (toggle); altrimenti la
    // selezione appena impostata da onDragStart resta visibile, in attesa del
    // click sulla casella di destinazione (che verrà gestito da
    // handleSquareClick, tramite l'evento "click" della casella di arrivo).
    if (wasAlreadySelected) {
      clearSelection();
    }
    return;
  }

  clearSelection();

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
  clearSelection();
  moveListInnerEl.innerHTML = '';
  plyHistory = [];
  currentRowEl = null;
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
  clearSelection();
  currentAnalysis = null;
  plyCount = Math.max(0, plyCount - 1);

  const entry = plyHistory.pop();
  if (entry) {
    entry.itemEl.remove();
    if (entry.createdRow) {
      entry.rowEl.remove();
      currentRowEl = plyHistory.length ? plyHistory[plyHistory.length - 1].rowEl : null;
    }
    updateEvalBar(entry.evalScoreBefore, entry.evalSideBefore);
  }

  setEngineStatus('Mossa annullata. Tocca al ' + (chess.turn() === 'w' ? 'bianco' : 'nero') + '.');
}

// Gira la scacchiera e, di conseguenza, anche la barra di valutazione:
// aggiunge/rimuove la classe "flipped" che ribalta visivamente la barra
// così il colore in basso sulla scacchiera resta il colore in basso nella barra,
// e ricalcola il testo del punteggio riferendolo al lato ora in basso.
function flipBoard() {
  board.flip();
  boardFlipped = !boardFlipped;
  evalBarWrapEl.classList.toggle('flipped', boardFlipped);
  clearSelection();
  updateEvalBar(lastEvalScore, lastEvalSideToMove);
  requestAnimationFrame(() => board.resize());
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

// Click-to-move: delegato sul contenitore della scacchiera così da funzionare
// anche quando chessboard.js ridisegna le caselle/i pezzi al cambio posizione.
// Gestisce soprattutto i click sulle caselle di destinazione (che non hanno
// un proprio pezzo trascinabile e quindi generano un evento "click" normale).
$('#board').on('click', '.square-55d63', function () {
  const square = squareFromElement(this);
  if (square) handleSquareClick(square);
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