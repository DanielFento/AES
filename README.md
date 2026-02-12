# Arduino EasyScript (AES) Remade

A tiny English-like language that transpiles to Arduino C++ **without** external libraries.
This repo is intentionally minimal and hackable: open it, read it, extend it.

## Run locally (recommended)

Monaco uses web workers, so **run a local server** (don't double-click the HTML).

### Option A: Python
```bash
cd EngToArd_Rebuild
python -m http.server 8000
```

Then open:
- http://localhost:8000

### Option B: Node
```bash
npx serve .
```

## Project layout

- `index.html` — minimal UI shell
- `styles.css` — minimal styling
- `src/main.js` — editor wiring + compile + download/copy
- `src/monacoAes.js` — Monaco language features (autocomplete, hover, format, outline)
- `src/aes/service.js` — **the language + compiler** (parsing, diagnostics, transpiling)
- `src/examples.js` — examples shown in the dropdown
- `docs/Arduino_EasyScript_Docs.pdf` — documentation PDF

## How to add a new command

1) Open `src/aes/service.js`
2) Find `COMMANDS` (array of handlers)
3) Add a new handler function that:
- matches the line
- emits Arduino C++
- adds helpful diagnostics on bad input

4) Update autocomplete + hover:
- `src/monacoAes.js` (completion provider)
- `src/aes/service.js` (AES.docs)

## Language quick taste

```aes
pin led is 13

setup:
  make led output
end

loop:
  every 250 ms do:
    toggle led
  end
end
```

