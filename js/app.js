// ========== SEZIONE: Import librerie ==========
// Importa la libreria chess.js, che gestisce le regole del gioco e lo stato della partita (mosse legali, scacco, scacco matto, FEN, ecc.).
// ========================================
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

// ========== SEZIONE: Registrazione Service Worker ==========
// Requisito indispensabile perché Chrome offra l'installazione come web app (insieme al manifest.json collegato in index.html). Viene registrato qui, ma non blocca l'avvio dell'app in caso di errore o browser non supportati.
// ========================================
if ('serviceWorker' in navigator) { // verifica che il browser supporti i service worker
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.error('Registrazione del service worker fallita:', err);
    });
  });
}

// ========== SEZIONE: Stato dell'applicazione ==========
// Variabili globali che rappresentano lo stato corrente della partita, della scacchiera e dell'interfaccia (selezioni, frecce, valutazioni, ecc.).
// ========================================
const chess = new Chess(); // istanza chess.js che tiene le regole/stato della partita
let board = null; // riferimento all'istanza di chessboard.js (creata più avanti)
let boardLocked = true;      // true finché il motore non è pronto o sta analizzando
let analysisDepth = 14;      // profondità di ricerca UCI (modificabile dal menu)
let currentAnalysis = null;  // cache dell'analisi della posizione corrente (evita richieste doppie)
let plyCount = 0; // numero di semi-mosse giocate finora
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
let currentOpeningName = ''; // nome dell'apertura attualmente riconosciuta (stringa vuota se nessuna)

// ========== SEZIONE: Database delle aperture ==========
// Carica e interroga il database delle aperture (mosse "da libro") a partire da un file JSON che mappa posizioni (in formato EPD) a nome/codice ECO.
// ========================================
let openingsBook = null; // mappa EPD -> { eco, name }, popolata al caricamento

async function loadOpeningsBook() {
  try {
    const res = await fetch('engine/openings.json'); // scarica il database delle aperture
    openingsBook = await res.json(); // converte la risposta in oggetto JS
  } catch (err) {
    console.error('Impossibile caricare il database delle aperture:', err);
    openingsBook = {}; // fallback: nessuna mossa verrà riconosciuta come "da libro"
  }
}

// Riduce un FEN completo alla sua parte "EPD" (board, turno, arrocchi, en-passant), scartando i contatori di semi-mosse/mosse che non influenzano l'identità della posizione agli effetti del riconoscimento dell'apertura.
function toEpd(fen) {
  return fen.split(' ').slice(0, 4).join(' '); // prende solo i primi 4 campi del FEN
}

// Restituisce { eco, name } se la posizione raggiunta dopo la mossa è nel database delle aperture, altrimenti null. Il controllo è sulla posizione "dopo" la mossa perché openings.json indicizza le posizioni risultanti da una linea di teoria nota.
function isBookMove(fenAfter) {
  if (!openingsBook) return null; // database non ancora caricato
  const epd = toEpd(fenAfter); // normalizza il FEN per la ricerca
  return openingsBook[epd] || null;
}

// ========== SEZIONE: Riferimenti al DOM ==========
// Recupera i riferimenti agli elementi HTML dell'interfaccia (status motore, elenco mosse, barra di valutazione, overlay di scacco matto, pezzi catturati, ecc.).
// ========================================
const engineStatusEl = document.getElementById('engineStatus'); // testo di stato del motore
const moveListEl = document.getElementById('moveList'); // contenitore scrollabile dell'elenco mosse
const evalFillEl = document.getElementById('evalFill'); // riempimento della barra di valutazione
const evalScoreEl = document.getElementById('evalScore'); // testo numerico del punteggio
const evalBarWrapEl = document.getElementById('evalBarWrap'); // wrapper della barra di valutazione (per il flip)
const moveListInnerEl = document.getElementById('moveListInner'); // contenitore interno delle righe di mosse
const openingNameEl = document.getElementById('openingName'); // etichetta col nome dell'apertura
const boardShellEl = document.getElementById('boardShell'); // contenitore della scacchiera (overlay frecce/scacco matto)
const checkmateOverlayEl = document.getElementById('checkmateOverlay'); // overlay mostrato allo scacco matto
const checkmateSubtitleEl = document.getElementById('checkmateSubtitle'); // sottotitolo con il vincitore
const capturedWrapEl = document.getElementById('capturedWrap'); // wrapper dei vassoi dei pezzi catturati
const capturedByWhiteEl = document.getElementById('capturedByWhite'); // vassoio pezzi catturati dal bianco
const capturedByBlackEl = document.getElementById('capturedByBlack'); // vassoio pezzi catturati dal nero

// ========== SEZIONE: Pezzi catturati ==========
// Calcola e visualizza, in due "vassoi", i pezzi catturati da ciascun colore, ricostruendoli ogni volta dallo storico delle mosse di chess.js.
// ========================================
const WHITE_GLYPHS = { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' }; // simboli Unicode dei pezzi bianchi
const BLACK_GLYPHS = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' }; // simboli Unicode dei pezzi neri
const CAPTURE_ORDER = { p: 1, n: 2, b: 3, r: 4, q: 5 }; // ordine di visualizzazione (valore crescente del pezzo)

function renderCapturedTray(container, pieceTypes, glyphMap) {
  if (!container) return; // elemento DOM non presente in pagina
  container.innerHTML = ''; // svuota il vassoio prima di ridisegnarlo
  pieceTypes.forEach((type) => {
    const span = document.createElement('span');
    span.className = 'captured-piece';
    span.textContent = glyphMap[type] || ''; // simbolo del pezzo catturato
    container.appendChild(span);
  });
}

// Ricalcola da zero i pezzi mangiati leggendo lo storico di chess.js: funziona automaticamente anche dopo "Annulla mossa" o "jumpAndReplay", senza bisogno di tenere contatori manuali da tenere sincronizzati.
function updateCapturedPieces() {
  const history = chess.history({ verbose: true }); // storico completo delle mosse, con dettagli
  const capturedByWhite = []; // pezzi neri catturati dal bianco
  const capturedByBlack = []; // pezzi bianchi catturati dal nero

  history.forEach((m) => {
    if (!m.captured) return; // mossa senza cattura, la saltiamo
    if (m.color === 'w') capturedByWhite.push(m.captured);
    else capturedByBlack.push(m.captured);
  });

  const byValue = (a, b) => CAPTURE_ORDER[a] - CAPTURE_ORDER[b]; // funzione di ordinamento per valore del pezzo
  renderCapturedTray(capturedByWhiteEl, capturedByWhite.sort(byValue), BLACK_GLYPHS);
  renderCapturedTray(capturedByBlackEl, capturedByBlack.sort(byValue), WHITE_GLYPHS);
}

function setEngineStatus(text) {
  engineStatusEl.textContent = text; // aggiorna la riga di stato del motore
}

function clearCheckmateEffects() {
  if (checkmateOverlayEl) {
    checkmateOverlayEl.classList.remove('visible'); // nasconde l'overlay di scacco matto
    checkmateOverlayEl.setAttribute('aria-hidden', 'true'); // lo nasconde anche agli screen reader
  }

  if (checkmateSubtitleEl) {
    checkmateSubtitleEl.textContent = ''; // svuota il sottotitolo col vincitore
  }

  if (boardShellEl) {
    boardShellEl.classList.remove('checkmate-shake'); // rimuove l'animazione di scossa
  }

  $('#board .square-55d63').removeClass('checkmated-king'); // rimuove l'evidenziazione del re sotto scacco matto
}

function setOpeningName(name) {
  currentOpeningName = name || ''; // memorizza il nome corrente dell'apertura
  if (openingNameEl) openingNameEl.textContent = currentOpeningName; // lo mostra in interfaccia
}

// ========== SEZIONE: Motore Stockfish (Web Worker + protocollo UCI) ==========
// Avvia il motore Stockfish in un Web Worker separato e gestisce lo scambio di messaggi secondo il protocollo UCI (handshake iniziale e risposte alle analisi).
// ========================================
const engine = new Worker('engine/stockfish-18-lite-single.js'); // avvia il motore in un thread separato

let engineReady = false; // diventa true dopo l'handshake UCI completo
let resolveEngineReady; // funzione che risolve la Promise sottostante
const engineReadyPromise = new Promise((res) => { resolveEngineReady = res; }); // Promise risolta quando il motore è pronto

let pendingAnalysis = null; // { resolve, lastScore }

function sendToEngine(cmd) {
  engine.postMessage(cmd); // invia un comando testuale UCI al Web Worker
}

engine.onmessage = (event) => {
  const line = event.data; // riga di testo ricevuta dal motore
  if (typeof line !== 'string') return; // ignora messaggi non testuali

  if (line === 'uciok') {
    sendToEngine('isready'); // completata la fase "uci", chiede conferma di prontezza
  } else if (line === 'readyok') {
    engineReady = true; // il motore è pronto a ricevere comandi di analisi
    resolveEngineReady();
  } else if (pendingAnalysis) {
    if (line.startsWith('info') && line.indexOf(' score ') !== -1) {
      const parsed = parseInfoLine(line); // estrae il punteggio dalla riga "info ..."
      if (parsed) pendingAnalysis.lastScore = parsed;
    } else if (line.startsWith('bestmove')) {
      const bestMoveUci = line.split(' ')[1]; // seconda parola della riga: mossa migliore in notazione UCI
      const finished = pendingAnalysis;
      pendingAnalysis = null;
      finished.resolve({ bestMoveUci, score: finished.lastScore }); // risolve la Promise dell'analisi in corso
    }
  }
};

engine.onerror = (err) => {
  console.error('Errore nel Web Worker di Stockfish:', err);
  setEngineStatus('Errore nel caricamento del motore. Controlla la console (F12) e verifica i percorsi dei file in engine/.');
};

sendToEngine('uci'); // avvia l'handshake UCI

// Estrae "score cp X" o "score mate X" da una riga "info ..." del motore
function parseInfoLine(line) {
  const mateMatch = line.match(/score mate (-?\d+)/); // cerca un punteggio di matto in N mosse
  if (mateMatch) return { mate: parseInt(mateMatch[1], 10) };

  const cpMatch = line.match(/score cp (-?\d+)/); // cerca un punteggio in centipedoni
  if (cpMatch) return { cp: parseInt(cpMatch[1], 10) };

  return null; // riga senza informazioni di punteggio riconoscibili
}

// ========== SEZIONE: Analisi e calcolo dei punteggi ==========
// Funzioni per avviare un'analisi UCI su una posizione, convertire i punteggi restituiti da Stockfish in valori utilizzabili (centipedoni, probabilità di vittoria, testo formattato) e aggiornare la barra di valutazione.
// ========================================

// Avvia un'analisi sulla posizione data (FEN) e restituisce una Promise con la mossa migliore (notazione UCI) e la valutazione trovata.
function analyzePosition(fen, depth) {
  return new Promise((resolve) => {
    pendingAnalysis = { resolve, lastScore: null }; // registra la richiesta in attesa di risposta
    sendToEngine('position fen ' + fen); // imposta la posizione da analizzare
    sendToEngine('go depth ' + depth); // avvia la ricerca alla profondità indicata
  });
}

// Converte un punteggio { cp } oppure { mate } in un valore numerico in centipedoni
function scoreToCp(score) {
  if (!score) return 0; // nessun punteggio disponibile
  if (score.mate !== undefined) {
    const sign = score.mate > 0 ? 1 : -1; // segno in base a chi dà/subisce il matto
    return sign * (100000 - Math.abs(score.mate) * 100); // valore convenzionalmente molto alto per rappresentare il matto
  }
  return score.cp;
}

// Converte un vantaggio in centipedoni in probabilità di vittoria del lato che sta valutando la posizione. La funzione sigmoide comprime i valori estremi: differenze enormi in posizioni già vinte valgono poco in termini pratici, mentre piccole differenze vicino all'equilibrio pesano di più.
function cpToWinProbability(cp) {
  const clamped = Math.max(-1000, Math.min(1000, cp)); // limita il valore per evitare estremi poco significativi
  return 1 / (1 + Math.pow(10, -clamped / 400)); // funzione sigmoide logistica
}

// Formatta un punteggio per la visualizzazione (es. "+0.35" oppure "#+3"). sideToMove: 'w' o 'b', il colore a cui è riferito lo score (chi deve muovere in quella posizione). flipped: se true, il punteggio viene riferito al lato in basso sulla scacchiera (che dopo un "gira scacchiera" è il nero) invece che sempre al bianco: basta invertire il segno del valore altrimenti calcolato per il bianco.
function formatScore(score, sideToMove, flipped) {
  if (!score) return '0.00'; // nessun punteggio disponibile, valore neutro di default
  if (score.mate !== undefined) {
    let mateValue = sideToMove === 'w' ? score.mate : -score.mate; // riferito al bianco
    if (flipped) mateValue = -mateValue;                           // riferito al lato in basso
    return (mateValue > 0 ? '#+' : '#-') + Math.abs(mateValue);
  }
  let cpValue = sideToMove === 'w' ? score.cp : -score.cp; // riferito al bianco
  if (flipped) cpValue = -cpValue;                          // riferito al lato in basso
  const pawns = (cpValue / 100).toFixed(2); // conversione da centipedoni a pedoni, con 2 decimali
  return (cpValue > 0 ? '+' : '') + pawns;
}

// Aggiorna la barra di valutazione verticale. Il riempimento resta sempre calcolato rispetto al bianco (il ribaltamento visivo è affidato allo scaleY(-1) via CSS sulla classe "flipped"), mentre il testo del punteggio, mostrato sotto la barra, viene ricalcolato rispetto al lato attualmente in basso sulla scacchiera tramite formatScore().
function updateEvalBar(score, sideToMove) {
  lastEvalScore = score; // memorizza l'ultimo punteggio (serve al flip della scacchiera)
  lastEvalSideToMove = sideToMove;

  const cp = scoreToCp(score);
  const whiteCp = sideToMove === 'w' ? cp : -cp; // punteggio sempre riferito al bianco
  const clamped = Math.max(-1000, Math.min(1000, whiteCp)); // limita per il calcolo della percentuale di riempimento
  const pct = 50 + (clamped / 1000) * 50; // converte il punteggio in percentuale di riempimento (50% = equilibrio)
  evalFillEl.style.height = pct + '%';
  evalScoreEl.textContent = formatScore(score, sideToMove, boardFlipped);
}

// ========== SEZIONE: Conversione mosse e classificazione ==========
// Converte le mosse dalla notazione UCI (usata da Stockfish) alla notazione SAN (leggibile), e classifica la qualità di una mossa giocata dall'utente.
// ========================================

// Converte una mossa in notazione UCI (es. "e2e4") in SAN (es. "e4"), usando una copia temporanea della partita nella posizione data.
function uciToSan(fen, uciMove) {
  if (!uciMove || uciMove.length < 4) return '—'; // mossa mancante o malformata
  const temp = new Chess(fen); // partita temporanea, usata solo per la conversione
  const from = uciMove.slice(0, 2);
  const to = uciMove.slice(2, 4);
  const promotion = uciMove.length > 4 ? uciMove.slice(4) : undefined; // eventuale lettera di promozione
  try {
    const move = temp.move({ from, to, promotion });
    return move.san;
  } catch (e) {
    return uciMove; // in caso di errore, restituisce la notazione UCI originale
  }
}

// Classifica la mossa in base alla perdita di probabilità di vittoria (valore tra 0 e 1) invece che alla perdita lineare in centipedoni.
function classifyMove(winProbLoss, isBestMove, isBook) {
  if (isBook) return { label: 'Mossa da libro', css: 'book' };
  if (isBestMove || winProbLoss < 0.02) return { label: 'Ottima mossa', css: 'best' };
  if (winProbLoss < 0.06) return { label: 'Buona mossa', css: 'good' };
  if (winProbLoss < 0.12) return { label: 'Imprecisione', css: 'inaccuracy' };
  if (winProbLoss < 0.22) return { label: 'Errore', css: 'mistake' };
  return { label: 'Errore grave', css: 'blunder' };
}

// ========== SEZIONE: Pipeline di analisi eseguita dopo ogni mossa ==========
// Coordina l'analisi "prima" e "dopo" ogni mossa giocata dall'utente, calcola la classificazione della mossa, aggiorna l'interfaccia (elenco mosse, barra di valutazione, stato del motore) e gestisce la fine della partita.
// ========================================
async function ensureInitialAnalysis() {
  if (!currentAnalysis) {
    currentAnalysis = await analyzePosition(chess.fen(), analysisDepth); // analizza la posizione iniziale se non già in cache
  }
}

async function processMove(moveObj, fenBefore, fenAfter) {
  boardLocked = true; // blocca l'interazione mentre il motore analizza
  updateCapturedPieces();
  setEngineStatus('Stockfish sta analizzando la mossa…');

  // Analisi "prima" della mossa (di solito già in cache dalla mossa precedente)
  if (!currentAnalysis) {
    currentAnalysis = await analyzePosition(fenBefore, analysisDepth);
  }
  const beforeAnalysis = currentAnalysis;

  // Analisi "dopo" la mossa: diventerà la cache per la prossima mossa
  const afterAnalysis = await analyzePosition(fenAfter, analysisDepth);
  currentAnalysis = afterAnalysis;

  const cpBeforeFromMover = scoreToCp(beforeAnalysis.score); // valutazione prima della mossa, dal punto di vista di chi muove
  const cpAfterFromMover = -scoreToCp(afterAnalysis.score); // valutazione dopo la mossa, riportata allo stesso punto di vista

  const winProbBefore = cpToWinProbability(cpBeforeFromMover);
  const winProbAfter = cpToWinProbability(cpAfterFromMover);
  const winProbLoss = Math.max(0, winProbBefore - winProbAfter); // perdita di probabilità di vittoria causata dalla mossa

  const bestSan = uciToSan(fenBefore, beforeAnalysis.bestMoveUci); // mossa migliore secondo il motore, in notazione leggibile
  const playedUci = moveObj.from + moveObj.to + (moveObj.promotion || ''); // mossa effettivamente giocata, in notazione UCI
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

  boardLocked = false; // sblocca l'interazione, l'analisi è terminata
}

function getGameOverText() {
  if (chess.isCheckmate()) return 'Scacco matto! Partita terminata.';
  if (chess.isStalemate()) return 'Stallo: partita patta.';
  if (chess.isThreefoldRepetition()) return 'Patta per tripla ripetizione.';
  if (chess.isInsufficientMaterial()) return 'Patta per materiale insufficiente.';
  if (chess.isDraw()) return 'Partita patta.';
  return 'Partita terminata.';
}

// ========== SEZIONE: Pannello elenco mosse ==========
// Costruisce e aggiorna l'elenco delle mosse giocate, organizzato su due colonne (bianco/nero), e gestisce il salto a una posizione precedente con rigioco automatico della mossa migliore suggerita dal motore.
// ========================================
function addMoveToList(moveObj, bestSan, classification, isBestMove, bestMoveUci) {
  plyCount++;
  const thisPly = plyCount; // "istantanea" della posizione nello storico: serve per verificare in seguito che questa sia ancora l'ultima mossa giocata
  const moveNumber = Math.ceil(plyCount / 2);
  const isWhiteMove = moveObj.color === 'w';

  const item = document.createElement('div');
  item.className = 'move-item ' + classification.css;

  const header = document.createElement('div');
  header.className = 'move-item-header';
  header.textContent = moveNumber + '. ' + moveObj.san;

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

// Torna alla posizione presente PRIMA della mossa numero "thisPly" (1 = prima mossa della partita), scarta quella mossa e tutte quelle giocate dopo di essa, e gioca al loro posto la mossa suggerita da Stockfish (bestMoveUci). A differenza della vecchia replayWithBestMove, funziona da QUALUNQUE blocco di analisi, non solo dall'ultimo: i link restano quindi sempre cliccabili, anche su mosse ormai "nel passato" della partita.
function jumpAndReplay(thisPly, bestMoveUci) {
  if (boardLocked) return; // non permesso mentre il motore sta analizzando
  if (thisPly < 1 || thisPly > plyHistory.length) return; // indice fuori dai limiti dello storico
  if (!bestMoveUci || bestMoveUci.length < 4) return; // nessuna mossa migliore disponibile

  // La mossa che stiamo per scartare: da qui recuperiamo il FEN e la valutazione "prima" di essa, verso cui riportare partita e barra di eval.
  const cutEntry = plyHistory[thisPly - 1];
  const fenBefore = cutEntry.fenBefore;
  const evalBefore = cutEntry.evalScoreBefore;
  const evalSideBefore = cutEntry.evalSideBefore;

  clearCheckmateEffects();
  clearSelection();
  clearArrows();

  // Rimuove dallo storico (e dal DOM) la mossa "thisPly" e tutte quelle giocate dopo, esattamente come farebbe undoMove() ripetuto più volte: stessa logica di gestione delle righe bianco/nero, solo in un ciclo.
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

  // Ricarica chess.js e la scacchiera sulla posizione "prima" della mossa scartata. Niente animazione (secondo parametro "false"): è un salto a un punto qualsiasi della partita, non lo spostamento di un singolo pezzo.
  chess.load(fenBefore);
  board.position(chess.fen(), false);
  updateCapturedPieces();
  updateEvalBar(evalBefore, evalSideBefore);

  currentAnalysis = null; // la cache non è più valida: la posizione è cambiata

  const from = bestMoveUci.slice(0, 2);
  const to = bestMoveUci.slice(2, 4);
  attemptMove(from, to); // rientra nella normale pipeline (processMove) da qui in poi
}

// ========== SEZIONE: Evidenziazione delle mosse possibili ==========
// Funzioni di supporto usate sia dal drag-and-drop sia dal click-to-move per individuare le caselle DOM, evidenziare le mosse legali e gestire la selezione del pezzo corrente.
// ========================================

// Restituisce il selettore jQuery della casella data, sfruttando la classe "square-<casella>" che chessboard.js applica a ogni div-casella.
function squareSelector(square) {
  return '#board .square-' + square;
}

// Estrae il nome della casella (es. "e4") dall'elemento DOM cliccato, usando l'attributo data-square se presente, altrimenti la classe CSS.
function squareFromElement(el) {
  const fromAttr = el.getAttribute && el.getAttribute('data-square'); // preferisce l'attributo data-square, se presente
  if (fromAttr) return fromAttr;
  const match = (el.className || '').match(/\bsquare-([a-h][1-8])\b/); // fallback: estrae la casella dal nome della classe CSS
  return match ? match[1] : null;
}

function clearHighlights() {
  $('#board .square-55d63').removeClass('move-hint move-hint-capture move-hint-selected'); // rimuove tutte le evidenziazioni di mossa
}

function clearSelection() {
  clearHighlights();
  selectedSquare = null;
}

// Mostra i puntini/anelli sulle caselle raggiungibili dal pezzo in "square" ed evidenzia la casella di partenza. Usata sia all'inizio di un trascinamento sia al click su un proprio pezzo.
function selectSquare(square) {
  clearHighlights();
  clearArrows();
  selectedSquare = square;
  $(squareSelector(square)).addClass('move-hint-selected');

  const moves = chess.moves({ square, verbose: true }); // tutte le mosse legali per il pezzo selezionato
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
        return square; // trovato il re del colore cercato
      }
    }
  }
  return null; // re non trovato (non dovrebbe accadere in una partita valida)
}

// ========== SEZIONE: Effetti di scacco matto ==========
// Mostra l'overlay di fine partita, evidenzia il re sotto scacco matto e applica l'animazione di scossa alla scacchiera.
// ========================================
function showCheckmateEffects() {
  clearCheckmateEffects(); // rimuove eventuali effetti residui prima di riapplicarli

  const loser = chess.turn(); // il colore che deve muovere è quello sotto scacco matto
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
    void boardShellEl.offsetWidth; // forza il reflow, necessario per far ripartire l'animazione CSS
    boardShellEl.classList.add('checkmate-shake');
  }
}

if (boardShellEl) {
  boardShellEl.addEventListener('animationend', () => {
    boardShellEl.classList.remove('checkmate-shake'); // rimuove la classe a fine animazione, per poterla riattivare in seguito
  });
}

// ========== SEZIONE: Frecce di annotazione ==========
// Disegna, con tasto destro + trascinamento, frecce di annotazione sulla scacchiera (stile wintrchess/lichess), su un layer SVG sovrapposto.
// ========================================
const SVG_NS = 'http://www.w3.org/2000/svg';

function createArrowLayer() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('id', 'arrowLayer');
  svg.setAttribute('class', 'arrow-layer');
  boardShellEl.appendChild(svg);
  return svg;
}

// Centro in pixel di una casella, relativo a boardShellEl (lo stesso contenitore a cui è agganciato l'overlay delle frecce e l'overlay di scacco matto).
function squareCenterPx(square) {
  const el = document.querySelector(squareSelector(square));
  if (!el) return null; // casella non trovata nel DOM
  const shellRect = boardShellEl.getBoundingClientRect();
  const sqRect = el.getBoundingClientRect();
  return {
    x: sqRect.left - shellRect.left + sqRect.width / 2,
    y: sqRect.top - shellRect.top + sqRect.height / 2
  };
}

// Disegna l'intera freccia (stelo + punta) come UN UNICO poligono, invece di una linea (stelo) più un triangolo (punta) sovrapposti: con due forme distinte, l'estremità arrotondata dello stelo (stroke-linecap: round) sporgeva leggermente oltre i bordi retti della base del triangolo, creando uno stacco visibile nel punto di giunzione. Un'unica forma piena elimina del tutto la sovrapposizione.
function drawArrowShape(svg, p1, p2) {
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x); // angolo della freccia rispetto all'asse x
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y); // lunghezza totale della freccia
  if (dist < 4) return; // trascinamento troppo corto: non disegnare nulla

  const headLength = 32;
  const headWidth = 30;
  const shaftWidth = 14; // stesso spessore che prima era impostato via CSS (stroke-width)

  // Direzione perpendicolare alla freccia, usata per "allargare" stelo e punta ai due lati della linea centrale p1->p2.
  const perpX = Math.cos(angle + Math.PI / 2);
  const perpY = Math.sin(angle + Math.PI / 2);

  const shaftHalf = shaftWidth / 2;
  const headHalf = headWidth / 2;

  const tip = { x: p1.x + Math.cos(angle) * dist, y: p1.y + Math.sin(angle) * dist }; // punta della freccia
  const headBaseDist = Math.max(0, dist - headLength);
  const headBase = {
    x: p1.x + Math.cos(angle) * headBaseDist,
    y: p1.y + Math.sin(angle) * headBaseDist
  };

  // Contorno del poligono, in ordine: partenza (lato sx) -> base punta (lato sx, stretta come lo stelo) -> base punta allargata (lato sx) -> punta -> base punta allargata (lato dx) -> base punta (lato dx) -> partenza (lato dx)
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

// Ridisegna tutte le frecce salvate (chiamata dopo ogni modifica all'array "arrows" e ad ogni resize/ridimensionamento della scacchiera).
function renderArrows() {
  if (!arrowLayerEl) return; // layer SVG non ancora creato
  const rect = boardShellEl.getBoundingClientRect();
  arrowLayerEl.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`); // adatta il viewBox alle dimensioni correnti
  arrowLayerEl.innerHTML = ''; // svuota il layer prima di ridisegnare
  arrows.forEach((a) => {
    const p1 = squareCenterPx(a.from);
    const p2 = squareCenterPx(a.to);
    if (p1 && p2) drawArrowShape(arrowLayerEl, p1, p2);
  });
}

// Disegna, oltre alle frecce salvate, anche l'anteprima "live" durante il trascinamento
function updateTempArrow(clientX, clientY) {
  renderArrows(); // ridisegna prima le frecce già salvate
  const p1 = squareCenterPx(arrowDragStart);
  if (!p1) return;
  const shellRect = boardShellEl.getBoundingClientRect();
  const p2 = { x: clientX - shellRect.left, y: clientY - shellRect.top }; // punto corrente del mouse, relativo allo shell
  drawArrowShape(arrowLayerEl, p1, p2);
}

// Aggiunge la freccia from->to, oppure la rimuove se esiste già (toggle)
function toggleArrow(from, to) {
  const idx = arrows.findIndex((a) => a.from === from && a.to === to);
  if (idx !== -1) {
    arrows.splice(idx, 1); // la freccia esiste già: la rimuove
  } else {
    arrows.push({ from, to }); // freccia nuova: la aggiunge
  }
  renderArrows();
}

function clearArrows() {
  if (arrows.length === 0) return; // nessuna freccia da rimuovere
  arrows = [];
  renderArrows();
}

// ========== SEZIONE: Esecuzione mosse e click-to-move ==========
// Esegue una mossa a partire da casella di partenza/arrivo e gestisce l'interazione "clicca per muovere" (in alternativa al drag-and-drop).
// ========================================

// Esegue la mossa (usata dal click-to-move; il drag-and-drop usa invece direttamente chess.move dentro onDrop, dato che l'aggiornamento visivo della scacchiera è già gestito dall'animazione di chessboard.js).
function attemptMove(from, to) {
  const fenBefore = chess.fen();
  let moveObj;
  try {
    // La promozione viene sempre effettuata a Donna per semplicità
    moveObj = chess.move({ from, to, promotion: 'q' });
  } catch (err) {
    return false; // mossa illegale
  }
  const fenAfter = chess.fen();
  clearSelection();
  board.position(chess.fen());
  processMove(moveObj, fenBefore, fenAfter);
  return true;
}

// Gestisce il click su una casella: primo click seleziona un proprio pezzo (mostrando le mosse possibili), secondo click su una casella di destinazione valida esegue la mossa; click sulla stessa casella deseleziona; click su un altro proprio pezzo sposta la selezione. NOTA: la selezione vera e propria di un pezzo avviene già in onDragStart (vedi sotto), perché chessboard.js non genera un evento "click" affidabile sui pezzi. Questa funzione gestisce quindi soprattutto il click sulla casella di destinazione (vuota o con pezzo avversario catturabile) e il caso di click su una casella "non valida" per deselezionare.
function handleSquareClick(square) {
  if (boardLocked || chess.isGameOver()) return; // interazione non consentita

  if (selectedSquare) {
    if (square === selectedSquare) {
      // Gestito già da onDrop per il caso "click sullo stesso pezzo selezionato"; qui copriamo solo il caso di un click reale (non originato da un pezzo, quindi senza passare da onDragStart/onDrop) sulla stessa casella.
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
      selectSquare(square); // sposta la selezione su un altro proprio pezzo
    } else {
      clearSelection(); // click su casella non valida: deseleziona
    }
    return;
  }

  const color = pieceColorAt(square);
  if (color === chess.turn()) {
    selectSquare(square); // prima selezione di un proprio pezzo
  }
}

// ========== SEZIONE: Scacchiera (chessboard.js) e gestione delle mosse dell'utente ==========
// Callback richiesti da chessboard.js per il drag-and-drop dei pezzi (inizio trascinamento, rilascio, fine animazione di snap).
// ========================================
function onDragStart(source, piece) {
  if (boardLocked) return false; // interazione bloccata durante l'analisi
  if (chess.isGameOver()) return false; // partita già conclusa
  const isWhitePiece = piece.startsWith('w');
  if ((chess.turn() === 'w' && !isWhitePiece) || (chess.turn() === 'b' && isWhitePiece)) {
    return false; // non è il turno di questo colore
  }
  // chessboard.js intercetta il mousedown sui pezzi per gestire il proprio drag interno (ricrea/riposiziona gli elementi DOM del pezzo), perciò un semplice "click" su un pezzo NON genera un evento "click" affidabile: la selezione del pezzo per il click-to-move va quindi fatta qui, che è l'unico callback invocato in modo affidabile sia per il click sia per il trascinamento. Se il pezzo cliccato è già quello selezionato, un click senza movimento dovrà DESELEZIONARLO: lo ricordiamo prima di chiamare selectSquare(), che sovrascrive subito selectedSquare, così onDrop potrà distinguere questo caso da quello di una nuova selezione.
  wasAlreadySelected = (source === selectedSquare);
  selectSquare(source);
}

function onDrop(source, target) {
  if (source === target) {
    // Nessun trascinamento reale avvenuto: si tratta di un semplice click sul pezzo. Se era già selezionato lo deselezioniamo (toggle); altrimenti la selezione appena impostata da onDragStart resta visibile, in attesa del click sulla casella di destinazione (che verrà gestito da handleSquareClick, tramite l'evento "click" della casella di arrivo).
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
    return 'snapback'; // mossa illegale: il pezzo torna alla casella di partenza
  }
  const fenAfter = chess.fen();
  processMove(moveObj, fenBefore, fenAfter);
}

function onSnapEnd() {
  board.position(chess.fen()); // sincronizza la scacchiera con lo stato reale della partita
}

// ========== SEZIONE: Comandi di partita ==========
// Funzioni richiamate dai pulsanti dell'interfaccia: nuova partita, annulla mossa e capovolgimento della scacchiera.
// ========================================
function newGame() {
  chess.reset();
  clearCheckmateEffects();
  updateCapturedPieces();
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
  if (!undone) return; // nessuna mossa da annullare
  board.position(chess.fen());
  updateCapturedPieces();
  clearSelection();
  clearArrows();
  currentAnalysis = null; // la cache non è più valida: la posizione è cambiata
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

// Gira la scacchiera e, di conseguenza, anche la barra di valutazione: aggiunge/rimuove la classe "flipped" che ribalta visivamente la barra così il colore in basso sulla scacchiera resta il colore in basso nella barra, e ricalcola il testo del punteggio riferendolo al lato ora in basso.
function flipBoard() {
  board.flip();
  boardFlipped = !boardFlipped;
  evalBarWrapEl.classList.toggle('flipped', boardFlipped);
  capturedWrapEl.classList.toggle('flipped', boardFlipped);
  clearSelection();
  clearArrows();
  updateEvalBar(lastEvalScore, lastEvalSideToMove);
  requestAnimationFrame(() => board.resize());
}

// ========== SEZIONE: Inizializzazione ==========
// Crea l'istanza di chessboard.js, collega gli event listener (click-to-move, frecce di annotazione col tasto destro, pulsanti, resize) e avvia la prima analisi non appena il motore e il database delle aperture sono pronti.
// ========================================
board = Chessboard('board', {
  draggable: true,
  position: 'start',
  pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png',
  onDragStart,
  onDrop,
  onSnapEnd
});

// Click-to-move: delegato sul contenitore della scacchiera così da funzionare anche quando chessboard.js ridisegna le caselle/i pezzi al cambio posizione. Gestisce soprattutto i click sulle caselle di destinazione (che non hanno un proprio pezzo trascinabile e quindi generano un evento "click" normale).
$('#board').on('click', '.square-55d63', function () {
  const square = squareFromElement(this);
  if (square) handleSquareClick(square);
});

// --- Frecce di annotazione: tasto destro + trascinamento -------------------
arrowLayerEl = createArrowLayer();

const boardEl = document.getElementById('board');

// Blocca il menu contestuale nativo del browser sulla scacchiera.
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

// IMPORTANTE: chessboard.js avvia il proprio drag-and-drop dei pezzi da un listener "mousedown" registrato sui pezzi stessi, SENZA distinguere il tasto premuto (tratta ogni mousedown come un click sinistro). Per evitare che un mousedown col tasto destro venga intercettato anche da chessboard.js (che sposterebbe il pezzo), lo catturiamo in fase di "capture" — prima che l'evento raggiunga il listener di chessboard.js sul pezzo — e, se è il tasto destro, blocchiamo del tutto la propagazione: chessboard.js non vede mai l'evento e il pezzo non si muove.
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
  if (!arrowDragStart) return; // nessun trascinamento di freccia in corso
  updateTempArrow(e.clientX, e.clientY);
});

$(document).on('mouseup', (e) => {
  if (!arrowDragStart) return; // nessun trascinamento di freccia in corso
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