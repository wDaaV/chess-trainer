# Chess Trainer

Sito statico per allenarsi a scacchi: scacchiera interattiva con commento
in tempo reale di Stockfish 18 (eseguito nel browser via WebAssembly) su
ogni mossa giocata.

Nessun backend, nessun account: tutta la logica gira lato client.

## Demo

https://wdaav.github.io/chess-trainer/

## Stack

- [chess.js](https://github.com/jhlywa/chess.js) — regole e stato della partita
- [chessboard.js](https://github.com/oakmac/chessboardjs) — interfaccia scacchiera
- [Stockfish 18 (stockfish.js)](https://github.com/nmrugg/stockfish.js) — motore di analisi, WASM