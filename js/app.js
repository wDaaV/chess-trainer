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
let arrows = [];             // frecce di annotazione disegnate col tasto destro: [{ from, to }, ...]
let arrowDragStart = null;   // casella di partenza durante un trascinamento col tasto destro, null se non in corso
let arrowLayerEl = null;     // elemento <svg> sovrapposto alla scacchiera su cui vengono disegnate le frecce
let lastEvalScore = { cp: 0 };   // ultimo punteggio ricevuto dal motore (per ricalcolo al flip)
let lastEvalSideToMove = 'w';    // lato a cui era riferito l'ultimo punteggio
let plyHistory = [];       // pila con un record per ogni mossa giocata
let currentRowEl = null;   // riga (bianco+nero) attualmente in costruzione
let currentOpeningName = '';

// ---------------------------------------------------------------------------
// Database delle aperture (mosse "da libro")
// ---------------------------------------------------------------------------
let openingsBook = null; // mappa EPD -> { eco, name }, popolata al caricamento

async function loadOpeningsBook() {
  try {
    const res = await fetch('engine/openings.json');
    openingsBook = await res.json();
  } catch (err) {
    console.error('Impossibile caricare il database delle aperture:', err);
    openingsBook = {}; // fallback: nessuna mossa verrà riconosciuta come "da libro"
  }
}

// Riduce un FEN completo alla sua parte "EPD" (board, turno, arrocchi, en-passant),
// scartando i contatori di semi-mosse/mosse che non influenzano l'identità della
// posizione agli effetti del riconoscimento dell'apertura.
function toEpd(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

// Restituisce { eco, name } se la posizione raggiunta dopo la mossa è nel
// database delle aperture, altrimenti null. Il controllo è sulla posizione
// "dopo" la mossa perché openings.json indicizza le posizioni risultanti
// da una linea di teoria nota.
function isBookMove(fenAfter) {
  if (!openingsBook) return null;
  const epd = toEpd(fenAfter);
  return openingsBook[epd] || null;
}

// ---------------------------------------------------------------------------
// Riferimenti al DOM
// ---------------------------------------------------------------------------
const engineStatusEl = document.getElementById('engineStatus');
const moveListEl = document.getElementById('moveList');
const evalFillEl = document.getElementById('evalFill');
const evalScoreEl = document.getElementById('evalScore');
const evalBarWrapEl = document.getElementById('evalBarWrap');
const moveListInnerEl = document.getElementById('moveListInner');
const openingNameEl = document.getElementById('openingName');
const boardShellEl = document.getElementById('boardShell');
const checkmateOverlayEl = document.getElementById('checkmateOverlay');
const checkmateSubtitleEl = document.getElementById('checkmateSubtitle');

function setEngineStatus(text) {
  engineStatusEl.textContent = text;
}

function clearCheckmateEffects() {
  if (checkmateOverlayEl) {
    checkmateOverlayEl.classList.remove('visible');
    checkmateOverlayEl.setAttribute('aria-hidden', 'true');
  }

  if (checkmateSubtitleEl) {
    checkmateSubtitleEl.textContent = '';
  }

  if (boardShellEl) {
    boardShellEl.classList.remove('checkmate-shake');
  }

  $('#board .square-55d63').removeClass('checkmated-king');
}

function setOpeningName(name) {
  currentOpeningName = name || '';
  if (openingNameEl) openingNameEl.textContent = currentOpeningName;
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

// Converte un vantaggio in centipedoni in probabilità di vittoria del lato
// che sta valutando la posizione. La funzione sigmoide comprime i valori
// estremi: differenze enormi in posizioni già vinte valgono poco in termini
// pratici, mentre piccole differenze vicino all'equilibrio pesano di più.
function cpToWinProbability(cp) {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 1 / (1 + Math.pow(10, -clamped / 400));
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

// Classifica la mossa in base alla perdita di probabilità di vittoria
// (valore tra 0 e 1) invece che alla perdita lineare in centipedoni.
function classifyMove(winProbLoss, isBestMove, isBook) {
  if (isBook) return { label: 'Mossa da libro', css: 'book' };
  if (isBestMove || winProbLoss < 0.02) return { label: 'Ottima mossa', css: 'best' };
  if (winProbLoss < 0.06) return { label: 'Buona mossa', css: 'good' };
  if (winProbLoss < 0.12) return { label: 'Imprecisione', css: 'inaccuracy' };
  if (winProbLoss < 0.22) return { label: 'Errore', css: 'mistake' };
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

  const cpBeforeFromMover = scoreToCp(beforeAnalysis.score);
  const cpAfterFromMover = -scoreToCp(afterAnalysis.score);

  const winProbBefore = cpToWinProbability(cpBeforeFromMover);
  const winProbAfter = cpToWinProbability(cpAfterFromMover);
  const winProbLoss = Math.max(0, winProbBefore - winProbAfter);

  const bestSan = uciToSan(fenBefore, beforeAnalysis.bestMoveUci);
  const playedUci = moveObj.from + moveObj.to + (moveObj.promotion || '');
  const isBestMove = playedUci === beforeAnalysis.bestMoveUci;

  const bookInfo = isBookMove(fenAfter);
  const classification = classifyMove(winProbLoss, isBestMove, !!bookInfo);
  if (bookInfo) {
    classification.openingName = bookInfo.name;
    setOpeningName(bookInfo.name);
  }

  const listRefs = addMoveToList(moveObj, bestSan, classification, isBestMove, beforeAnalysis.bestMoveUci);
  plyHistory.push({
    rowEl: listRefs.rowEl,
    itemEl: listRefs.itemEl,
    createdRow: listRefs.createdRow,
    evalScoreBefore: beforeAnalysis.score,
    evalSideBefore: moveObj.color,
    openingNameAfter: currentOpeningName,
    fenBefore: fenBefore   // posizione esatta da cui ripartire se si clicca il link di questa mossa
  });

  updateEvalBar(afterAnalysis.score, chess.turn());

  if (chess.isCheckmate()) {
    showCheckmateEffects();
    setEngineStatus(getGameOverText());
  } else {
    clearCheckmateEffects();

    if (chess.isGameOver()) {
      setEngineStatus(getGameOverText());
    } else {
      setEngineStatus('Tocca al ' + (chess.turn() === 'w' ? 'bianco' : 'nero') + '.');
    }
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
function addMoveToList(moveObj, bestSan, classification, isBestMove, bestMoveUci) {
  plyCount++;
  const thisPly = plyCount; // "istantanea" della posizione nello storico: serve per verificare
                             // in seguito che questa sia ancora l'ultima mossa giocata
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
  if (classification.css === 'book') {
    detail.textContent = 'Mossa teorica';
  } else if (isBestMove) {
    detail.textContent = 'Hai giocato la mossa migliore secondo Stockfish';
  } else {
    detail.textContent = 'Mossa migliore secondo Stockfish: ';

    const link = document.createElement('a');
    link.href = '#';
    link.className = 'best-move-link';
    link.textContent = bestSan;
    link.title = 'Clicca per giocare questa mossa al posto di quella effettuata (le eventuali mosse successive verranno scartate)';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      jumpAndReplay(thisPly, bestMoveUci);
    });
    detail.appendChild(link);
  }

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

// Torna alla posizione presente PRIMA della mossa numero "thisPly" (1 = prima
// mossa della partita), scarta quella mossa e tutte quelle giocate dopo di
// essa, e gioca al loro posto la mossa suggerita da Stockfish (bestMoveUci).
// A differenza della vecchia replayWithBestMove, funziona da QUALUNQUE blocco
// di analisi, non solo dall'ultimo: i link restano quindi sempre cliccabili,
// anche su mosse ormai "nel passato" della partita.
function jumpAndReplay(thisPly, bestMoveUci) {
  if (boardLocked) return;
  if (thisPly < 1 || thisPly > plyHistory.length) return;
  if (!bestMoveUci || bestMoveUci.length < 4) return;

  // La mossa che stiamo per scartare: da qui recuperiamo il FEN e la
  // valutazione "prima" di essa, verso cui riportare partita e barra di eval.
  const cutEntry = plyHistory[thisPly - 1];
  const fenBefore = cutEntry.fenBefore;
  const evalBefore = cutEntry.evalScoreBefore;
  const evalSideBefore = cutEntry.evalSideBefore;

  clearCheckmateEffects();
  clearSelection();
  clearArrows();

  // Rimuove dallo storico (e dal DOM) la mossa "thisPly" e tutte quelle
  // giocate dopo, esattamente come farebbe undoMove() ripetuto più volte:
  // stessa logica di gestione delle righe bianco/nero, solo in un ciclo.
  while (plyHistory.length >= thisPly) {
    const entry = plyHistory.pop();
    entry.itemEl.remove();
    if (entry.createdRow) {
      entry.rowEl.remove();
    }
  }
  currentRowEl = plyHistory.length ? plyHistory[plyHistory.length - 1].rowEl : null;
  plyCount = plyHistory.length;

  const lastEntry = plyHistory.length ? plyHistory[plyHistory.length - 1] : null;
  setOpeningName(lastEntry ? lastEntry.openingNameAfter : '');

  // Ricarica chess.js e la scacchiera sulla posizione "prima" della mossa
  // scartata. Niente animazione (secondo parametro "false"): è un salto a un
  // punto qualsiasi della partita, non lo spostamento di un singolo pezzo.
  chess.load(fenBefore);
  board.position(chess.fen(), false);
  updateEvalBar(evalBefore, evalSideBefore);

  currentAnalysis = null; // la cache non è più valida: la posizione è cambiata

  const from = bestMoveUci.slice(0, 2);
  const to = bestMoveUci.slice(2, 4);
  attemptMove(from, to); // rientra nella normale pipeline (processMove) da qui in poi
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
  clearArrows();
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

function findKingSquare(color) {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ranks = ['1', '2', '3', '4', '5', '6', '7', '8'];

  for (const rank of ranks) {
    for (const file of files) {
      const square = file + rank;
      const piece = chess.get(square);
      if (piece && piece.type === 'k' && piece.color === color) {
        return square;
      }
    }
  }
  return null;
}

function showCheckmateEffects() {
  clearCheckmateEffects();

  const loser = chess.turn();
  const winner = loser === 'w' ? 'Nero' : 'Bianco';
  const kingSquare = findKingSquare(loser);

  if (checkmateSubtitleEl) {
    checkmateSubtitleEl.textContent = 'Vince il ' + winner + '.';
  }

  if (checkmateOverlayEl) {
    checkmateOverlayEl.classList.add('visible');
    checkmateOverlayEl.setAttribute('aria-hidden', 'false');
  }

  if (kingSquare) {
    $(squareSelector(kingSquare)).addClass('checkmated-king');
  }

  if (boardShellEl) {
    void boardShellEl.offsetWidth;
    boardShellEl.classList.add('checkmate-shake');
  }
}

if (boardShellEl) {
  boardShellEl.addEventListener('animationend', () => {
    boardShellEl.classList.remove('checkmate-shake');
  });
}

// ---------------------------------------------------------------------------
// Frecce di annotazione (tasto destro + trascinamento), stile wintrchess/lichess
// ---------------------------------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';

function createArrowLayer() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('id', 'arrowLayer');
  svg.setAttribute('class', 'arrow-layer');
  boardShellEl.appendChild(svg);
  return svg;
}

// Centro in pixel di una casella, relativo a boardShellEl (lo stesso contenitore
// a cui è agganciato l'overlay delle frecce e l'overlay di scacco matto).
function squareCenterPx(square) {
  const el = document.querySelector(squareSelector(square));
  if (!el) return null;
  const shellRect = boardShellEl.getBoundingClientRect();
  const sqRect = el.getBoundingClientRect();
  return {
    x: sqRect.left - shellRect.left + sqRect.width / 2,
    y: sqRect.top - shellRect.top + sqRect.height / 2
  };
}

// Disegna l'intera freccia (stelo + punta) come UN UNICO poligono, invece di
// una linea (stelo) più un triangolo (punta) sovrapposti: con due forme
// distinte, l'estremità arrotondata dello stelo (stroke-linecap: round)
// sporgeva leggermente oltre i bordi retti della base del triangolo,
// creando uno stacco visibile nel punto di giunzione. Un'unica forma piena
// elimina del tutto la sovrapposizione.
function drawArrowShape(svg, p1, p2) {
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (dist < 4) return; // trascinamento troppo corto: non disegnare nulla

  const headLength = 32;
  const headWidth = 30;
  const shaftWidth = 14; // stesso spessore che prima era impostato via CSS (stroke-width)

  // Direzione perpendicolare alla freccia, usata per "allargare" stelo e punta
  // ai due lati della linea centrale p1->p2.
  const perpX = Math.cos(angle + Math.PI / 2);
  const perpY = Math.sin(angle + Math.PI / 2);

  const shaftHalf = shaftWidth / 2;
  const headHalf = headWidth / 2;

  const tip = { x: p1.x + Math.cos(angle) * dist, y: p1.y + Math.sin(angle) * dist };
  const headBaseDist = Math.max(0, dist - headLength);
  const headBase = {
    x: p1.x + Math.cos(angle) * headBaseDist,
    y: p1.y + Math.sin(angle) * headBaseDist
  };

  // Contorno del poligono, in ordine: partenza (lato sx) → base punta (lato
  // sx, stretta come lo stelo) → base punta allargata (lato sx) → punta →
  // base punta allargata (lato dx) → base punta (lato dx) → partenza (lato dx)
  const points = [
    { x: p1.x - perpX * shaftHalf, y: p1.y - perpY * shaftHalf },
    { x: headBase.x - perpX * shaftHalf, y: headBase.y - perpY * shaftHalf },
    { x: headBase.x - perpX * headHalf, y: headBase.y - perpY * headHalf },
    tip,
    { x: headBase.x + perpX * headHalf, y: headBase.y + perpY * headHalf },
    { x: headBase.x + perpX * shaftHalf, y: headBase.y + perpY * shaftHalf },
    { x: p1.x + perpX * shaftHalf, y: p1.y + perpY * shaftHalf }
  ];

  const arrow = document.createElementNS(SVG_NS, 'polygon');
  arrow.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
  arrow.setAttribute('class', 'arrow-shape');
  svg.appendChild(arrow);
}

// Ridisegna tutte le frecce salvate (chiamata dopo ogni modifica all'array "arrows"
// e ad ogni resize/ridimensionamento della scacchiera).
function renderArrows() {
  if (!arrowLayerEl) return;
  const rect = boardShellEl.getBoundingClientRect();
  arrowLayerEl.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  arrowLayerEl.innerHTML = '';
  arrows.forEach((a) => {
    const p1 = squareCenterPx(a.from);
    const p2 = squareCenterPx(a.to);
    if (p1 && p2) drawArrowShape(arrowLayerEl, p1, p2);
  });
}

// Disegna, oltre alle frecce salvate, anche l'anteprima "live" durante il trascinamento
function updateTempArrow(clientX, clientY) {
  renderArrows();
  const p1 = squareCenterPx(arrowDragStart);
  if (!p1) return;
  const shellRect = boardShellEl.getBoundingClientRect();
  const p2 = { x: clientX - shellRect.left, y: clientY - shellRect.top };
  drawArrowShape(arrowLayerEl, p1, p2);
}

// Aggiunge la freccia from->to, oppure la rimuove se esiste già (toggle)
function toggleArrow(from, to) {
  const idx = arrows.findIndex((a) => a.from === from && a.to === to);
  if (idx !== -1) {
    arrows.splice(idx, 1);
  } else {
    arrows.push({ from, to });
  }
  renderArrows();
}

function clearArrows() {
  if (arrows.length === 0) return;
  arrows = [];
  renderArrows();
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
  clearCheckmateEffects();
  board.start();
  currentAnalysis = null;
  plyCount = 0;
  clearSelection();
  clearArrows();
  moveListInnerEl.innerHTML = '';
  plyHistory = [];
  currentRowEl = null;
  setOpeningName('');
  updateEvalBar({ cp: 0 }, 'w');
  boardLocked = true;
  setEngineStatus('Nuova partita. Calcolo la posizione iniziale…');
  ensureInitialAnalysis().then(() => {
    boardLocked = false;
    setEngineStatus('Muove il bianco.');
  });
}

function undoMove() {
  clearCheckmateEffects();
  const undone = chess.undo();
  if (!undone) return;
  board.position(chess.fen());
  clearSelection();
  clearArrows();
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

  const lastEntry = plyHistory.length ? plyHistory[plyHistory.length - 1] : null;
  setOpeningName(lastEntry ? lastEntry.openingNameAfter : '');

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
  clearArrows();
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

// --- Frecce di annotazione: tasto destro + trascinamento -------------------
// --- Frecce di annotazione: tasto destro + trascinamento -------------------
arrowLayerEl = createArrowLayer();

const boardEl = document.getElementById('board');

// Blocca il menu contestuale nativo del browser sulla scacchiera.
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

// IMPORTANTE: chessboard.js avvia il proprio drag-and-drop dei pezzi da un
// listener "mousedown" registrato sui pezzi stessi, SENZA distinguere il
// tasto premuto (tratta ogni mousedown come un click sinistro). Per evitare
// che un mousedown col tasto destro venga intercettato anche da chessboard.js
// (che sposterebbe il pezzo), lo catturiamo in fase di "capture" — prima che
// l'evento raggiunga il listener di chessboard.js sul pezzo — e, se è il
// tasto destro, blocchiamo del tutto la propagazione: chessboard.js non vede
// mai l'evento e il pezzo non si muove.
boardEl.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return; // il tasto sinistro prosegue normalmente verso chessboard.js
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const squareEl = e.target.closest('.square-55d63');
  const square = squareEl ? squareFromElement(squareEl) : null;
  if (square) arrowDragStart = square;
}, true); // true = fase di cattura, eseguita prima dei listener di chessboard.js

$(document).on('mousemove', (e) => {
  if (!arrowDragStart) return;
  updateTempArrow(e.clientX, e.clientY);
});

$(document).on('mouseup', (e) => {
  if (!arrowDragStart) return;
  const start = arrowDragStart;
  arrowDragStart = null;

  const elAtPoint = document.elementFromPoint(e.clientX, e.clientY);
  const squareEl = elAtPoint ? elAtPoint.closest('.square-55d63') : null;
  const targetSquare = squareEl ? squareFromElement(squareEl) : null;

  if (targetSquare && targetSquare !== start) {
    toggleArrow(start, targetSquare);
  } else {
    renderArrows(); // rimuove solo l'anteprima temporanea, le frecce salvate restano
  }
});

window.addEventListener('resize', () => {
  board.resize();
  renderArrows();
});

document.getElementById('newGameBtn').addEventListener('click', newGame);
document.getElementById('undoBtn').addEventListener('click', undoMove);
document.getElementById('flipBtn').addEventListener('click', flipBoard);
document.getElementById('depthSelect').addEventListener('change', (e) => {
  analysisDepth = parseInt(e.target.value, 10);
  currentAnalysis = null; // ricalcola con la nuova profondità dalla prossima mossa
});

Promise.all([engineReadyPromise, loadOpeningsBook()]).then(async () => {
  setEngineStatus('Motore pronto. Calcolo la posizione iniziale…');
  await ensureInitialAnalysis();
  boardLocked = false;
  setEngineStatus('Muove il bianco.');
});

/*
//versione senza Promise
loadOpeningsBook(); // non bloccante: se non è ancora pronto, isBookMove ritorna null finché il fetch non termina

engineReadyPromise.then(async () => {
  setEngineStatus('Motore pronto. Calcolo la posizione iniziale…');
  await ensureInitialAnalysis();
  boardLocked = false;
  setEngineStatus('Muove il bianco.');
});*/