// ========== SEZIONE: Service Worker — Chess Trainer ==========
// Scopo: soddisfare il requisito di installabilità di Chrome (PWA) e permettere all'app di aprirsi anche offline, mettendo in cache le risorse statiche dell'app (motore incluso, tutto locale, nessun server proprio).
// ========================================

const CACHE_NAME = 'chess-trainer-v1'; // nome/versione della cache: cambiarlo forza l'aggiornamento delle risorse

// ========== SEZIONE: Elenco delle risorse da precaricare in cache ==========
// Se in "engine/" ci sono altri file oltre a stockfish-18-lite-single.js e openings.json (es. .wasm separati), vanno aggiunti qui con lo stesso percorso relativo usato nel codice. 
// ========================================
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './img/chess-trainer-logo.png',
  './engine/stockfish-18-lite-single.js',
  './engine/openings.json',
  './manifest.json'
];

// ========== SEZIONE: Installazione del service worker ==========
// Apre (o crea) la cache e vi salva tutte le risorse elencate sopra, poi forza l'attivazione immediata senza attendere la chiusura delle vecchie schede aperte (skipWaiting).
// ========================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME) // apre/crea la cache con il nome corrente
      .then((cache) => cache.addAll(PRECACHE_URLS)) // scarica e salva tutte le risorse dell'app shell
      .then(() => self.skipWaiting()) // attiva subito questa versione del service worker
  );
});

// ========== SEZIONE: Attivazione del service worker ==========
// Elimina le cache create da versioni precedenti (diverse da CACHE_NAME) e prende il controllo immediato delle pagine già aperte (clients.claim).
// ========================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => // elenca tutte le cache esistenti
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME) // seleziona solo le cache "vecchie"
          .map((key) => caches.delete(key)) // e le elimina
      )
    ).then(() => self.clients.claim()) // diventa subito il service worker attivo per le pagine aperte
  );
});

// ========== SEZIONE: Gestione delle richieste (strategia "cache-first, poi rete") ==========
// Le risorse dell'app sono statiche e versionate tramite CACHE_NAME, quindi privilegiare la cache va bene e rende l'avvio più veloce; le richieste esterne (CDN di jQuery, chess.js, chessboard.js, font) passano invece semplicemente in rete come di consueto.
// ========================================
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // mette in cache solo le richieste GET

  event.respondWith(
    caches.match(event.request).then((cached) => { // cerca prima nella cache
      if (cached) return cached; // trovata: risponde subito senza andare in rete

      return fetch(event.request).then((response) => { // non in cache: va in rete
        // Mette in cache anche le risposte valide non previste inizialmente
        // (stesso-origine), così l'app resta utilizzabile offline anche dopo
        // aggiornamenti minori senza dover toccare PRECACHE_URLS ogni volta.
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const responseClone = response.clone(); // il corpo della risposta si può leggere una sola volta: se ne salva una copia
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone)); // salva la copia in cache per le prossime volte
        }
        return response; // restituisce comunque la risposta originale alla pagina
      }).catch(() => cached); // rete non disponibile: ripiega su "cached" (che qui è undefined se non trovata sopra)
    })
  );
});